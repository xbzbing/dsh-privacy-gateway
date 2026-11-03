import type { Transform } from 'node:stream'
import zlib from 'node:zlib'

import { Dispatcher, Dispatcher1Wrapper, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { RequestBlocked, type Exchange, type RedactionEngine, type RequestInfo } from './engine.ts'
import { currentSession, inModelCall } from './providers.ts'

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

/** Marks a gateway, from this copy of the plugin or another (a reload, a second install). */
const kGateway = Symbol.for('dsh-privacy-gateway.gateway')

interface GatewayLike extends Dispatcher {
  readonly [kGateway]: true
  bypass: boolean
  handback(): Dispatcher
}

function isGateway(d: unknown): d is GatewayLike {
  return typeof d === 'object' && d !== null && (d as Partial<GatewayLike>)[kGateway] === true && typeof (d as Partial<GatewayLike>).handback === 'function'
}

/**
 * `d`, or, where it is a disposed gateway, what that one handed back: a new
 * gateway goes on top of the dispatcher an old one was on, never on the old
 * one, so reloads do not stack gateways.
 */
function unwrapDisposed(d: Dispatcher): Dispatcher {
  const seen = new Set<Dispatcher>()
  while (isGateway(d) && d.bypass && !seen.has(d)) {
    seen.add(d)
    d = d.handback()
  }
  return d
}

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

/** `headers` without the headers in `names` (lower case). */
function withoutHeaders(headers: IncomingHeaders, names: readonly string[]): IncomingHeaders {
  const out: Record<string, unknown> = { ...(headers as Record<string, unknown>) }
  for (const n of names) delete out[n]
  return out as IncomingHeaders
}

/** `controller` with the headers in `names` (lower case) taken out of its raw headers, which fetch reads in place of `headers`. */
function withoutRaw(controller: Controller, names: readonly string[]): Controller {
  const raw = controller.rawHeaders
  if (!Array.isArray(raw)) return controller
  const kept: Array<Buffer | string> = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (names.includes(String(raw[i]).toLowerCase())) continue
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

// ---- content codings -----------------------------------------------------------

/** The content codings a body was encoded with, in the order they were applied; identity left out (docs/adr/0025). */
export function codingsOf(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity')
}

/** A coding the gateway cannot take off a body: the request it is on is not sent. */
class UnknownCoding extends Error {
  constructor(coding: string) {
    // a header value, not body text; cut and kept to token characters all the same
    super(`unsupported content-encoding ${coding.replace(/[^\w.+-]/g, '?').slice(0, 32)}`)
    this.name = 'UnknownCoding'
  }
}

type ZstdZlib = typeof zlib & { zstdDecompressSync?: (b: Buffer) => Buffer; createZstdDecompress?: () => Transform }

/** Takes one coding off `body`; throws when the coding is unknown or the body is not in it. */
function decodeOnce(body: Buffer, coding: string): Buffer {
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(body)
    case 'deflate':
      // "deflate" is meant to be zlib-wrapped; some clients send it raw
      try {
        return zlib.inflateSync(body)
      } catch {
        return zlib.inflateRawSync(body)
      }
    case 'br':
      return zlib.brotliDecompressSync(body)
    case 'zstd': {
      const z = zlib as ZstdZlib
      if (typeof z.zstdDecompressSync !== 'function') throw new UnknownCoding(coding)
      return z.zstdDecompressSync(body)
    }
    default:
      throw new UnknownCoding(coding)
  }
}

/** `body` with every coding in `codings` taken off, the last applied first. */
export function decodeBody(body: Buffer, codings: readonly string[]): Buffer {
  let out = body
  for (let i = codings.length - 1; i >= 0; i--) out = decodeOnce(out, codings[i] as string)
  return out
}

/** As fetch sets its own decoders up: whatever has arrived comes out, a stream cut short is no error at its end. */
const STREAM_FLUSH = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }

/** A streaming decoder for one coding, or undefined when there is none for it. */
function decoderFor(coding: string): Transform | undefined {
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(STREAM_FLUSH)
    case 'deflate':
      return zlib.createInflate(STREAM_FLUSH)
    case 'br':
      return zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
    case 'zstd': {
      const z = zlib as ZstdZlib
      return typeof z.createZstdDecompress === 'function' ? z.createZstdDecompress() : undefined
    }
    default:
      return undefined
  }
}

/**
 * Takes the codings off a reply as it streams. What comes out goes to
 * `onData`, in order; `onEnd` once all of it has, `onError` (once, and then
 * nothing else) when the reply is not in its codings.
 */
class ReplyDecoder {
  readonly #first: Transform
  readonly #all: Transform[]
  #settled = false

  private constructor(chain: Transform[], onData: (b: Buffer) => void, onEnd: () => void, onError: (err: Error) => void) {
    this.#all = chain
    this.#first = chain[0] as Transform
    for (let i = 0; i + 1 < chain.length; i++) (chain[i] as Transform).pipe(chain[i + 1] as Transform)
    const last = chain.at(-1) as Transform
    last.on('data', (b: Buffer) => {
      if (!this.#settled) onData(b)
    })
    last.on('end', () => {
      if (this.#settled) return
      this.#settled = true
      onEnd()
    })
    for (const t of chain) {
      t.on('error', (err: Error) => {
        if (this.#settled) return
        this.destroy()
        onError(err)
      })
    }
  }

  /** A decoder for `codings`, or undefined when one of them has no streaming decoder. */
  static for(codings: readonly string[], onData: (b: Buffer) => void, onEnd: () => void, onError: (err: Error) => void): ReplyDecoder | undefined {
    const chain: Transform[] = []
    for (let i = codings.length - 1; i >= 0; i--) {
      const d = decoderFor(codings[i] as string)
      if (d === undefined) return undefined
      chain.push(d)
    }
    return chain.length === 0 ? undefined : new ReplyDecoder(chain, onData, onEnd, onError)
  }

  write(chunk: Buffer): void {
    if (!this.#settled) this.#first.write(chunk)
  }

  end(): void {
    if (!this.#settled) this.#first.end()
  }

  destroy(): void {
    this.#settled = true
    for (const t of this.#all) t.destroy()
  }
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

/** The reply kinds that are restored: `whole` at its end, `stream` event by event, `lines` one JSON document per line. */
type ReplyMode = 'pass' | 'stream' | 'lines' | 'whole'

function replyMode(type: string): ReplyMode {
  if (type.includes('event-stream')) return 'stream'
  if (type.includes('ndjson') || type.includes('jsonl') || type.includes('json-seq')) return 'lines'
  return type.includes('json') ? 'whole' : 'pass'
}

/**
 * Passes a model reply on with the placeholders in it put back: a
 * `text/event-stream` line by line as it arrives, an `application/x-ndjson`
 * reply one line (one JSON document) at a time, a JSON body whole at its end.
 * Backpressure is the downstream handler's own, through the same controller.
 * The gateway asks for an unencoded reply (docs/adr/0025); one that comes
 * compressed all the same is decoded here and goes on unencoded. A coding
 * there is no decoder for goes on as it is, with a warning: the placeholders
 * reach the agent, the secrets never left.
 */
class RestoringHandler implements Handler {
  readonly #next: Handler
  readonly #exchange: Exchange
  readonly #logger: GatewayLogger | undefined
  #mode: ReplyMode = 'pass'
  #stream: ReturnType<Exchange['streamRestorer']> | undefined
  #lines: { decoder: InstanceType<typeof TextDecoder>; buf: string } | undefined
  #chunks: Buffer[] = []
  #view: Controller | undefined
  #decoder: ReplyDecoder | undefined
  #trailers: IncomingHeaders | undefined
  /** The reply ended or failed, as the downstream handler was told: nothing more goes to it. */
  #done = false

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
    const kind = replyMode(incomingValue(headers, 'content-type').toLowerCase())
    const codings = codingsOf(incomingValue(headers, 'content-encoding') || undefined)
    if (statusCode >= 200 && kind !== 'pass' && this.#exchange.restoring()) {
      if (codings.length > 0) {
        this.#decoder = ReplyDecoder.for(
          codings,
          (b) => this.#plain(b),
          () => this.#end(),
          () => this.#fail(new PrivacyGatewayError('the reply is not in the content-encoding it names')),
        )
        if (this.#decoder === undefined) this.#logger?.warn(`dsh-privacy-gateway: reply is ${codings.join(', ')}-encoded, placeholders in it are not restored`)
      }
      if (codings.length === 0 || this.#decoder !== undefined) {
        this.#mode = kind
        if (kind === 'stream') this.#stream = this.#exchange.streamRestorer()
        if (kind === 'lines') this.#lines = { decoder: new TextDecoder('utf-8'), buf: '' }
      }
    }
    if (this.#mode === 'pass') {
      this.#view = controller
      this.#next.onResponseStart?.(controller, statusCode, headers, statusMessage)
      return
    }
    // the restored body has another length, and goes on unencoded
    const drop = this.#decoder === undefined ? ['content-length'] : ['content-length', 'content-encoding']
    this.#view = withoutRaw(controller, drop)
    this.#next.onResponseStart?.(this.#view, statusCode, withoutHeaders(headers, drop), statusMessage)
  }

  onResponseData(controller: Controller, chunk: Buffer): void {
    if (this.#done) return
    if (this.#mode === 'pass') {
      this.#next.onResponseData?.(this.#view ?? controller, chunk)
      return
    }
    if (this.#decoder) this.#decoder.write(chunk)
    else this.#plain(chunk)
  }

  /** One piece of the reply as the vendor wrote it, before any coding. */
  #plain(chunk: Buffer): void {
    if (this.#done) return
    if (this.#mode === 'whole') {
      this.#chunks.push(chunk)
      return
    }
    const out = this.#mode === 'lines' ? this.#pushLines(chunk) : (this.#stream?.push(chunk) ?? '')
    this.#send(out)
  }

  #send(out: string): void {
    if (out !== '' && this.#view) this.#next.onResponseData?.(this.#view, Buffer.from(out, 'utf8'))
  }

  #pushLines(chunk: Buffer | undefined): string {
    const l = this.#lines
    if (!l) return ''
    l.buf += chunk === undefined ? l.decoder.decode() : l.decoder.decode(chunk, { stream: true })
    const cut = chunk === undefined ? l.buf.length : l.buf.lastIndexOf('\n') + 1
    if (cut === 0) return ''
    const ready = l.buf.slice(0, cut)
    l.buf = l.buf.slice(cut)
    return ready
      .split(/(?<=\n)/)
      .map((line) => this.#restoreLine(line))
      .join('')
  }

  #restoreLine(line: string): string {
    const m = /\r?\n$/.exec(line)
    const doc = m ? line.slice(0, m.index) : line
    if (doc.trim() === '') return line
    try {
      return this.#exchange.restoreBody(doc) + (m?.[0] ?? '')
    } catch (err) {
      this.#logger?.warn(`dsh-privacy-gateway: a reply line could not be restored (${errorName(err)}); it goes on with its placeholders`)
      return line
    }
  }

  onResponseEnd(controller: Controller, trailers: IncomingHeaders): void {
    if (this.#done) return
    this.#view ??= controller
    this.#trailers = trailers
    if (this.#decoder) this.#decoder.end()
    else this.#end()
  }

  #end(): void {
    if (this.#done) return
    const view = this.#view as Controller
    if (this.#mode === 'stream') {
      this.#send(this.#stream?.end() ?? '')
    } else if (this.#mode === 'lines') {
      this.#send(this.#pushLines(undefined))
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
    this.#done = true
    this.#exchange.finish()
    this.#next.onResponseEnd?.(view, this.#trailers ?? {})
  }

  /** The decoder failed: the reply is cut off upstream and fails downstream. */
  #fail(err: Error): void {
    if (this.#done) return
    this.#done = true
    this.#chunks = []
    this.#exchange.finish()
    try {
      this.#view?.abort(err)
    } catch {
      // the connection is gone already
    }
    this.#next.onResponseError?.(this.#view as Controller, err)
  }

  onResponseError(controller: Controller, err: Error): void {
    if (this.#done) return
    this.#done = true
    this.#decoder?.destroy()
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

/** An upgrade (a WebSocket's handshake, undici's `upgrade()`) or a CONNECT tunnel: after it, the bytes go past the dispatcher. */
function isTunnel(opts: Options): boolean {
  return Boolean(opts.upgrade) || String(opts.method).toUpperCase() === 'CONNECT'
}

function tunnelName(opts: Options): string {
  const u = typeof opts.upgrade === 'string' ? opts.upgrade : ''
  return /^[\w.+-]{1,32}$/.test(u) ? u : String(opts.method).toUpperCase() === 'CONNECT' ? 'CONNECT' : 'upgraded'
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
 * untouched. An upgrade a model call opens (the Codex WebSocket) is refused
 * (docs/adr/0025); one a plugin opens outside a call — dsh-im-infoflow's
 * inbound, say — is let through unmasked, with one warn per host
 * (docs/adr/0032). Masking that throws fails the request instead of sending
 * it (docs/adr/0005). The layers under it are ordered by role (docs/adr/0012).
 */
export class MaskingDispatcher extends Dispatcher {
  readonly #engine: RedactionEngine
  readonly #excludeHosts: readonly string[]
  readonly #skip: (() => boolean) | undefined
  readonly #logger: GatewayLogger | undefined
  #layers: Layer[]
  #seq = 0
  #order: Layer[] | undefined
  /** Hosts a tunnel was let through to: each warned about once, however often it reconnects. */
  readonly #warnedTunnels = new Set<string>()
  /** Set once the gateway is disposed: every request that still reaches it (through a layer that holds it) passes through. */
  bypass = false
  readonly [kGateway] = true
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

  /**
   * What the global dispatcher goes back to when the gateway is taken out:
   * the first open `proxy` layer, the one that would be global had the gateway
   * never been installed (the last dispatcher found on top of it, else the one
   * it was installed on). Never a `route` layer, which only works under the
   * gateway.
   */
  handback(): Dispatcher {
    const proxies = this.#ordered().filter((l) => l.role === 'proxy')
    return (proxies.find((l) => !isClosed(l.d)) ?? (proxies.at(-1) as Layer)).d
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
    // An explicit bypass comes first, then the call: a tunnel is refused only where masking would
    // apply and a model call opened it. This order is the rule, not an optimisation — /privacy off
    // or a session with masking off must let a model call's tunnel by too (docs/adr/0032).
    if (!this.bypass && isTunnel(opts) && !this.#passes(opts)) {
      const host = targetHost(opts)?.host ?? 'an unknown host'
      if (inModelCall()) {
        // a model call's WebSocket (or any upgraded or tunnelled connection) carries its messages past
        // the dispatcher, where they cannot be masked: it is not opened (docs/adr/0025); Codex falls back to SSE
        this.#logger?.warn(`dsh-privacy-gateway: a ${tunnelName(opts)} connection to ${host} was refused: its messages cannot be masked`)
        failRequest(wrapHandler(handler), new PrivacyGatewayError('a WebSocket or other upgraded connection cannot be masked, it was not opened', undefined, 'DSH_PRIVACY_GATEWAY_UPGRADE_REFUSED'))
        return true
      }
      // an upgrade outside any model call is some plugin's own connection (dsh-im-infoflow's
      // inbound, for one): no model request is in it, so it was let through, unmasked (docs/adr/0032).
      // An inbound that reconnects would say so every second; one warn per host is enough.
      if (!this.#warnedTunnels.has(host)) {
        if (this.#warnedTunnels.size >= 32) this.#warnedTunnels.clear()
        this.#warnedTunnels.add(host)
        this.#logger?.warn(`dsh-privacy-gateway: a ${tunnelName(opts)} connection to ${host} was let through: its messages are not masked, and neither are those of further connections to it`)
      }
    }
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

  /** Whether `opts` goes on as it is whatever it holds: skip says so (enabled off, an excluded provider, a session with masking off), or its host is in excludeHosts. */
  #passes(opts: Options): boolean {
    if (this.#skip?.() === true) return true
    if (this.#excludeHosts.length === 0) return false
    const t = targetHost(opts)
    return t !== undefined && (this.#excludeHosts.includes(t.host) || this.#excludeHosts.includes(t.hostname))
  }

  #candidate(opts: Options): boolean {
    if (String(opts.method).toUpperCase() !== 'POST' || isTunnel(opts) || !isReadableBody(opts.body)) return false
    const type = headerValue(opts.headers, 'content-type')
    if (type !== undefined && !type.toLowerCase().includes('json')) return false
    return !this.#passes(opts)
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
      // a compressed body (Codex sends zstd) is masked as the text it holds and goes on as that text (docs/adr/0025)
      const codings = codingsOf(headerValue(opts.headers, 'content-encoding'))
      let plain = raw
      if (codings.length > 0) {
        try {
          plain = decodeBody(raw, codings)
        } catch (err) {
          const what = err instanceof UnknownCoding ? err.message : `a body that is not ${codings.join(', ')}-encoded as it says`
          this.#logger?.warn(`dsh-privacy-gateway: ${what}, request not sent`)
          failRequest(handler, new PrivacyGatewayError(`${what}, request not sent`))
          return
        }
      }
      let text: string | undefined
      try {
        text = utf8.decode(plain)
      } catch {
        text = undefined
      }
      if (text === undefined && headerValue(opts.headers, 'content-type') !== undefined) {
        // a candidate's content type is JSON, and JSON is UTF-8 (RFC 8259): one that is not cannot
        // be read, so it is not sent unread; with no content type it is no model request
        this.#logger?.warn('dsh-privacy-gateway: a JSON request body is not UTF-8, request not sent')
        failRequest(handler, new PrivacyGatewayError('the JSON request body is not UTF-8, request not sent'))
        return
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
      // nothing changed: the body goes as it came, coding and all
      const changed = exchange !== null && exchange.text !== text
      const body = changed ? Buffer.from((exchange as Exchange).text, 'utf8') : raw
      const set: Record<string, string | null> = { 'content-length': String(body.length) }
      if (changed && codings.length > 0) set['content-encoding'] = null
      // a reply with placeholders in it is restored as it comes: it is asked for unencoded
      if (exchange !== null) set['accept-encoding'] = 'identity'
      const headers = editHeaders(opts.headers, set, ['accept-encoding'])
      to = this.downstream()
      next = { ...opts, body, headers, [kHop]: to } as Options
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
  /** Takes the gateway out: it passes everything through from then on, and, where it is global, its `handback()` is global again. */
  dispose(): void
}

/**
 * Chains the gateway in front of the current global dispatcher (docs/adr/0001).
 * A dispatcher installed after it (dsh-http-proxy's, for one) is noticed by
 * `check` and put downstream, so the user's proxy policy still applies.
 */
export function installGateway(engine: RedactionEngine, options: GatewayInstallOptions = {}): InstalledGateway {
  const gateway = new MaskingDispatcher(unwrapDisposed(getGlobalDispatcher()), engine, options)
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
    if (current !== gateway) gateway.adopt(unwrapDisposed(current))
    // set through an older undici: only the legacy slot moved
    else if (legacyNow instanceof Dispatcher || typeof (legacyNow as Dispatcher | undefined)?.dispatch === 'function') {
      gateway.adopt(unwrapDisposed(legacyNow as Dispatcher))
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
      // a layer may still hold the gateway as its own previous dispatcher: whatever reaches it passes through
      gateway.bypass = true
      if (getGlobalDispatcher() === gateway) setGlobalDispatcher(gateway.handback())
    },
  }
}
