import { Readable } from 'node:stream'
import type { Dispatcher } from 'undici'

type Controller = Dispatcher.DispatchController
type Handler = Dispatcher.DispatchHandler

/** A stable controller from buffering through the last decoded response byte. */
export class RequestController implements Controller {
  target: Controller | undefined
  #aborted = false
  #paused = false
  #reason: Error | null = null
  #context: unknown = null
  onAbort: ((err: Error) => void) | undefined
  onResume: (() => void) | undefined

  get aborted(): boolean { return this.#aborted || this.target?.aborted === true }
  get paused(): boolean { return this.#paused }
  get reason(): Error | null { return this.#reason ?? this.target?.reason ?? null }
  get rawHeaders(): Controller['rawHeaders'] { return this.target?.rawHeaders }
  get rawTrailers(): Controller['rawTrailers'] { return this.target?.rawTrailers }
  /** The latest wire context, including an exact null or primitive value. */
  get context(): unknown { return this.#context }

  attach(target: Controller, context: unknown): void {
    this.target = target
    this.#context = context
    if (this.aborted) target.abort(this.reason as Error)
    else if (this.paused) target.pause()
  }

  abort(err: Error): void {
    if (this.aborted) return
    this.#aborted = true
    this.#reason = err
    try { this.target?.abort(err) } finally { this.onAbort?.(err) }
  }

  pause(): void {
    this.#paused = true
    this.target?.pause()
  }

  resume(): void {
    if (this.aborted) return
    this.#paused = false
    if (this.onResume) this.onResume()
    else this.target?.resume()
  }
}

function bytes(value: unknown): Buffer | undefined {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return undefined
}

/** Owns cancellation while the entire body is collected, before any wire dispatch. */
export class BufferedRequest {
  readonly controller = new RequestController()
  readonly handler: Handler
  #done = false
  #iterator: AsyncIterator<unknown> | Iterator<unknown> | undefined
  #body: unknown
  readonly #abort = new AbortController()
  readonly #onError: (err: Error) => void
  readonly #context: Record<PropertyKey, unknown> = {}

  constructor(handler: Handler, body: unknown) {
    this.#body = body
    this.#onError = (err) => handler.onResponseError?.(this.controller, err)
    this.controller.onAbort = (err) => {
      this.#abort.abort(err)
      this.#closeBody()
      this.fail(err)
    }
    this.handler = new Proxy(handler, {
      get: (target, key) => {
        if (key === 'onResponseError') return (_c: Controller, err: Error) => this.fail(err)
        if (key === 'onResponseEnd') return (c: Controller, trailers: unknown) => {
          if (this.#done) return
          this.#done = true
          target.onResponseEnd?.(c, trailers as never)
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? (...args: unknown[]) => {
          if (!this.#done) return (value as (...args: unknown[]) => unknown).apply(target, args)
        } : value
      },
    })
    try { handler.onRequestStart?.(this.controller, this.#context) } catch (err) { this.controller.abort(err instanceof Error ? err : new Error('request start failed')) }
  }

  /** Suppresses a second start and bridges all subsequent wire callbacks to the stable controller. */
  bridge(handler: Handler): Handler {
    return new Proxy(handler, {
      get: (target, key) => {
        if (key === 'onRequestStart') return (c: Controller, context: unknown) => {
          if (typeof context === 'object' && context !== null) {
            for (const key of Reflect.ownKeys(context)) {
              const descriptor = Object.getOwnPropertyDescriptor(context, key)
              if (descriptor) Object.defineProperty(this.#context, key, { ...descriptor, configurable: true })
            }
          }
          this.controller.attach(c, context)
        }
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (['onResponseStart', 'onResponseData', 'onResponseEnd', 'onResponseError', 'onRequestUpgrade'].includes(String(key))) {
          return (_c: Controller, ...args: unknown[]) => (value as (...args: unknown[]) => unknown).call(target, this.controller, ...args)
        }
        return (value as (...args: unknown[]) => unknown).bind(target)
      },
    })
  }

  fail(err: Error): void {
    if (this.#done) return
    this.#done = true
    try { this.#onError(err) } catch { /* A handler with no error callback has nobody left to tell. */ }
  }

  /** Remove each cancellation listener once its read settles, rather than retaining one per chunk. */
  #wait<T>(pending: Promise<T> | T): Promise<T> {
    const signal = this.#abort.signal
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(pending).then(
        (value) => { signal.removeEventListener('abort', abort); resolve(value) },
        (err: unknown) => { signal.removeEventListener('abort', abort); reject(err) },
      )
    })
  }

  async read(): Promise<Buffer> {
    if (this.controller.aborted) throw this.controller.reason
    const direct = bytes(this.#body)
    if (direct !== undefined) { this.#body = undefined; return direct }
    if (this.#body instanceof Blob) {
      const pending = this.#body.arrayBuffer()
      this.#body = undefined
      return Buffer.from(await this.#wait(pending))
    }
    const source = this.#body as AsyncIterable<unknown> & Iterable<unknown>
    this.#iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]?.()
    if (!this.#iterator) throw new TypeError('unsupported request body')
    const chunks: Buffer[] = []
    try {
      for (;;) {
        if (this.controller.aborted) throw this.controller.reason
        const part = await this.#wait(this.#iterator.next())
        if (part.done) break
        const chunk = bytes(part.value)
        if (chunk === undefined) throw new TypeError(`unsupported request body chunk: ${typeof part.value}`)
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    } catch (err) {
      this.#closeBody()
      throw err
    } finally {
      this.#iterator = undefined
      this.#body = undefined
    }
  }

  #closeBody(): void {
    if (this.#body instanceof Readable) {
      this.#body.on('error', () => {})
      this.#body.destroy()
    }
    const iterator = this.#iterator
    this.#iterator = undefined
    try { void Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* Producer cleanup must not delay cancellation. */ }
  }
}
