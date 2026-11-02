import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readdir, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { Finder } from './redact/ids.ts'
import type { Hit, Place } from './redact/mask.ts'

export type { Place }

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
  /** Its first characters: a key's prefix (sk-) and a few after it, or a cookie's name (docs/adr/0019). */
  head: string
  /** Its last characters, where it is long enough to spare them. */
  tail?: string
  len: number
  /** How many times the request had it: the same place met twice counts twice (docs/adr/0028). */
  n: number
  /** Not masked, by the kind's action: sent as written (warn) or the request stopped (block). */
  action?: 'warn' | 'block'
  /** The text around its first place as it went, every value there a placeholder (docs/adr/0024). */
  before?: string
  after?: string
  /** Where in the request body that first place was. */
  at?: Place
  /** Where else the request had it, past that first place, in the order met; `at` and these are at most MAX_RECORD_PLACES places (docs/adr/0028). */
  elsewhere?: Place[]
  /** Distinct places past MAX_RECORD_PLACES, left out of `elsewhere`, the count of them. */
  elsewhereOmitted?: number
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
  /** The session the call belonged to (its id), when it is known. */
  session?: string
  /** That session's title as it was when the request went. */
  title?: string
  /** The workspace that session belongs to, by name. */
  workspace?: string
  /** The turn the session was in, as its last `step/start` said (docs/adr/0030). */
  turn?: number
  /** The step of that turn; the two are always there together. */
  step?: number
  /** Values swapped, each place counted. */
  n: number
  /** Places sent as written by a warn action. */
  warned?: number
  /** A block action stopped the request: it was not sent. */
  blocked?: true
  values: ValueRecord[]
  /** Values past MAX_RECORD_VALUES the request also had, left out of `values` (docs/adr/0008). */
  valuesOmitted?: number
  /** Places the reply had a placeholder put back. */
  restored: number
  /** Of those, the places inside a tool call's arguments (design §13 R15, docs/adr/0009). */
  restoredInTools?: number
  /** Placeholders in the reply no value is known for (design §13 R11). */
  unmapped: number
  /** Tool calls whose arguments had a value put back and named a host off this machine (docs/adr/0014). */
  exfil?: number
  /** Places in them left as placeholders (toolGuard block). */
  exfilBlocked?: number
  /** The hosts they named. */
  exfilHosts?: string[]
  /** Masking failed: the request was not sent (docs/adr/0005). */
  failed?: true
}

/**
 * The most values one record keeps. Each turn sends the whole history again,
 * and every value carries up to two context snippets, so an unbounded list
 * would let one long conversation fill the day's file (docs/adr/0008).
 */
export const MAX_RECORD_VALUES = 200

/**
 * The most places one value's record keeps, `at` counted. Each turn sends the
 * whole history again, so a value a long conversation keeps echoing sits in
 * one message after another; the record keeps each place once, up to this
 * many, so one long session cannot swell every record after it
 * (docs/adr/0028).
 */
export const MAX_RECORD_PLACES = 8

/**
 * Adds `at` to `v`'s places unless it is one already met, as long as the value
 * has places to spare under MAX_RECORD_PLACES; the places past that only grow
 * `elsewhereOmitted`, one a place, so neither a value sent over and over nor
 * one echoed at the same place cannot lengthen the record without bound.
 * `seen` holds every path met so far, the left-out ones too, so a repeat
 * there is not counted twice (docs/adr/0028).
 */
function addPlace(v: ValueRecord, at: Place, seen: Map<string, Set<string>>): void {
  const paths = seen.get(v.placeholder) ?? new Set<string>()
  seen.set(v.placeholder, paths)
  if (paths.has(at.path)) return
  paths.add(at.path)
  const elsewhere = v.elsewhere ?? (v.elsewhere = [])
  // `at` is a place of its own when there is one, so this would be the (kept + 1)th
  if ((v.at ? 1 : 0) + elsewhere.length + 1 > MAX_RECORD_PLACES) {
    v.elsewhereOmitted = (v.elsewhereOmitted ?? 0) + 1
    return
  }
  elsewhere.push(at)
}

