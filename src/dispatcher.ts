import { Dispatcher, Dispatcher1Wrapper, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { RequestBlocked, type Exchange, type RedactionEngine, type RequestInfo } from './engine.ts'
import { currentSession } from './providers.ts'

type Options = Dispatcher.DispatchOptions
type Handler = Dispatcher.DispatchHandler
type Controller = Dispatcher.DispatchController
type IncomingHeaders = Parameters<NonNullable<Handler['onResponseStart']>>[2]

/** The error a request fails with when masking throws: it is not sent (docs/adr/0005). */
export class PrivacyGatewayError extends Error {
  /** DSH_PRIVACY_GATEWAY_FAIL_CLOSED when masking failed, DSH_PRIVACY_GATEWAY_BLOCKED when a block action stopped the request. */
  readonly code: string
  constructor(message: string, options?: { cause?: unknown }, code = 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED') {
    super(`dsh-privacy-gateway: ${message}`, options)
    this.code = code
    this.name = 'PrivacyGatewayError'
  }
}

export interface GatewayLogger {
  warn(...args: unknown[]): void
}

/** `logger` with whatever its `warn` throws dropped. */
function quiet(logger: GatewayLogger): GatewayLogger {
  return {
    warn: (...args: unknown[]) => {
      try {
        logger.warn(...args)
      } catch {
        // a log line is never worth a request
      }
    },
  }
}

export interface MaskingDispatcherOptions {
  /** Lower-case `host` or `host:port` entries never rewritten. */
  excludeHosts?: readonly string[]
  /** True for a request that goes on as it is, whatever it holds: one a provider in excludeProviders sends (docs/adr/0018). */
  skip?: () => boolean
  logger?: GatewayLogger
}

const wrapHandler = (Dispatcher1Wrapper as unknown as { wrapHandler(h: unknown): Handler }).wrapHandler

/**
 * The class name of `err`, for a log line: an error's message and stack may
 * quote the request body it came from, so they are never logged or passed on
 * (docs/adr/0005). A name that is not a plain identifier is just "Error".
 */
export function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  return /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : 'Error'
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Marks a request the gateway passed on, with the layer it went to. Object
 * spread copies it, so a layer on top of the gateway that sends the request
 * back through it is recognised.
 */
const kHop = Symbol('dsh-privacy-gateway.hop')

// ---- headers -------------------------------------------------------------------

type HeaderInput = Options['headers']

/** Every header of `headers`, in any of the forms undici takes (a record, flat pairs, an array of pairs, an iterable), as [name, value] entries. */
function headerEntries(headers: HeaderInput): Array<[string, unknown]> {
  if (!headers) return []
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      return (headers as unknown as Array<[unknown, unknown]>).map(([k, v]) => [String(k), v])
    }
    const out: Array<[string, unknown]> = []
    for (let i = 0; i + 1 < headers.length; i += 2) out.push([String(headers[i]), headers[i + 1]])
    return out
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return [...(headers as Iterable<[unknown, unknown]>)].map(([k, v]) => [String(k), v])
  }
  return Object.entries(headers as Record<string, unknown>)
}

/** The value of header `name` in any of the forms undici takes, or undefined. */
export function headerValue(headers: HeaderInput, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const [k, v] of headerEntries(headers)) {
    if (k.toLowerCase() === want && v != null) return Array.isArray(v) ? v.join(', ') : String(v)
  }
  return undefined
}

/**
 * `headers` with each header named (in lower case) in `set` given its value
 * there, or taken out where that is null. A header in `set` the request lacks
 * is added only when `add` names it. Nothing to change gives `headers` back
 * as it was; a change gives flat [name, value, …] pairs, the one list form
 * every undici version reads the same way.
 */
