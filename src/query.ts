/**
 * The history query behind the card (docs/adr/0039): the latest records in
 * memory answer the card's own list, but a count on the card covers every day
 * on disk, and the record it came from may be far past the memory's reach. A
 * query therefore reads the day files, a slice at a time, and answers from a
 * frozen snapshot.
 *
 * Three rules shape the code:
 *
 * - A scan that runs out of its time slice keeps its place and can be resumed;
 *   it never starts over, or an early record on a slow disk is unreachable.
 * - A published snapshot never changes. A resumed scan produces a new one, so
 *   a page cursor keeps meaning what it meant when it was handed out.
 * - The model's own text is never a key, a label or a locator. Rows are found
 *   by file and line, and a row is only shown after its line is read again and
 *   its fingerprint matches, so a rewritten file cannot hand out another row.
 */
import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'

import { dayOf, decodeRecord, type LoadedRecord, type MaskRecord } from './records.ts'

/** What the query narrows by. */
export type QueryEvent = 'all' | 'anomalies' | 'unmapped' | 'exfil' | 'failed'

/** The first half of a query: what to look for. */
export interface QueryStart {
  mode: 'start'
  /** The local day the range starts, `YYYY-MM-DD`, and the day after it ends. */
  from: string
  to: string
  event: QueryEvent
  /** One session, by the id the record kept; absent means every session. */
  session?: string
  limit?: number
}

/** The rest: a build to read, to go on with, to publish, to drop, or a page of one. */
export type QueryMode =
  | QueryStart
  | { mode: 'poll' | 'resume' | 'partial' | 'cancel'; queryId: string }
  | { mode: 'page'; cursor: string }

/** One matched request, as the list shows it. */
export interface QuerySummary {
  /** Where the row sits, for the detail call; never a session id. */
  ref: string
  /** The record's own key, when it has one; a legacy row may not. */
  key?: number
  time: string
  turn?: number
  step?: number
  model?: string
  host: string
  from: string
  n: number
  restored: number
  unmapped: number
  exfil: number
  failed: boolean
  /** Whether this request kept anonymous notes on its unknown placeholders. */
  evidence: 'none' | 'kept' | 'unknown'
}

/** How much of the range the answer covers (docs/adr/0039). */
export interface QueryCoverage {
  storage: 'disk' | 'mixed' | 'memory-only'
  scan: 'building' | 'paused' | 'ready' | 'partial'
  /** Why the answer is not the whole range; names from a fixed set. */
  reasons: string[]
  /** Whether the reply path is on for this run; a setting, not proof it ran. */
  detection: 'on' | 'off' | 'unknown'
}

/** One page of a snapshot, with the counts of the rows it covers. */
export interface QueryPage {
  snapshotId: string
  items: QuerySummary[]
  nextCursor?: string
  matchedRequests: number
  unmappedOccurrences: number
  riskMatches: number
  coverage: QueryCoverage
  capturedAt: string
  expiresAt: string
  timeZone: string
}

/** What the host answers a mode with. */
export type QueryReply =
  | { status: 'building'; queryId: string; scanned: number; total?: number; retryMs: number }
  | { status: 'paused'; queryId: string; scanned: number; total?: number; canResume: boolean; reason: string }
  | { status: 'ready' | 'partial'; page: QueryPage; queryId?: string }
  | { status: 'error'; code: QueryErrorCode; message: string }

export type QueryErrorCode =
  | 'INVALID_QUERY'
  | 'CURSOR_EXPIRED'
  | 'SNAPSHOT_INVALIDATED'
  | 'RECORD_UNAVAILABLE'
  | 'RESOURCE_LIMIT'
  | 'READ_FAILED'
  | 'UNSUPPORTED_CAPABILITY'

/** What the engine reads and writes; the store owns the files. */
export interface QueryStore {
  /** Settles once the days on disk are in the store, so a query does not count a row twice. */
  loaded?: Promise<void>
  liveRecords(): readonly MaskRecord[]
  loadedLocations(): ReadonlySet<string>
  droppedCounts(): ReadonlyMap<string, number>
  dayFiles(): Promise<string[]>
  dayPath(day: string): string | undefined
}

