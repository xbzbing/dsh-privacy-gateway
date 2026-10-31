import { createReadStream } from 'node:fs'
import { appendFile, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { Finder } from './redact/ids.ts'
import type { Hit } from './redact/mask.ts'

/**
 * The record of what masking swapped for placeholders (design §7, magpie
 * internal/maskrec): one record a request, never the value itself. A day is
 * a JSONL file of its own; memory keeps the latest records and each day's
 * sums for the command and the settings card. Writing is best-effort: a
 * write that fails is told in the log and the request goes on (docs/adr/0008).
 */

/** One value a request had masked, as often as it had it. */
export interface ValueRecord {
  placeholder: string
  kind: string
  finder: Finder
  /** Its first character, a key's prefix (sk-) or a cookie's name. */
  head: string
  len: number
  /** The places the request had it. */
  n: number
}

/** chat, embeddings, count or search, by the request's path. */
export type What = 'chat' | 'embeddings' | 'count' | 'search'

export interface MaskRecord {
  /** Unique, later records larger. */
  key: number
  /** ISO time the request was masked. */
  time: string
  tookMs: number
  what: What
  /** host or host:port it went to. */
  host: string
  /** It went to a loopback relay. */
  relay?: true
  model?: string
  session?: string
  /** Values swapped, each place counted. */
  n: number
  values: ValueRecord[]
  /** Places the reply had a placeholder put back. */
  restored: number
  /** Placeholders in the reply no value is known for (design §13 R11). */
  unmapped: number
  /** Masking failed: the request was not sent (docs/adr/0005). */
  failed?: true
}

/** The values of a request's hits, one per placeholder, in the order first found. */
export function valuesOf(hits: readonly Hit[]): ValueRecord[] {
  const by = new Map<string, ValueRecord>()
  for (const h of hits) {
    const v = by.get(h.placeholder)
    if (v) v.n++
    else by.set(h.placeholder, { placeholder: h.placeholder, kind: h.kind, finder: h.by, head: h.head, len: h.len, n: 1 })
  }
  return [...by.values()]
}

/** What a request goes as, by its path. */
export function whatOf(path: string): What {
  const p = path.toLowerCase()
  if (p.includes('count_tokens') || p.includes(':counttokens')) return 'count'
  if (p.includes('embedding') || p.includes(':embedcontent') || p.includes(':batchembedcontents')) return 'embeddings'
  if (/\/search(?:[/?]|$)/.test(p)) return 'search'
  return 'chat'
}

/** Sums over some records. */
export interface Totals {
  requests: number
  /** Requests that had a value masked. */
  masked: number
  n: number
  restored: number
  unmapped: number
  failed: number
  tookMs: { sum: number; max: number }
  /** Places by kind, by finder, by host and by model. */
  kinds: Record<string, number>
  finders: Record<string, number>
  hosts: Record<string, number>
  models: Record<string, number>
}

export function emptyTotals(): Totals {
  return { requests: 0, masked: 0, n: 0, restored: 0, unmapped: 0, failed: 0, tookMs: { sum: 0, max: 0 }, kinds: {}, finders: {}, hosts: {}, models: {} }
}

function bump(m: Record<string, number>, k: string, by: number): void {
  if (by > 0) m[k] = (m[k] ?? 0) + by
}

export function addRecord(t: Totals, r: MaskRecord): void {
  t.requests++
  if (r.n > 0) t.masked++
  t.n += r.n
  t.restored += r.restored
  t.unmapped += r.unmapped
  if (r.failed) t.failed++
  t.tookMs.sum += r.tookMs
  t.tookMs.max = Math.max(t.tookMs.max, r.tookMs)
  for (const v of r.values) {
    bump(t.kinds, v.kind, v.n)
    bump(t.finders, v.finder, v.n)
  }
  bump(t.hosts, r.host, r.n)
  if (r.model) bump(t.models, r.model, r.n)
}

export function addTotals(into: Totals, t: Totals): void {
  into.requests += t.requests
  into.masked += t.masked
  into.n += t.n
  into.restored += t.restored
  into.unmapped += t.unmapped
  into.failed += t.failed
  into.tookMs.sum += t.tookMs.sum
  into.tookMs.max = Math.max(into.tookMs.max, t.tookMs.max)
  for (const k of ['kinds', 'finders', 'hosts', 'models'] as const) {
    for (const [name, n] of Object.entries(t[k])) bump(into[k], name, n)
  }
}

export interface Stats {
  today: Totals
  week: Totals
  month: Totals
  /** Requests in a row, the latest last, whose masking failed. */
  failStreak: number
}

/** A record read back from disk, checked for the fields the sums use. */
function parseRecord(line: string): MaskRecord | undefined {
  try {
    const r = JSON.parse(line) as MaskRecord
    if (typeof r !== 'object' || r === null || typeof r.time !== 'string' || typeof r.n !== 'number' || !Array.isArray(r.values)) return undefined
    r.restored = typeof r.restored === 'number' ? r.restored : 0
    r.unmapped = typeof r.unmapped === 'number' ? r.unmapped : 0
    r.tookMs = typeof r.tookMs === 'number' ? r.tookMs : 0
    r.host = typeof r.host === 'string' ? r.host : ''
    return r
  } catch {
    return undefined
  }
}

/** The local day of `d`, as its file is named. */
export function dayOf(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface StoreLogger {
  warn(...args: unknown[]): void
}

export interface RecordStoreOptions {
  /** Where the days are kept; none keeps the records in memory only (`record: false`). */
  dir?: string
  keepDays: number
  keepBytes: number
  /** Records memory keeps for the command and the card. */
  keepRecords: number
  logger?: StoreLogger
  /** The clock; for the tests. */
  now?: () => Date
  /** How long a record waits to be written with the ones after it. Default 200 ms. */
  flushDelayMs?: number
}

const PRUNE_EVERY_MS = 60 * 60 * 1000
/** The last record key handed out, shared by every store in the process so no two records have one key. */
let lastKey = 0
const WARN_EVERY_MS = 10 * 60 * 1000
/** The days the statistics go back. */
const STAT_DAYS = 30

export class RecordStore {
  readonly #o: RecordStoreOptions
  readonly #now: () => Date
  #ring: MaskRecord[] = []
  readonly #days = new Map<string, Totals>()
  #queue: Array<{ day: string; line: string }> = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #writing: Promise<void> = Promise.resolve()
  readonly #startKey: number
  #failStreak = 0
  #prunedAt = -Infinity
  #dirReady = false
  readonly #private = new Set<string>()
  #warnedAt = -Infinity
  /** Settles once the days on disk are in the sums and the latest records. */
  readonly loaded: Promise<void>

  constructor(options: RecordStoreOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
    // what is on disk now has smaller keys: one this store adds is in the sums already
    this.#startKey = this.#nextKey()
    this.loaded = options.dir ? this.#load(options.dir).catch((err: unknown) => this.#warn('could not read the records', err)) : Promise.resolve()
  }

  #nextKey(): number {
    lastKey = Math.max(this.#now().getTime() * 1000, lastKey + 1)
    return lastKey
  }

  #day(day: string): Totals {
    let t = this.#days.get(day)
    if (!t) this.#days.set(day, (t = emptyTotals()))
    return t
  }

  /** Keeps `r`, and has it written. */
  add(r: Omit<MaskRecord, 'key'>): MaskRecord {
    const rec = { key: this.#nextKey(), ...r } as MaskRecord
    const day = dayOf(new Date(rec.time))
    addRecord(this.#day(day), rec)
    this.#ring.push(rec)
    if (this.#ring.length > this.#o.keepRecords) this.#ring.splice(0, this.#ring.length - this.#o.keepRecords)
    this.#failStreak = rec.failed ? this.#failStreak + 1 : 0
    if (this.#o.dir) {
      this.#queue.push({ day, line: JSON.stringify(rec) })
      this.#schedule()
    }
    return rec
  }

  /** The latest records, newest first. */
  recent(limit = this.#o.keepRecords): MaskRecord[] {
    return this.#ring.slice(-limit).reverse()
  }

  stats(): Stats {
    const now = this.#now()
    const since = (days: number): string => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)))
    const today = dayOf(now)
    const week = since(7)
    const month = since(STAT_DAYS)
    const out: Stats = { today: emptyTotals(), week: emptyTotals(), month: emptyTotals(), failStreak: this.#failStreak }
    for (const [day, t] of this.#days) {
      if (day > today || day < month) continue
      addTotals(out.month, t)
      if (day >= week) addTotals(out.week, t)
      if (day === today) addTotals(out.today, t)
    }
    return out
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, this.#o.flushDelayMs ?? 200)
    this.#timer.unref?.()
  }

  /** Writes what is waiting; never rejects. */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const batch = this.#queue
    this.#queue = []
    if (batch.length > 0 && this.#o.dir) {
      const dir = this.#o.dir
      this.#writing = this.#writing.then(() => this.#write(dir, batch)).catch((err: unknown) => this.#warn('could not write the records', err))
    }
    return this.#writing
  }

  async #write(dir: string, batch: Array<{ day: string; line: string }>): Promise<void> {
    if (!this.#dirReady) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700).catch(() => {})
      this.#dirReady = true
    }
    const byDay = new Map<string, string[]>()
    for (const { day, line } of batch) {
      const lines = byDay.get(day)
      if (lines) lines.push(line)
      else byDay.set(day, [line])
    }
    for (const [day, lines] of byDay) {
      const file = join(dir, `${day}.jsonl`)
      await appendFile(file, lines.join('\n') + '\n', { mode: 0o600 })
      if (!this.#private.has(file)) {
        await chmod(file, 0o600).catch(() => {})
        this.#private.add(file)
      }
    }
    if (this.#now().getTime() - this.#prunedAt >= PRUNE_EVERY_MS) await this.prune()
  }

  /** Deletes the days older than keepDays, then the oldest while there is more than keepBytes; today's file stays. */
  async prune(): Promise<void> {
    const dir = this.#o.dir
    if (!dir) return
    this.#prunedAt = this.#now().getTime()
    const now = this.#now()
    const today = dayOf(now)
    const oldest = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (this.#o.keepDays - 1)))
    const days: Array<{ day: string; file: string; size: number }> = []
    for (const name of await readdir(dir)) {
      const m = DAY_FILE.exec(name)
      if (!m) continue
      const file = join(dir, name)
      if ((m[1] as string) < oldest) {
        await unlink(file)
        continue
      }
      days.push({ day: m[1] as string, file, size: (await stat(file)).size })
    }
    days.sort((a, b) => (a.day < b.day ? -1 : 1))
    let total = days.reduce((s, d) => s + d.size, 0)
    for (const d of days) {
      if (total <= this.#o.keepBytes || d.day === today) break
      await unlink(d.file)
      total -= d.size
    }
    const statFrom = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (STAT_DAYS - 1)))
    for (const day of this.#days.keys()) if (day < statFrom) this.#days.delete(day)
  }

  /** Writes what is waiting and stops; records added later are kept in memory only. */
  async close(): Promise<void> {
    await this.flush()
  }

  async #load(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const now = this.#now()
    const from = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Math.min(this.#o.keepDays, STAT_DAYS) - 1)))
    const days = names
      .map((n) => DAY_FILE.exec(n)?.[1])
      .filter((d): d is string => d !== undefined && d >= from)
      .sort()
      .reverse()
    let older: MaskRecord[] = []
    for (const day of days) {
      const t = emptyTotals()
      const need = this.#o.keepRecords - older.length
      const tail: MaskRecord[] = []
      const lines = createInterface({ input: createReadStream(join(dir, `${day}.jsonl`), { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of lines) {
        const r = parseRecord(line)
        // one added since this store began is in the sums already
        if (!r || r.key >= this.#startKey) continue
        addRecord(t, r)
        if (need > 0) {
          tail.push(r)
          if (tail.length > need) tail.shift()
        }
      }
      addTotals(this.#day(day), t)
      older = [...tail, ...older]
    }
    this.#ring = [...older, ...this.#ring].slice(-this.#o.keepRecords)
  }

  #warn(what: string, err: unknown): void {
    const at = this.#now().getTime()
    if (at - this.#warnedAt < WARN_EVERY_MS) return
    this.#warnedAt = at
    this.#o.logger?.warn(`dsh-privacy-gateway: ${what}; requests go on, unrecorded on disk`, err)
  }
}