export function editHeaders(headers: HeaderInput, set: Readonly<Record<string, string | null>>, add: readonly string[] = []): HeaderInput {
  const entries = headerEntries(headers)
  const has = (k: string): boolean => Object.hasOwn(set, k)
  const present = new Set(entries.map(([k]) => k.toLowerCase()).filter(has))
  const added = add.filter((k) => has(k) && set[k] != null && !present.has(k))
  if (present.size === 0 && added.length === 0) return headers
  const out: Array<string | string[]> = []
  const done = new Set<string>()
  for (const [k, v] of entries) {
    const low = k.toLowerCase()
    if (has(low)) {
      const value = set[low]
      if (value == null || done.has(low)) continue
      done.add(low)
      out.push(k, value)
    } else if (v != null) {
      out.push(k, Array.isArray(v) ? v.map(String) : String(v))
    }
  }
  for (const k of added) out.push(k, set[k] as string)
  return out as unknown as HeaderInput
}

/** `headers` with an existing `content-length` set to `length`; every other header as it was. */
export function withContentLength(headers: HeaderInput, length: number): HeaderInput {
  return editHeaders(headers, { 'content-length': String(length) })
}

function incomingValue(headers: IncomingHeaders, name: string): string {
  const v = (headers as Record<string, string | string[] | undefined> | undefined)?.[name]
  return Array.isArray(v) ? v.join(', ') : (v ?? '')
}

function withoutLength(headers: IncomingHeaders): IncomingHeaders {
  const out: Record<string, unknown> = { ...(headers as Record<string, unknown>) }
  delete out['content-length']
  return out as IncomingHeaders
}