/** The values of a request's hits, one per placeholder, in the order first found. */
export function valuesOf(hits: readonly Hit[]): ValueRecord[] {
  const by = new Map<string, ValueRecord>()
  const seen = new Map<string, Set<string>>()
  for (const h of hits) {
    const v = by.get(h.placeholder)
    if (v) {
      v.n++
      if (h.at) addPlace(v, h.at, seen)
    } else {
      by.set(h.placeholder, {
        placeholder: h.placeholder,
        kind: h.kind,
        finder: h.by,
        head: h.head,
        ...(h.tail ? { tail: h.tail } : {}),
        len: h.len,
        n: 1,
        ...(h.action ? { action: h.action } : {}),
        ...(h.before !== undefined ? { before: h.before } : {}),
        ...(h.after !== undefined ? { after: h.after } : {}),
        ...(h.at ? { at: h.at } : {}),
      })
      if (h.at) seen.set(h.placeholder, new Set([h.at.path]))
    }
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
  restoredInTools: number
  unmapped: number
  failed: number
  /** Places a warn action sent as written. */
  warned: number
  /** Requests a block action stopped. */
  blocked: number
  /** Tool calls that sent a value put back off this machine, and the places left as placeholders in them. */
  exfil: number
  exfilBlocked: number
  tookMs: { sum: number; max: number }
  /** Places by kind, by finder, by host and by model. */
  kinds: Record<string, number>
  finders: Record<string, number>
  hosts: Record<string, number>
  models: Record<string, number>
}

export function emptyTotals(): Totals {
  return { requests: 0, masked: 0, n: 0, restored: 0, restoredInTools: 0, unmapped: 0, failed: 0, warned: 0, blocked: 0, exfil: 0, exfilBlocked: 0, tookMs: { sum: 0, max: 0 }, kinds: {}, finders: {}, hosts: {}, models: {} }
}

function bump(m: Record<string, number>, k: string, by: number): void {
  if (by > 0) m[k] = (m[k] ?? 0) + by
}

export function addRecord(t: Totals, r: MaskRecord): void {
  t.requests++
  if (r.n > 0) t.masked++
  t.n += r.n
  t.restored += r.restored
  t.restoredInTools += r.restoredInTools ?? 0
  t.unmapped += r.unmapped
  if (r.failed) t.failed++
  t.warned += r.warned ?? 0
  if (r.blocked) t.blocked++
  t.exfil += r.exfil ?? 0
  t.exfilBlocked += r.exfilBlocked ?? 0
  t.tookMs.sum += r.tookMs
  t.tookMs.max = Math.max(t.tookMs.max, r.tookMs)
  for (const v of r.values) {
    if (v.action) continue
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
  into.restoredInTools += t.restoredInTools
  into.unmapped += t.unmapped
  into.failed += t.failed
  into.warned += t.warned
  into.blocked += t.blocked
  into.exfil += t.exfil
  into.exfilBlocked += t.exfilBlocked
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
    if (typeof r.restoredInTools !== 'number') delete r.restoredInTools
    if (typeof r.warned !== 'number') delete r.warned
    if (typeof r.exfil !== 'number') delete r.exfil
    if (typeof r.exfilBlocked !== 'number') delete r.exfilBlocked
    if (typeof r.valuesOmitted !== 'number') delete r.valuesOmitted
    // a step is one the trajectory counts from 1; a record of another version may say none, or not a step at all
    for (const k of ['turn', 'step'] as const) {
      const n = r[k]
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) delete r[k]
    }
    // the two go together: one without the other names no place in the trajectory
    if (r.turn === undefined || r.step === undefined) {
      delete r.turn
      delete r.step
    }
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

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Deletes `file`; one already gone is no error. */
async function unlinkIfThere(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (err) {
    if (!isMissing(err)) throw err
  }
}

export class RecordStore {
  readonly #o: RecordStoreOptions
  /** The days on disk have been read into the sums (they are read once: a second read would count them twice). */
  #diskRead = false
  readonly #now: () => Date
  #ring: MaskRecord[] = []
  readonly #days = new Map<string, Totals>()
  #queue: Array<{ day: string; line: string }> = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #writing: Promise<void> = Promise.resolve()
  /**
   * The keys this store added while the disk was being read. Such a record is
   * in the sums already and may have been written before the read got to its
   * file, so the read skips exactly these; it does not compare keys with the
   * clock, which may have gone back since the records on disk were written.
   */
  #addedWhileLoading: Set<number> | undefined
  #failStreak = 0
  #prunedAt = -Infinity
  #dirReady = false
  /** Day files made ready to append to: their mode set and a line a crash cut short ended. */
  readonly #ready = new Set<string>()
  /** The bytes in each day file this store appends to. */
  readonly #sizes = new Map<string, number>()
  /** Day files that reached keepBytes: nothing more is appended to them. */
  readonly #full = new Set<string>()
  /** A reset going on: nothing is written until it is done. */
  #resetting: Promise<unknown> | undefined
  readonly #warnedAt = new Map<string, number>()
  /** Settles once the days on disk are in the sums and the latest records. */
  loaded: Promise<void> = Promise.resolve()

  constructor(options: RecordStoreOptions) {
    this.#o = { ...options }
    this.#now = options.now ?? (() => new Date())
    if (options.dir) this.#readDisk(options.dir)
  }

  #readDisk(dir: string): void {
    if (this.#diskRead) return
    this.#diskRead = true
    const added = new Set<number>()
    this.#addedWhileLoading = added
    this.loaded = this.#load(dir, added)
      .catch((err: unknown) => this.#warn('could not read the records on disk; the sums start from this run', err))
      .finally(() => {
        if (this.#addedWhileLoading === added) this.#addedWhileLoading = undefined
      })
  }

  /**
   * Starts or stops writing to disk (config record) and sets the days kept
   * (config keepDays), from the next record on (docs/adr/0021). Turning
   * writing on reads the days already on disk into the sums, once.
   */
  configure(options: { dir?: string; keepDays: number }): void {
    if (options.keepDays !== this.#o.keepDays) {
      this.#o.keepDays = options.keepDays
      // fewer days kept: the next write prunes, instead of up to an hour later
      this.#prunedAt = -Infinity
    }
    if (options.dir === this.#o.dir) return
    if (options.dir) {
      this.#o.dir = options.dir
      this.#readDisk(options.dir)
    } else {
      delete this.#o.dir
      // what was waiting to be written is not written: off means nothing more goes to disk
      this.#queue = []
    }
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
    if (rec.values.length > MAX_RECORD_VALUES) {
      rec.valuesOmitted = (rec.valuesOmitted ?? 0) + rec.values.length - MAX_RECORD_VALUES
      rec.values = rec.values.slice(0, MAX_RECORD_VALUES)
    }
    this.#addedWhileLoading?.add(rec.key)
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
  recent(limit = this.#o.keepRecords, session?: string): MaskRecord[] {
    const rows = session === undefined ? this.#ring : this.#ring.filter((r) => r.session === session)
    return rows.slice(-limit).reverse()
  }

  /**
   * Sums over some records. With `session`, over the records this run still
   * holds for that session: the per-day sums on disk are not per session, so a
   * session's view is bounded by memory (docs/adr/0021).
   */
  stats(session?: string): Stats {
    const now = this.#now()
    const since = (days: number): string => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)))
    const today = dayOf(now)
    const week = since(7)
    const month = since(STAT_DAYS)
    const out: Stats = { today: emptyTotals(), week: emptyTotals(), month: emptyTotals(), failStreak: this.#failStreak }
    if (session !== undefined) {
      for (const r of this.#ring) {
        if (r.session !== session) continue
        // the local day, as the day sums and the files go by
        const day = dayOf(new Date(r.time))
        if (day > today || day < month) continue
        addRecord(out.month, r)
        if (day >= week) addRecord(out.week, r)
        if (day === today) addRecord(out.today, r)
      }
      return out
    }
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
    // nothing goes to disk while a reset deletes the files: what waits is written after it
    if (this.#resetting) return this.#resetting.then(() => this.flush(), () => this.flush())
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const batch = this.#queue
    this.#queue = []
    if (batch.length > 0 && this.#o.dir) {
      const dir = this.#o.dir
      this.#writing = this.#writing
        .then(() => this.#write(dir, batch))
        .catch((err: unknown) => this.#warn('could not write the records; requests go on, unrecorded on disk', err))
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
      if (this.#full.has(file)) continue
      const h = await open(file, 'a+', 0o600)
      try {
        let size = this.#sizes.get(file)
        if (size === undefined || !this.#ready.has(file)) size = await this.#prepare(h)
        this.#ready.add(file)
        // a day file stops at keepBytes, today's too: the rest of that day stays in memory only
        const keep: string[] = []
        for (const line of lines) {
          const bytes = Buffer.byteLength(line) + 1
          if (size + bytes > this.#o.keepBytes) {
            this.#full.add(file)
            this.#o.logger?.warn(`dsh-privacy-gateway: the records of ${day} reached keepMegabytes; the rest of that day is kept in memory only`)
            break
          }
          keep.push(line)
          size += bytes
        }
        if (keep.length > 0) await h.appendFile(keep.join('\n') + '\n')
        this.#sizes.set(file, size)
      } finally {
        await h.close()
      }
    }
    if (this.#now().getTime() - this.#prunedAt >= PRUNE_EVERY_MS) {
      // a failed prune is not a failed write: the records above are on disk
      await this.prune().catch((err: unknown) => this.#warn('could not delete old record files; records are still written', err))
    }
  }

  /** Makes a day file private and ends a line a crash cut short, so the next record starts a line of its own; its size after. */
  async #prepare(h: FileHandle): Promise<number> {
    await h.chmod(0o600).catch(() => {})
    let { size } = await h.stat()
    if (size > 0) {
      const last = Buffer.alloc(1)
      await h.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) {
        await h.appendFile('\n')
        size++
      }
    }
    return size
  }

  /**
   * Deletes the days older than keepDays, then the oldest while there is more
   * than keepBytes; today's file stays. The sums and the latest records drop
   * the days deleted, so they are what a restart would read back.
   */
  async prune(): Promise<void> {
    const dir = this.#o.dir
    if (!dir) return
    this.#prunedAt = this.#now().getTime()
    const now = this.#now()
    const today = dayOf(now)
    const oldest = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (this.#o.keepDays - 1)))
    const gone = new Set<string>()
    const drop = async (day: string, file: string): Promise<void> => {
      await unlinkIfThere(file)
      this.#forgetFile(file)
      gone.add(day)
    }
    const days: Array<{ day: string; file: string; size: number }> = []
    try {
      for (const name of await readdir(dir)) {
        const m = DAY_FILE.exec(name)
        if (!m) continue
        const day = m[1] as string
        const file = join(dir, name)
        if (day < oldest) {
          await drop(day, file)
          continue
        }
        try {
          days.push({ day, file, size: (await stat(file)).size })
        } catch (err) {
          if (!isMissing(err)) throw err
        }
      }
      days.sort((a, b) => (a.day < b.day ? -1 : 1))
      let total = days.reduce((s, d) => s + d.size, 0)
      for (const d of days) {
        if (total <= this.#o.keepBytes || d.day === today) break
        await drop(d.day, d.file)
        total -= d.size
      }
    } finally {
      const statFrom = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (STAT_DAYS - 1)))
      const kept = (day: string): boolean => day >= statFrom && day >= oldest && !gone.has(day)
      for (const day of this.#days.keys()) if (!kept(day)) this.#days.delete(day)
      this.#ring = this.#ring.filter((r) => kept(dayOf(new Date(r.time))))
    }
  }

  #forgetFile(file: string): void {
    this.#ready.delete(file)
    this.#sizes.delete(file)
    this.#full.delete(file)
  }

  /**
   * Clears the history (the reset button, docs/adr/0022): the records in
   * memory, the sums, what was waiting to be written, and each day file in
   * `dir` (other files there stay). Returns how many day files went. A record
   * added while it waits for the read and the writes going on is cleared too;
   * one added while the files are deleted is kept, and written after.
   */
  async reset(dir = this.#o.dir): Promise<{ files: number }> {
    while (this.#resetting) await this.#resetting.catch(() => {})
    const run = this.#reset(dir)
    this.#resetting = run
    try {
      return await run
    } finally {
      this.#resetting = undefined
    }
  }

  async #reset(dir: string | undefined): Promise<{ files: number }> {
    // nothing left on disk to read in when writing is turned on later
    this.#diskRead = true
    // a read still going would put the old days back after the clearing
    await this.loaded
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    await this.#writing
    this.#queue = []
    this.#ring = []
    this.#days.clear()
    this.#failStreak = 0
    let files = 0
    if (dir) {
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      for (const name of names) {
        if (!DAY_FILE.test(name)) continue
        await unlinkIfThere(join(dir, name))
        files++
      }
    }
    this.#ready.clear()
    this.#sizes.clear()
    this.#full.clear()
    return { files }
  }

  /** Writes what is waiting and stops; records added later are kept in memory only. */
  async close(): Promise<void> {
    await this.flush()
  }

  async #load(dir: string, added: ReadonlySet<number>): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if (isMissing(err)) return
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
    let maxKey = 0
    for (const day of days) {
      const t = emptyTotals()
      const need = this.#o.keepRecords - older.length
      const tail: MaskRecord[] = []
      const lines = createInterface({ input: createReadStream(join(dir, `${day}.jsonl`), { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of lines) {
        // a blank line or one a crash cut short is no record
        const r = parseRecord(line)
        // one added since the read began is in the sums already
        if (!r || added.has(r.key)) continue
        if (typeof r.key === 'number' && r.key > maxKey) maxKey = r.key
        addRecord(t, r)
        if (need > 0) {
          tail.push(r)
          if (tail.length > need) tail.shift()
        }
      }
      addTotals(this.#day(day), t)
      older = [...tail, ...older]
    }
    // keys go on from the largest on disk, should the clock have gone back since it was written
    lastKey = Math.max(lastKey, maxKey)
    this.#ring = [...older, ...this.#ring].slice(-this.#o.keepRecords)
  }

  #warn(message: string, err: unknown): void {
    const at = this.#now().getTime()
    if (at - (this.#warnedAt.get(message) ?? -Infinity) < WARN_EVERY_MS) return
    this.#warnedAt.set(message, at)
    this.#o.logger?.warn(`dsh-privacy-gateway: ${message}`, err)
  }
}