export interface QueryOptions {
  store: QueryStore
  /** How long one slice may run before it yields; the rest is the next slice. */
  sliceMs?: number
  /** The most rows one scan keeps; past it the answer is partial. */
  maxCandidates?: number
  /** The most keys one scan remembers, to know which row won. */
  maxKeys?: number
  /** How long a build or a snapshot stays, in ms. */
  ttlMs?: number
  /** How many builds and snapshots one host keeps at once. */
  maxLive?: number
  /** Whether the reply path is on for this run (config restoreLog). */
  detectionOn?: () => boolean
  /** The clock, for the tests. */
  now?: () => Date
  /** The zone the page names, as the host's own name for it. */
  timeZone?: string
}

/** Where one row sits: a day file and the line's first byte. */
interface Place {
  day: string
  offset: number
  /** The line's fingerprint, so a rewritten file cannot answer for another row. */
  print: string
  /** The row itself, for one this run holds in memory and no file answers for. */
  row?: LoadedRecord
}

interface Candidate extends Place {
  ref: string
  row: LoadedRecord
}

interface Build {
  id: string
  req: QueryStart
  files: string[]
  /** The file being read, and where in it. */
  index: number
  offset: number
  /** The byte the unread tail starts at, and the tail itself. */
  base: number
  rest: string
  /** The open file, kept across slices so a resume reads on from the next line. */
  handle?: FileHandle
  /** Keys already met, newest first, so the first row read is the winner. */
  seen: Set<number>
  rows: Candidate[]
  /** Rows that matched, and unknown placeholders among them. */
  matched: number
  unmapped: number
  risk: number
  /** Why the scan stopped short, if it did. */
  stopped?: string
  /** Whether the last slice ended on its budget rather than on the file. */
  paused: boolean
  /** The page already published for this build, when one was asked for. */
  page?: QueryPage
  done: boolean
  /** The file's identity when it was first read, to notice a swap. */
  stamps: Map<string, string>
}

interface Snapshot {
  id: string
  /** The page size the query asked for; a cursor keeps it. */
  limit: number
  rows: QuerySummary[]
  places: Map<string, Place>
  matched: number
  unmapped: number
  risk: number
  coverage: QueryCoverage
  capturedAt: string
  expiresAt: string
}

/** The default caps; every one of them is a proposal to measure (docs/adr/0039). */
const DEFAULT_SLICE_MS = 10_000
const DEFAULT_MAX_CANDIDATES = 5_000
const DEFAULT_MAX_KEYS = 100_000
const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_LIVE = 4
const READ_CHUNK = 1 << 20
/** The fewest lines a slice reads before it looks at its budget. */
const MIN_LINES = 200
const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/** The line's fingerprint: enough to tell one row from another, not the row. */
function printOf(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16)
}

/** The events a query narrows by. */
const EVENTS = new Set(['all', 'anomalies', 'unmapped', 'exfil', 'failed'])

function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** The label a row shows for where it came from. */
function fromOf(row: { workspace?: string; title?: string; session?: string }): string {
  return [row.workspace, row.title ?? row.session].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')
}

function summaryOf(row: LoadedRecord, ref: string): QuerySummary {
  return {
    ref,
    ...(row.key !== undefined ? { key: row.key } : {}),
    time: row.time,
    ...(row.turn !== undefined && row.step !== undefined ? { turn: row.turn, step: row.step } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    host: row.host,
    from: fromOf(row),
    n: row.n,
    restored: row.restored,
    unmapped: row.unmapped,
    exfil: row.exfil ?? 0,
    failed: row.failed === true,
    evidence: row.unknown !== undefined && row.unknown.length > 0 ? 'kept' : row.unmapped > 0 ? 'unknown' : 'none',
  }
}

/** Whether a row is one the query is looking for. */
function matches(row: LoadedRecord, event: QueryEvent): boolean {
  if (event === 'all') return true
  if (event === 'anomalies') return row.unmapped > 0 || (row.exfil ?? 0) > 0 || row.failed === true
  if (event === 'unmapped') return row.unmapped > 0
  if (event === 'exfil') return (row.exfil ?? 0) > 0
  return row.failed === true
}

/**
 * Reads one day file's lines with the byte each starts at, a chunk at a time,
 * so a big day costs one buffer and not the whole file. The last line of a
 * file a crash cut short is read as a line and then rejected by the decoder.
 */
async function* lines(file: string, from: number): AsyncGenerator<{ offset: number; line: string }> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    let offset = from
    let start = from
    let rest = ''
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      rest += buffer.toString('utf8', 0, bytesRead)
      let cut = rest.indexOf('\n')
      while (cut >= 0) {
        yield { offset: start, line: rest.slice(0, cut) }
        start += cut + 1
        rest = rest.slice(cut + 1)
        cut = rest.indexOf('\n')
      }
    }
    if (rest !== '') yield { offset: start, line: rest }
  } finally {
    await handle.close()
  }
}

