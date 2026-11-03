import type { ResolvedConfig } from './config.ts'
import { valuesOf, whatOf, RecordStore, type MaskRecord } from './records.ts'
import { ValueTable } from './redact/known.ts'
import { Masker, type Hit, type MaskResult } from './redact/mask.ts'
import { jsonEscape } from './redact/json.ts'
import { newTally, Restorer, type StreamRestorer, type Tally } from './redact/restore.ts'
import { FirstSending } from './first.ts'
import { hideWarned, type ViewStore } from './views.ts'

/** Where a request goes, as the record keeps it. */
export interface RequestInfo {
  /** host or host:port. */
  host: string
  /** Path and query. */
  path: string
  session?: string
}

/** One masked request on its way: its body, and how to put its reply back. */
export interface Exchange {
  /** The body as it goes. */
  readonly text: string
  /** Whether the reply can hold a placeholder to put back. */
  restoring(): boolean
  /** Restores a whole JSON (or text) reply body. */
  restoreBody(text: string): string
  /** A restorer for one `text/event-stream` reply. */
  streamRestorer(): StreamRestorer
  /** The reply ended, or failed: the request's record is kept. Once only. */
  finish(): void
}

/** What the dispatcher needs from the redaction engine. */
export interface RedactionEngine {
  /** The request as it goes, or null when it goes as it is (not a model request, or masking is off). Throws when masking fails. */
  maskRequest(body: string, info: RequestInfo): Exchange | null
}

/**
 * A block action stopped the request (design §6): it is not sent. The message
 * names each value by its kind, its head and its length, never the value.
 */
export class RequestBlocked extends Error {
  readonly hits: readonly Hit[]
  constructor(hits: readonly Hit[]) {
    const seen = new Set<string>()
    const what: string[] = []
    for (const h of hits) {
      if (seen.has(h.placeholder)) continue
      seen.add(h.placeholder)
      what.push(`${h.kind} (${h.head}…, ${h.len} characters)`)
    }
    super(`request blocked: it has ${what.join(', ')}; remove the value or change the kind's action`)
    this.name = 'RequestBlocked'
    this.hits = hits
  }
}

export interface EngineLogger {
  warn(...args: unknown[]): void
}

export interface EngineOptions {
  /** Where the records go; a memory-only one by default. */
  records?: RecordStore
  logger?: EngineLogger
  /** Where the bodies as they went are kept for the vendor view (config vendorView); none keeps none. */
  views?: ViewStore
  /** The names a record keeps beside the session id: its title and its workspace (docs/adr/0020). */
  names?: (session: string) => { title?: string; workspace?: string }
  /** The turn and step that session was at when the request went (docs/adr/0030). */
  steps?: (session: string) => { turn: number; step: number } | undefined
}

function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || name.startsWith('127.')
}

/** The model a request names in its path (Gemini: …/models/<name>:generateContent). */
function modelInPath(path: string): string | undefined {
  const m = /\/models\/([^/:?]+)/.exec(path)
  return m ? decodeURIComponent(m[1] as string) : undefined
}

export class PrivacyEngine implements RedactionEngine {
  readonly #key: Uint8Array
  readonly #table: ValueTable
  #masker: Masker
  #restorer: Restorer
  /** Keep the bodies for the vendor view (config vendorView); `reconfigure` changes it. */
  #keepViews: boolean
  readonly records: RecordStore
  readonly #logger: EngineLogger | undefined
  readonly views: ViewStore | undefined
  readonly #names: ((session: string) => { title?: string; workspace?: string }) | undefined
  readonly #steps: ((session: string) => { turn: number; step: number } | undefined) | undefined
  /** Where each value was first sent, for the record's line about it (docs/adr/0030). */
  readonly #first = new FirstSending()
  /** `/privacy off` turns masking off until `/privacy on` or a restart; the config stays as it is. */
  active = true

  constructor(key: Uint8Array, config: ResolvedConfig, options: EngineOptions = {}) {
    this.#key = key
    this.#table = new ValueTable(config.maxValues)
    this.#masker = this.#maskerFor(config)
    this.#restorer = new Restorer(this.#table, config.toolGuard)
    this.#keepViews = config.vendorView
    this.#logger = options.logger
    this.#names = options.names
    this.#steps = options.steps
    this.views = options.views
    this.records = options.records ?? new RecordStore({ keepDays: config.keepDays, keepBytes: config.keepMegabytes * 1024 * 1024, keepRecords: config.keepRecords })
  }