/** `controller` with `content-length` taken out of its raw headers, which fetch reads in place of `headers`. */
function lengthless(controller: Controller): Controller {
  const raw = controller.rawHeaders
  if (!Array.isArray(raw)) return controller
  const kept: Array<Buffer | string> = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === 'content-length') continue
    kept.push(raw[i] as Buffer | string, raw[i + 1] as Buffer | string)
  }
  return new Proxy(controller, {
    get(target, key) {
      if (key === 'rawHeaders') return kept
      const v: unknown = Reflect.get(target, key)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

// ---- request body --------------------------------------------------------------

type Body = Options['body']

function isReadableBody(body: Body): boolean {
  if (body == null) return false
  if (typeof body === 'string' || body instanceof Uint8Array) return true
  return typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
}

async function readBody(body: Body): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf8'))
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    else throw new TypeError(`unsupported request body chunk: ${typeof chunk}`)
  }
  return Buffer.concat(chunks)
}

/** Delivers `err` to a handler whose request was never dispatched. */
function failRequest(handler: Handler, err: Error): void {
  const controller: Controller = {
    aborted: false,
    paused: false,
    reason: null,
    abort() {},
    pause() {},
    resume() {},
  }
  try {
    handler.onResponseError?.(controller, err)
  } catch {
    // a legacy handler with no onError rethrows: nobody is left to tell
  }
}

// ---- reply ---------------------------------------------------------------------

/**
 * Passes a model reply on with the placeholders in it put back: a
 * `text/event-stream` line by line as it arrives (backpressure is the
 * downstream handler's own, through the same controller), a JSON body whole
 * at its end. A compressed reply goes on as it is: the placeholders reach the
 * agent, the secrets never left.
 */
class RestoringHandler implements Handler {
  readonly #next: Handler
  readonly #exchange: Exchange
  readonly #logger: GatewayLogger | undefined
  #mode: 'pass' | 'stream' | 'whole' = 'pass'
  #stream: ReturnType<Exchange['streamRestorer']> | undefined
  #chunks: Buffer[] = []
  #view: Controller | undefined

  constructor(next: Handler, exchange: Exchange, logger: GatewayLogger | undefined) {
    this.#next = next
    this.#exchange = exchange
    this.#logger = logger
  }

  onRequestStart(controller: Controller, context: unknown): void {
    this.#next.onRequestStart?.(controller, context)
  }

  onRequestUpgrade(controller: Controller, statusCode: number, headers: IncomingHeaders, socket: Parameters<NonNullable<Handler['onRequestUpgrade']>>[3]): void {
    this.#next.onRequestUpgrade?.(controller, statusCode, headers, socket)
  }

  onResponseStarted(): void {
    this.#next.onResponseStarted?.()
  }

  onBodySent(chunk: Buffer): void {
    this.#next.onBodySent?.(chunk)
  }

  onRequestSent(): void {
    this.#next.onRequestSent?.()
  }

  onResponseStart(controller: Controller, statusCode: number, headers: IncomingHeaders, statusMessage?: string): void {
    const type = incomingValue(headers, 'content-type').toLowerCase()
    const encoding = incomingValue(headers, 'content-encoding').trim().toLowerCase()
    const kind = type.includes('event-stream') ? 'stream' : type.includes('json') ? 'whole' : 'pass'
    if (statusCode >= 200 && kind !== 'pass' && this.#exchange.restoring()) {
      if (encoding === '' || encoding === 'identity') {
        this.#mode = kind
        if (kind === 'stream') this.#stream = this.#exchange.streamRestorer()
      } else {
        this.#logger?.warn(`dsh-privacy-gateway: reply is ${encoding}-encoded, placeholders in it are not restored`)
      }
    }
    if (this.#mode === 'pass') {
      this.#view = controller
      this.#next.onResponseStart?.(controller, statusCode, headers, statusMessage)
      return
    }
    // the restored body has another length
    this.#view = lengthless(controller)
    this.#next.onResponseStart?.(this.#view, statusCode, withoutLength(headers), statusMessage)
  }

  onResponseData(controller: Controller, chunk: Buffer): void {
    const view = this.#view ?? controller
    if (this.#mode === 'pass') {
      this.#next.onResponseData?.(view, chunk)
      return
    }
    if (this.#mode === 'whole') {
      this.#chunks.push(chunk)
      return
    }
    const out = this.#stream?.push(chunk) ?? ''
    if (out !== '') this.#next.onResponseData?.(view, Buffer.from(out, 'utf8'))
  }

  onResponseEnd(controller: Controller, trailers: IncomingHeaders): void {
    const view = this.#view ?? controller
    if (this.#mode === 'stream') {
      const out = this.#stream?.end() ?? ''
      if (out !== '') this.#next.onResponseData?.(view, Buffer.from(out, 'utf8'))
    } else if (this.#mode === 'whole') {
      const raw = Buffer.concat(this.#chunks)
      this.#chunks = []
      let body: Buffer = raw
      try {
        body = Buffer.from(this.#exchange.restoreBody(utf8.decode(raw)), 'utf8')
      } catch (err) {
        // not UTF-8, or the restorer failed: on as it came, placeholders and all; the error may quote the body, so only its name is logged
        this.#logger?.warn(`dsh-privacy-gateway: a JSON reply could not be restored (${errorName(err)}); it goes on with its placeholders`)
      }
      if (body.length > 0) this.#next.onResponseData?.(view, body)
    }
    this.#exchange.finish()
    this.#next.onResponseEnd?.(view, trailers)
  }

  onResponseError(controller: Controller, err: Error): void {
    this.#chunks = []
    this.#exchange.finish()
    this.#next.onResponseError?.(this.#view ?? controller, err)
  }
}

// ---- dispatcher ----------------------------------------------------------------

function targetHost(opts: Options): { host: string; hostname: string } | undefined {
  try {
    const url = new URL(opts.path, opts.origin)
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() }
  } catch {
    return undefined
  }
}

/** Headers a session id may come in (oc2dsh sends x-opencode-session). */
const SESSION_HEADERS = ['x-opencode-session', 'x-session-id', 'session_id']

function requestInfo(opts: Options): RequestInfo {
  const t = targetHost(opts)
  let session: string | undefined
  for (const name of SESSION_HEADERS) {
    session = headerValue(opts.headers, name)
    if (session) break
  }
  // dsh's own calls carry no header (or an empty one): the `llm/stream` listener knows their session (docs/adr/0020)
  session ||= currentSession()
  let path = String(opts.path ?? '')
  try {
    path = new URL(path, 'http://x').pathname
  } catch {
    // as it came
  }
  return { host: t?.host ?? '', path, ...(session ? { session: session.slice(0, 128) } : {}) }
}

function isClosed(d: Dispatcher): boolean {
  const s = d as unknown as { closed?: boolean; destroyed?: boolean }
  return s.closed === true || s.destroyed === true
}

/**
 * Where a layer under the gateway goes (docs/adr/0012). `route` layers choose
 * where a request goes (oc2dsh's egress pool) and come first; `proxy` layers
 * make the connection (dsh-http-proxy's agent, the dispatcher the gateway was
 * installed on) and come last. Within a role the layer chained last comes
 * first.
 */
export type LayerRole = 'route' | 'proxy'

export interface ChainOptions {
  /** Default `route` for a layer new to the chain; a layer already in it keeps its role unless one is given. */
  role?: LayerRole
}

/** One layer under the gateway, as `downstreams()` lists it. */
export interface LayerInfo {
  readonly dispatcher: Dispatcher
  readonly role: LayerRole
  readonly closed: boolean
}

interface Layer {
  d: Dispatcher
  role: LayerRole
  seq: number
}

const RANK: Record<LayerRole, number> = { route: 0, proxy: 1 }

/**
 * The gateway: an undici dispatcher chained in front of whatever dispatcher
 * was global before it (docs/adr/0001). A POST whose body is a JSON model
 * request goes on masked, its reply restored; everything else goes on
 * untouched. Masking that throws fails the request instead of sending it
 * (docs/adr/0005). The layers under it are ordered by role (docs/adr/0012).
 */
export class MaskingDispatcher extends Dispatcher {
  readonly #engine: RedactionEngine
  readonly #excludeHosts: readonly string[]
  readonly #skip: (() => boolean) | undefined
  readonly #logger: GatewayLogger | undefined
  #layers: Layer[]
  #seq = 0
  #order: Layer[] | undefined
  /** Set once the gateway is disposed while another dispatcher sits on top of it: every request passes through. */
  bypass = false
  /** Run before each request: installGateway puts the gateway back on top if it was replaced. */
  heal: (() => void) | undefined

  constructor(downstream: Dispatcher, engine: RedactionEngine, options: MaskingDispatcherOptions = {}) {
    super()
    this.#layers = [{ d: downstream, role: 'proxy', seq: 0 }]
    this.#engine = engine
    this.#excludeHosts = options.excludeHosts ?? []
    this.#skip = options.skip
    // a logger that throws must not keep a failed request from failing
    this.#logger = options.logger && quiet(options.logger)
  }

  /**
   * Puts `d` under the gateway, by its role. Chaining a layer already there
   * again makes it the first of its role, with the role given if one is.
   */
  chainTo(d: Dispatcher, options: ChainOptions = {}): void {
    if (d === (this as Dispatcher)) return
    const had = this.#layers.find((l) => l.d === d)
    if (had) {
      had.seq = ++this.#seq
      if (options.role) had.role = options.role
    } else {
      this.#layers.push({ d, role: options.role ?? 'route', seq: ++this.#seq })
    }
    this.#order = undefined
  }

  /** Puts a dispatcher found on top of the gateway under it, as a `proxy` layer; one already there stays where it is. */
  adopt(d: Dispatcher): void {
    if (d === (this as Dispatcher) || this.#layers.some((l) => l.d === d)) return
    this.chainTo(d, { role: 'proxy' })
  }

  /** Takes `d` out from under the gateway; the last layer stays. True when it was there. */
  release(d: Dispatcher): boolean {
    const i = this.#layers.findIndex((l) => l.d === d)
    if (i < 0 || this.#layers.length === 1) return false
    this.#layers.splice(i, 1)
    this.#order = undefined
    return true
  }

  #ordered(): Layer[] {
    return (this.#order ??= [...this.#layers].sort((a, b) => RANK[a.role] - RANK[b.role] || b.seq - a.seq))
  }

  /** The first open layer after `after` in the order (from the top when absent), or undefined. */
  #next(after?: Dispatcher): Dispatcher | undefined {
    const order = this.#ordered()
    let i = after === undefined ? 0 : order.findIndex((l) => l.d === after) + 1
    // `after` not there (released while a request was on its way through it): from the top
    for (; i < order.length; i++) {
      const l = order[i] as Layer
      if (l.d !== after && !isClosed(l.d)) return l.d
    }
    return undefined
  }

  /** The dispatcher requests go on to: the first open layer, or the last one when all are closed. */
  downstream(): Dispatcher {
    return this.#next() ?? (this.#ordered().at(-1) as Layer).d
  }

  /** The layer a request goes on to after `d`, the next open one in the order; undefined after the last. */
  below(d: Dispatcher): Dispatcher | undefined {
    return this.#next(d)
  }

  /** The layers under the gateway, in the order requests try them. */
  downstreams(): readonly LayerInfo[] {
    return this.#ordered().map((l) => ({ dispatcher: l.d, role: l.role, closed: isClosed(l.d) }))
  }

  override dispatch(opts: Options, handler: Handler): boolean {
    const hop = (opts as Options & { [kHop]?: Dispatcher })[kHop]
    if (hop !== undefined) {
      // back through a layer that sits on top of the gateway (one composed
      // from it, or one that captured it as its own previous): the request
      // was handled on its way in, so it goes on to the layer after that one,
      // never round again
      const next = this.#next(hop)
      if (next === undefined) {
        failRequest(wrapHandler(handler), new PrivacyGatewayError('dispatcher loop: the last layer under the gateway routes back to it'))
        return true
      }
      return next.dispatch({ ...opts, [kHop]: next } as Options, handler)
    }
    if (!this.bypass) this.heal?.()
    const next = this.downstream()
    if (this.bypass || !this.#candidate(opts)) return next.dispatch({ ...opts, [kHop]: next } as Options, handler)
    void this.#intercept(opts, wrapHandler(handler))
    return true
  }

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    // the downstream dispatchers belong to whoever installed them
    if (callback) {
      queueMicrotask(callback)
      return
    }
    return Promise.resolve()
  }

  override destroy(): Promise<void>
  override destroy(err: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(a?: Error | null | (() => void), b?: () => void): Promise<void> | void {
    const callback = typeof a === 'function' ? a : b
    if (callback) {
      queueMicrotask(callback)
      return
    }
    return Promise.resolve()
  }

  #candidate(opts: Options): boolean {
    if (String(opts.method).toUpperCase() !== 'POST' || opts.upgrade || !isReadableBody(opts.body)) return false
    if (this.#skip?.() === true) return false
    const type = headerValue(opts.headers, 'content-type')
    if (type !== undefined && !type.toLowerCase().includes('json')) return false
    if (this.#excludeHosts.length > 0) {
      const t = targetHost(opts)
      if (t && (this.#excludeHosts.includes(t.host) || this.#excludeHosts.includes(t.hostname))) return false
    }
    return true
  }

  /**
   * Reads, masks and sends one candidate request. Whatever fails before the
   * request is handed on fails it instead (docs/adr/0005): nothing here may
   * reject, and nothing it reports quotes the body.
   */
  async #intercept(opts: Options, handler: Handler): Promise<void> {
    let exchange: Exchange | null = null
    let next: Options
    let to: Dispatcher
    try {
      let raw: Buffer
      try {
        raw = await readBody(opts.body)
      } catch (err) {
        // the caller's own body stream failed: its error goes back to it, and nothing is sent
        failRequest(handler, err instanceof Error ? err : new Error(String(err)))
        return
      }
      let text: string | undefined
      try {
        text = utf8.decode(raw)
      } catch {
        text = undefined // not UTF-8: no model request
      }
      if (text !== undefined) {
        try {
          exchange = this.#engine.maskRequest(text, requestInfo(opts))
        } catch (err) {
          if (err instanceof RequestBlocked) {
            // the message names each value by its kind, head and length only (docs/adr/0019)
            this.#logger?.warn(`dsh-privacy-gateway: ${err.message}`)
            failRequest(handler, new PrivacyGatewayError(err.message, undefined, 'DSH_PRIVACY_GATEWAY_BLOCKED'))
            return
          }
          throw err
        }
      }
      const body = exchange === null || exchange.text === text ? raw : Buffer.from(exchange.text, 'utf8')
      to = this.downstream()
      next = { ...opts, body, headers: withContentLength(opts.headers, body.length), [kHop]: to } as Options
    } catch (err) {
      exchange?.finish()
      this.#logger?.warn(`dsh-privacy-gateway: masking failed (${errorName(err)}), request not sent`)
      failRequest(handler, new PrivacyGatewayError('masking failed, request not sent'))
      return
    }
    const h = exchange === null ? handler : new RestoringHandler(handler, exchange, this.#logger)
    try {
      to.dispatch(next, h)
    } catch (err) {
      exchange?.finish()
      failRequest(handler, err instanceof Error ? err : new Error(String(err)))
    }
  }
}

// ---- install -------------------------------------------------------------------

/** Where undici 8 keeps the legacy (v1 handler API) global dispatcher, which Node's built-in fetch reads. */
const LEGACY_GLOBAL = Symbol.for('undici.globalDispatcher.1')

export interface GatewayInstallOptions extends MaskingDispatcherOptions {
  /** How often to check the gateway is still the global dispatcher; 0 turns the timer off. Default 1 s. */
  checkIntervalMs?: number
}

export interface InstalledGateway {
  readonly dispatcher: MaskingDispatcher
  /** Puts the gateway back on top if another dispatcher replaced it; true when it had to. */
  check(): boolean
  /** Takes the gateway out: the dispatcher below it is global again, or, with another one on top, it passes everything through. */
  dispose(): void
}

/**
 * Chains the gateway in front of the current global dispatcher (docs/adr/0001).
 * A dispatcher installed after it (dsh-http-proxy's, for one) is noticed by
 * `check` and put downstream, so the user's proxy policy still applies.
 */
export function installGateway(engine: RedactionEngine, options: GatewayInstallOptions = {}): InstalledGateway {
  const gateway = new MaskingDispatcher(getGlobalDispatcher(), engine, options)
  const slots = globalThis as unknown as Record<symbol, unknown>
  let legacy: unknown
  const put = (): void => {
    setGlobalDispatcher(gateway)
    legacy = slots[LEGACY_GLOBAL]
  }
  put()

  const check = (): boolean => {
    const current = getGlobalDispatcher()
    const legacyNow = slots[LEGACY_GLOBAL]
    if (current === gateway && legacyNow === legacy) return false
    if (current !== gateway) gateway.adopt(current)
    // set through an older undici: only the legacy slot moved
    else if (legacyNow instanceof Dispatcher || typeof (legacyNow as Dispatcher | undefined)?.dispatch === 'function') {
      gateway.adopt(legacyNow as Dispatcher)
    }
    put()
    options.logger?.warn('dsh-privacy-gateway: another dispatcher replaced the gateway; chained it downstream and reinstalled')
    return true
  }

  // a request through the gateway checks first; the timer covers a gateway replaced
  // by one that sends it nothing, whose requests go unmasked until it runs
  gateway.heal = () => {
    if (getGlobalDispatcher() !== gateway) check()
  }

  const interval = options.checkIntervalMs ?? 1_000
  const timer = interval > 0 ? setInterval(check, interval) : undefined
  timer?.unref()

  let disposed = false
  return {
    dispatcher: gateway,
    check,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      gateway.heal = undefined
      if (getGlobalDispatcher() === gateway) setGlobalDispatcher(gateway.downstream())
      else gateway.bypass = true
    },
  }
}