/**
 * The history queries of one host (docs/adr/0039). A build is resumable and a
 * snapshot is frozen; the two are separate objects on purpose, so a page
 * cursor keeps its meaning while a scan goes on.
 */
export class QueryEngine {
  readonly #o: Required<Omit<QueryOptions, 'detectionOn'>> & Pick<QueryOptions, 'detectionOn'>
  readonly #builds = new Map<string, Build>()
  readonly #snapshots = new Map<string, Snapshot>()
  #seq = 0
  #snapSeq = 0

  constructor(options: QueryOptions) {
    this.#o = {
      store: options.store,
      sliceMs: options.sliceMs ?? DEFAULT_SLICE_MS,
      maxCandidates: options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      maxLive: options.maxLive ?? DEFAULT_MAX_LIVE,
      detectionOn: options.detectionOn,
      now: options.now ?? (() => new Date()),
      timeZone: options.timeZone ?? 'Asia/Shanghai',
    }
  }

  /** The mode the caller asked for, answered from a build or a snapshot. */
  async run(mode: QueryMode): Promise<QueryReply> {
    this.#expire()
    if (mode.mode === 'start') return this.#start(mode)
    if (mode.mode === 'page') return this.#page(mode.cursor)
    const build = this.#builds.get(mode.queryId)
    if (!build) return { status: 'error', code: 'CURSOR_EXPIRED', message: 'this query is no longer held' }
    if (mode.mode === 'poll') return this.#state(build)
    if (mode.mode === 'cancel') {
      this.#builds.delete(build.id)
      return { status: 'error', code: 'UNSUPPORTED_CAPABILITY', message: 'cancelled' }
    }
    if (mode.mode === 'partial') return this.#publish(build, true)
    return this.#resume(build)
  }

  /** Drops what is waiting and stops; records already published stay until they expire. */
  dispose(): void {
    for (const build of this.#builds.values()) void build.handle?.close().catch(() => {})
    this.#builds.clear()
  }

  #state(build: Build): QueryReply {
    if (build.done) return this.#publish(build, false)
    if (build.stopped !== undefined && build.page) return { status: 'partial', page: build.page, queryId: build.id }
    if (build.stopped !== undefined) {
      return { status: 'paused', queryId: build.id, scanned: build.index, total: build.files.length, canResume: false, reason: build.stopped }
    }
    // a slice that ended on its budget waits for the reader; one still going
    // asks again on its own
    if (build.paused) {
      return { status: 'paused', queryId: build.id, scanned: build.index, total: build.files.length, canResume: true, reason: 'slice' }
    }
    return { status: 'building', queryId: build.id, scanned: build.index, total: build.files.length, retryMs: 200 }
  }

  async #start(req: QueryStart): Promise<QueryReply> {
    const limit = req.limit ?? DEFAULT_LIMIT
    if (!isDay(req.from) || !isDay(req.to) || req.from > req.to || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { status: 'error', code: 'INVALID_QUERY', message: 'a day range and a limit of 1 to 200 are needed' }
    }
    if (!EVENTS.has(req.event)) {
      return { status: 'error', code: 'INVALID_QUERY', message: 'an event to narrow by is needed' }
    }
    if (req.session !== undefined && (typeof req.session !== 'string' || req.session === '')) {
      return { status: 'error', code: 'INVALID_QUERY', message: 'a session id is needed' }
    }
    // the store's own read of the day files comes first: a row it kept in
    // memory is counted there, and the query must not count it again
    if (this.#o.store.loaded) await this.#o.store.loaded
    this.#trim()
    const files = (await this.#o.store.dayFiles()).filter((d) => d >= req.from && d < req.to)
    const id = `q${++this.#seq}`
    const build: Build = {
      id,
      req: { ...req, limit },
      files,
      index: 0,
      offset: 0,
      base: 0,
      rest: '',
      seen: new Set(),
      rows: [],
      matched: 0,
      unmapped: 0,
      risk: 0,
      done: files.length === 0,
      paused: false,
      stamps: new Map(),
    }
    // A live record wins over the disk row of the same key, as the load does,
    // and is itself a candidate: no file holds it yet.
    for (const row of this.#o.store.liveRecords()) {
      if (row.key !== undefined) build.seen.add(row.key)
      if (req.session !== undefined && row.session !== req.session) continue
      if (!matches(row, req.event)) continue
      build.matched++
      build.unmapped += row.unmapped
      build.risk += (row.exfil ?? 0) > 0 ? 1 : 0
      build.rows.push({ day: dayOf(new Date(row.time)), offset: -1, print: '', ref: `r${build.rows.length}`, row })
    }
    if (build.rows.length > this.#o.maxCandidates) {
      build.rows.length = this.#o.maxCandidates
      build.stopped = 'too-many-matches'
      return this.#state(build)
    }
    this.#builds.set(id, build)
    return this.#pump(build)
  }

  /**
   * One slice, then the state. The file stays open across slices and the
   * unread tail stays in the build, so a resume continues at the next line
   * rather than at a byte it has to guess (docs/adr/0039).
   */
  async #pump(build: Build): Promise<QueryReply> {
    const until = this.#o.now().getTime() + this.#o.sliceMs
    while (!build.done) {
      const day = build.files[build.index] as string
      const path = this.#o.store.dayPath(day)
      if (path === undefined) {
        build.stopped = 'unreadable'
        return this.#state(build)
      }
      if (!build.handle) {
        try {
          build.handle = await open(path, 'r')
        } catch {
          build.stopped = 'unreadable'
          return this.#state(build)
        }
        build.offset = 0
        build.base = 0
        build.rest = ''
      }
      let cut = build.rest.indexOf('\n')
      let lines = 0
      while (cut >= 0) {
        const line = build.rest.slice(0, cut)
        build.rest = build.rest.slice(cut + 1)
        const at = build.base
        build.base += Buffer.byteLength(line) + 1
        this.#take(build, day, line, at)
        if (build.stopped !== undefined) return this.#state(build)
        // the budget is checked after a line, so a slice of no time still
        // advances: a scan that never moves is a scan that never ends
        // the budget is looked at every MIN_LINES lines: a slice that checks
        // after each line would spend a slice on one line of a big file
        if (++lines >= MIN_LINES && this.#o.now().getTime() >= until) {
          build.paused = true
          return this.#state(build)
        }
        cut = build.rest.indexOf('\n')
      }
      const buffer = Buffer.allocUnsafe(READ_CHUNK)
      let bytesRead: number
      try {
        const read = await build.handle.read(buffer, 0, READ_CHUNK, build.offset)
        bytesRead = read.bytesRead
      } catch {
        build.stopped = 'unreadable'
        return this.#state(build)
      }
      if (bytesRead === 0) {
        await build.handle.close().catch(() => {})
        build.handle = undefined
        build.rest = ''
        build.index++
        build.offset = 0
        build.base = 0
        if (build.index >= build.files.length) build.done = true
        continue
      }
      build.offset += bytesRead
      build.rest += buffer.toString('utf8', 0, bytesRead)
      if (this.#o.now().getTime() >= until) {
        build.paused = true
        return this.#state(build)
      }
    }
    return this.#publish(build, false)
  }

  /** One line: the winner of its key, and a candidate when it is what was asked for. */
  #take(build: Build, day: string, line: string, offset: number): void {
    const row = decodeRecord(line)
    if (!row) return
    const at = `${day}#${offset}`
    // A row this store already read into memory is counted there, not twice here.
    if (this.#o.store.loadedLocations().has(at)) return
    if (row.key !== undefined) {
      if (build.seen.has(row.key)) return
      if (build.seen.size >= this.#o.maxKeys) {
        build.stopped = 'key-space'
        return
      }
      build.seen.add(row.key)
    }
    if (build.req.session !== undefined && row.session !== build.req.session) return
    if (!matches(row, build.req.event)) return
    build.matched++
    build.unmapped += row.unmapped
    build.risk += (row.exfil ?? 0) > 0 ? 1 : 0
    const ref = `r${build.rows.length}`
    build.rows.push({ day, offset, print: printOf(line), ref, row })
    if (build.rows.length > this.#o.maxCandidates) {
      build.rows.pop()
      build.matched--
      build.stopped = 'too-many-matches'
    }
  }

  /** A slice is over: either the build goes on from here, or it is published. */
  async #resume(build: Build): Promise<QueryReply> {
    if (build.done) return this.#publish(build, false)
    if (build.stopped !== undefined && build.page) return { status: 'partial', page: build.page, queryId: build.id }
    if (build.stopped !== undefined) {
      return { status: 'paused', queryId: build.id, scanned: build.index, total: build.files.length, canResume: false, reason: build.stopped }
    }
    return this.#pump(build)
  }

  /** The rows in the order the page shows them: by key, then the old rows with none. */
  #ordered(build: Build): Candidate[] {
    const keyed = build.rows.filter((r) => r.row.key !== undefined).sort((a, b) => (b.row.key as number) - (a.row.key as number))
    const keyless = build.rows.filter((r) => r.row.key === undefined).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.offset - a.offset))
    return [...keyed, ...keyless]
  }

  #publish(build: Build, partial: boolean): QueryReply {
    // a page asked for twice is the same page: a build goes on, a snapshot does not
    if (partial && build.page) return { status: 'partial', page: build.page, queryId: build.id }
    const rows = this.#ordered(build)
    const places = new Map<string, Place>()
    for (const row of rows) places.set(row.ref, { day: row.day, offset: row.offset, print: row.print, ...(row.offset < 0 ? { row: row.row } : {}) })
    const reasons: string[] = []
    if (partial || build.stopped !== undefined) reasons.push(build.stopped ?? 'partial')
    const dropped = [...this.#o.store.droppedCounts()].filter(([day]) => day >= (build.req.from as string) && day < (build.req.to as string))
    if (dropped.length > 0) reasons.push('write-gaps')
    const storage: QueryCoverage['storage'] = build.files.length === 0 ? 'memory-only' : this.#o.store.liveRecords().length > 0 ? 'mixed' : 'disk'
    const capturedAt = this.#o.now().toISOString()
    // each publish is its own snapshot: a resumed scan must not change a page
    const id = `s${build.id}-${++this.#snapSeq}`
    const page: QueryPage = {
      snapshotId: id,
      items: rows.map((r) => summaryOf(r.row, r.ref)),
      matchedRequests: rows.length,
      unmappedOccurrences: build.unmapped,
      riskMatches: build.risk,
      coverage: {
        storage,
        scan: reasons.length === 0 ? 'ready' : 'partial',
        reasons,
        detection: this.#o.detectionOn === undefined ? 'unknown' : this.#o.detectionOn() ? 'on' : 'off',
      },
      capturedAt,
      expiresAt: new Date(this.#o.now().getTime() + this.#o.ttlMs).toISOString(),
      timeZone: this.#o.timeZone,
    }
    this.#snapshots.set(id, {
      id,
      limit: build.req.limit ?? DEFAULT_LIMIT,
      rows: page.items,
      places,
      matched: page.matchedRequests,
      unmapped: page.unmappedOccurrences,
      risk: page.riskMatches,
      coverage: page.coverage,
      capturedAt,
      expiresAt: page.expiresAt,
    })
    if (partial) build.page = this.#cut(id, page, build.req.limit ?? DEFAULT_LIMIT)
    else this.#builds.delete(build.id)
    this.#trim()
    // The first page comes with the answer; the rest is asked for by cursor.
    return { status: page.coverage.scan === 'ready' ? 'ready' : 'partial', page: this.#cut(id, page, build.req.limit ?? DEFAULT_LIMIT), ...(partial ? { queryId: build.id } : {}) }
  }

  /** The page a snapshot answers with, from where the last one stopped. */
  #cut(id: string, page: QueryPage, limit: number): QueryPage {
    const all = this.#snapshots.get(id)
    if (!all) return page
    const items = all.rows.slice(0, limit)
    return {
      ...page,
      items,
      ...(all.rows.length > items.length ? { nextCursor: this.#cursor(id, items.length) } : {}),
    }
  }

  #cursor(id: string, index: number): string {
    return Buffer.from(JSON.stringify({ s: id, i: index }), 'utf8').toString('base64url')
  }

  #page(cursor: string): QueryReply {
    let read: { s?: unknown; i?: unknown }
    try {
      read = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof read
    } catch {
      return { status: 'error', code: 'CURSOR_EXPIRED', message: 'this page is no longer held' }
    }
    const snap = typeof read.s === 'string' ? this.#snapshots.get(read.s) : undefined
    if (!snap || typeof read.i !== 'number' || !Number.isSafeInteger(read.i) || read.i < 0 || read.i > snap.rows.length) {
      return { status: 'error', code: 'CURSOR_EXPIRED', message: 'this page is no longer held' }
    }
    const items = snap.rows.slice(read.i, read.i + snap.limit)
    const page: QueryPage = {
      snapshotId: snap.id,
      items,
      matchedRequests: snap.matched,
      unmappedOccurrences: snap.unmapped,
      riskMatches: snap.risk,
      coverage: snap.coverage,
      capturedAt: snap.capturedAt,
      expiresAt: snap.expiresAt,
      timeZone: this.#o.timeZone,
      ...(snap.rows.length > read.i + items.length ? { nextCursor: this.#cursor(snap.id, read.i + items.length) } : {}),
    }
    return { status: snap.coverage.scan === 'ready' ? 'ready' : 'partial', page }
  }

  /**
   * The row a ref names, read again from its file and only if the line is the
   * one the snapshot was built from. A rewritten or truncated file answers
   * RECORD_UNAVAILABLE rather than another row (docs/adr/0039).
   */
  async detail(ref: string): Promise<{ row: LoadedRecord; key?: number } | { code: QueryErrorCode; message: string }> {
    for (const snap of this.#snapshots.values()) {
      const place = snap.places.get(ref)
      if (!place) continue
      // a row this run holds in memory: no file answers for it
      if (place.row) return { row: place.row, ...(place.row.key !== undefined ? { key: place.row.key } : {}) }
      const path = this.#o.store.dayPath(place.day)
      if (path === undefined) return { code: 'RECORD_UNAVAILABLE', message: 'this record is no longer on disk' }
      try {
        for await (const line of lines(path, place.offset)) {
          if (line.offset !== place.offset) return { code: 'RECORD_UNAVAILABLE', message: 'this record has moved' }
          if (printOf(line.line) !== place.print) return { code: 'SNAPSHOT_INVALIDATED', message: 'this record has changed' }
          const row = decodeRecord(line.line)
          if (!row) return { code: 'RECORD_UNAVAILABLE', message: 'this record cannot be read' }
          return { row, ...(row.key !== undefined ? { key: row.key } : {}) }
        }
        return { code: 'RECORD_UNAVAILABLE', message: 'this record is no longer on disk' }
      } catch {
        return { code: 'READ_FAILED', message: 'this record could not be read' }
      }
    }
    return { code: 'RECORD_UNAVAILABLE', message: 'this record is no longer held' }
  }

  /** Drops what is past its time or over the cap; the newest build is kept. */
  #trim(): void {
    const cutoff = this.#o.now().getTime() - this.#o.ttlMs
    for (const [id, snap] of this.#snapshots) if (Date.parse(snap.expiresAt) < cutoff || Date.parse(snap.expiresAt) <= this.#o.now().getTime()) this.#snapshots.delete(id)
    while (this.#builds.size + this.#snapshots.size > this.#o.maxLive) {
      const oldest = this.#builds.keys().next()
      if (oldest.done) break
      this.#builds.delete(oldest.value)
    }
  }

  #expire(): void {
    const now = this.#o.now().getTime()
    for (const [id, snap] of this.#snapshots) if (Date.parse(snap.expiresAt) <= now) this.#snapshots.delete(id)
    for (const [id, build] of this.#builds) if (build.done) this.#builds.delete(id)
  }
}