  #maskerFor(config: ResolvedConfig): Masker {
    return new Masker(this.#key, this.#table, {
      secrets: config.secrets,
      personal: config.personal,
      protectEnvBlock: config.protectEnvBlock,
      protectTools: config.protectTools,
      words: config.words,
      allow: config.allow,
      cookies: { names: config.cookieNames, keep: config.cookieKeep },
      actions: notMasked(config.actions),
      shape: config.shape,
      maskKeys: config.maskKeys,
      context: config.recordContext,
    })
  }

  /**
   * The rules from `config` from the next request on (docs/adr/0021): the
   * finders and the reply guard are rebuilt, the value table stays, so a reply
   * to a request already sent is still restored. The masker starts with an
   * empty memo of what was sent, which was keyed to the old rules.
   */
  reconfigure(config: ResolvedConfig): void {
    this.#masker = this.#maskerFor(config)
    this.#restorer = new Restorer(this.#table, config.toolGuard)
    this.#keepViews = config.vendorView
    // off drops the bodies kept: they are not to stay in memory once it is turned off
    if (!config.vendorView) this.views?.clear()
  }

  /** How many values the table holds. */
  get values(): number {
    return this.#table.size
  }

  /** What `text` would go as, with nothing remembered (`/privacy test`). */
  preview(text: string): MaskResult {
    return this.#masker.preview(text)
  }

  maskRequest(body: string, info: RequestInfo): Exchange | null {
    if (!this.active) return null
    const started = performance.now()
    const time = new Date().toISOString()
    // where the session was when the request went: read once, so the record and the values it carries agree
    const step = info.session ? this.#steps?.(info.session) : undefined
    // read where a record is written: the names are looked up only then, and only for a session there is
    const base = () => ({
      time,
      what: whatOf(info.path),
      host: info.host,
      ...(isLoopback(info.host) ? { relay: true as const } : {}),
      ...(info.session ? { session: info.session, ...this.#names?.(info.session), ...step } : {}),
    })
    let r: MaskResult | null
    try {
      r = this.#masker.maskJSON(body, info.host)
    } catch (err) {
      const model = modelInPath(info.path)
      this.records.add({ ...base(), ...(model ? { model } : {}), tookMs: elapsed(started), n: 0, values: [], restored: 0, unmapped: 0, failed: true })
      throw err
    }
    if (r === null) return null
    const tookMs = elapsed(started)
    const model = r.model ?? modelInPath(info.path)
    let warned = 0
    const blocks: Hit[] = []
    for (const h of r.hits) {
      if (h.action === 'warn') warned++
      else if (h.action === 'block') blocks.push(h)
    }
    const values = valuesOf(r.hits)
    // each value says which request sent it the first time, one step behind what produced it (docs/adr/0030)
    if (info.session !== undefined && step !== undefined) {
      for (const v of values) {
        const first = this.#first.note(info.session, v.placeholder, step)
        // only when it went out before: a value this request sends first needs no line of its own
        if (first.turn !== step.turn || first.step !== step.step) v.first = first
      }
    }
    const record: Omit<MaskRecord, 'key'> = { ...base(), ...(model ? { model } : {}), tookMs, n: r.n, ...(warned > 0 ? { warned } : {}), values, restored: 0, unmapped: 0 }
    if (blocks.length > 0) {
      this.records.add({ ...record, blocked: true })
      throw new RequestBlocked(blocks)
    }
    const tally: Tally = newTally()
    // the reply goes through the guard this request was sent under, whatever reconfigure does meanwhile
    const restorer = this.#restorer
    const sentText = r.text
    let done = false
    return {
      text: r.text,
      restoring: () => this.#table.size > 0,
      restoreBody: (text) => restorer.restoreJSON(text, tally),
      streamRestorer: () => restorer.stream(tally),
      finish: () => {
        if (done) return
        done = true
        let restored = 0
        for (const n of tally.restored.values()) restored += n
        // a request with nothing masked and nothing put back is not recorded (docs/adr/0008)
        if (record.n === 0 && warned === 0 && restored === 0 && tally.unmapped === 0 && tally.exfil === 0) return
        const hosts = [...tally.exfilHosts]
        if (tally.exfil > 0) {
          const left = tally.exfilBlocked > 0 ? `; ${tally.exfilBlocked} placeholders were left in them` : ''
          this.#logger?.warn(`dsh-privacy-gateway: ${tally.exfil} tool calls had a value put back in arguments that name ${hosts.join(', ')}${left}`)
        }
        const rec = this.records.add({
          ...record,
          restored,
          ...(tally.inTools > 0 ? { restoredInTools: tally.inTools } : {}),
          unmapped: tally.unmapped,
          ...(tally.exfil > 0 ? { exfil: tally.exfil, exfilHosts: hosts } : {}),
          ...(tally.exfilBlocked > 0 ? { exfilBlocked: tally.exfilBlocked } : {}),
        })
        if (this.views && this.#keepViews) this.views.put(rec.key, hideWarned(sentText, warnedForms(r.warned)))
      },
    }
  }
}

/** Each warned value in the forms a body may have it in: as it is, escaped once (a JSON string) and twice (a tool call's arguments). */
function warnedForms(warned: MaskResult['warned']): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [w, p] of warned ?? []) {
    const once = jsonEscape(w)
    out.push([w, p])
    if (once !== w) out.push([once, p], [jsonEscape(once), p])
  }
  return out
}

/** The actions that leave a value unmasked. */
function notMasked(actions: ResolvedConfig['actions']): Record<string, 'warn' | 'block'> {
  const out: Record<string, 'warn' | 'block'> = {}
  for (const [kind, a] of Object.entries(actions)) if (a === 'warn' || a === 'block') out[kind] = a
  return out
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100
}
