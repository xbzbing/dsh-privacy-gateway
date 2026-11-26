import type { Transform } from 'node:stream'
import zlib from 'node:zlib'

const FLUSH = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }

function decoderFor(coding: string): Transform | undefined {
  switch (coding) {
    case 'gzip':
    case 'x-gzip': return zlib.createGunzip(FLUSH)
    case 'deflate': return zlib.createInflate(FLUSH)
    case 'br': return zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
    case 'zstd': return (zlib as typeof zlib & { createZstdDecompress?: () => Transform }).createZstdDecompress?.()
    default: return undefined
  }
}

/** Pulls decoded bytes only while the consumer is ready, including after HTTP input ends. */
export class ReplyDecoder {
  readonly #all: Transform[]
  readonly #first: Transform
  readonly #last: Transform
  readonly #paused: () => boolean
  readonly #onData: (b: Buffer) => void
  readonly #onEnd: () => void
  readonly #onError: (err: Error) => void
  readonly #onDrain: () => void
  #settled = false
  #draining = false
  #backpressured = false
  #inputEnded = false

  private constructor(chain: Transform[], onData: (b: Buffer) => void, onEnd: () => void, onError: (err: Error) => void, paused: () => boolean, onDrain: () => void) {
    this.#all = chain
    this.#first = chain[0] as Transform
    this.#last = chain.at(-1) as Transform
    this.#paused = paused
    this.#onData = onData
    this.#onEnd = onEnd
    this.#onError = onError
    this.#onDrain = onDrain
    for (let i = 0; i + 1 < chain.length; i++) (chain[i] as Transform).pipe(chain[i + 1] as Transform)
    this.#last.on('readable', () => this.resume())
    this.#last.on('end', () => {
      if (this.#settled) return
      this.#settled = true
      this.#onEnd()
    })
    this.#first.on('drain', () => {
      if (this.#settled) return
      this.#backpressured = false
      this.#onDrain()
    })
    for (const stream of chain) stream.on('error', (err: Error) => this.#fail(err))
  }

  static for(codings: readonly string[], onData: (b: Buffer) => void, onEnd: () => void, onError: (err: Error) => void, paused: () => boolean, onDrain: () => void): ReplyDecoder | undefined {
    const chain: Transform[] = []
    for (let i = codings.length - 1; i >= 0; i--) {
      const stream = decoderFor(codings[i] as string)
      if (!stream) { for (const made of chain) made.destroy(); return undefined }
      chain.push(stream)
    }
    return chain.length === 0 ? undefined : new ReplyDecoder(chain, onData, onEnd, onError, paused, onDrain)
  }

  get backpressured(): boolean { return this.#backpressured }

  write(chunk: Buffer): boolean {
    if (this.#settled) return false
    this.#backpressured = !this.#first.write(chunk)
    return !this.#backpressured
  }

  end(): void {
    this.#inputEnded = true
    if (!this.#settled) this.#first.end()
  }

  resume(): void {
    if (this.#settled || this.#draining || this.#paused()) return
    this.#draining = true
    try {
      let chunk: Buffer | null
      while (!this.#settled && !this.#paused() && (chunk = this.#last.read() as Buffer | null) !== null) this.#onData(chunk)
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error('decoded response callback failed'))
    } finally { this.#draining = false }
    if (!this.#paused() && !this.#backpressured && !this.#inputEnded && !this.#settled) this.#onDrain()
  }

  #fail(err: Error): void {
    if (this.#settled) return
    this.destroy()
    this.#onError(err)
  }

  destroy(): void {
    this.#settled = true
    for (const stream of this.#all) stream.destroy()
  }
}
