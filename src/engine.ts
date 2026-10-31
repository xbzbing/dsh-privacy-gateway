import type { ResolvedConfig } from './config.ts'
import { valuesOf, whatOf, RecordStore, type MaskRecord } from './records.ts'
import { ValueTable } from './redact/known.ts'
import { Masker, type MaskResult } from './redact/mask.ts'
import { newTally, Restorer, type StreamRestorer, type Tally } from './redact/restore.ts'

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

export interface EngineOptions {
  /** Where the records go; a memory-only one by default. */
  records?: RecordStore
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
  readonly #table: ValueTable
  readonly #masker: Masker
  readonly #restorer: Restorer
  readonly records: RecordStore
  /** `/privacy off` turns masking off until `/privacy on` or a restart; the config stays as it is. */
  active = true

  constructor(key: Uint8Array, config: ResolvedConfig, options: EngineOptions = {}) {
    this.#table = new ValueTable(config.maxValues)
    this.#masker = new Masker(key, this.#table, {
      secrets: config.secrets,
      personal: config.personal,
      protectEnvBlock: config.protectEnvBlock,
      protectTools: config.protectTools,
      words: config.words,
      allow: config.allow,
      cookies: { names: config.cookieNames, keep: config.cookieKeep },
    })
    this.#restorer = new Restorer(this.#table)
    this.records = options.records ?? new RecordStore({ keepDays: config.keepDays, keepBytes: config.keepMegabytes * 1024 * 1024, keepRecords: config.keepRecords })
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
    const base = { time, what: whatOf(info.path), host: info.host, ...(isLoopback(info.host) ? { relay: true as const } : {}), ...(info.session ? { session: info.session } : {}) }
    let r: MaskResult | null
    try {
      r = this.#masker.maskJSON(body, info.host)
    } catch (err) {
      const model = modelInPath(info.path)
      this.records.add({ ...base, ...(model ? { model } : {}), tookMs: elapsed(started), n: 0, values: [], restored: 0, unmapped: 0, failed: true })
      throw err
    }
    if (r === null) return null
    const tookMs = elapsed(started)
    const model = r.model ?? modelInPath(info.path)
    const record: Omit<MaskRecord, 'key'> = { ...base, ...(model ? { model } : {}), tookMs, n: r.n, values: valuesOf(r.hits), restored: 0, unmapped: 0 }
    const tally: Tally = newTally()
    let done = false
    return {
      text: r.text,
      restoring: () => this.#table.size > 0,
      restoreBody: (text) => this.#restorer.restoreJSON(text, tally),
      streamRestorer: () => this.#restorer.stream(tally),
      finish: () => {
        if (done) return
        done = true
        let restored = 0
        for (const n of tally.restored.values()) restored += n
        this.records.add({ ...record, restored, ...(tally.inTools > 0 ? { restoredInTools: tally.inTools } : {}), unmapped: tally.unmapped })
      },
    }
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100
}
