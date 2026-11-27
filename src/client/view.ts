/**
 * What the card shows, worked out from an overview: no DOM, no React, so the
 * unit tests run it as it is.
 */
import type { Overview } from '../remote.ts'
import type { QueryCoverage, QuerySummary } from '../query.ts'
import type { MaskRecord, Place, Totals, ValueRecord } from '../records.ts'
import type { Key, T } from './locales.ts'
import type { Failure, Result } from './rpc.ts'

export type Range = 'today' | 'week' | 'month'

export interface Bar {
  label: string
  value: number
  /** Its share of the largest, 0–100. */
  pct: number
}

/** The entries of `m`, largest first, at most `max` of them, the rest summed as `others`. */
export function bars(m: Record<string, number>, max = 6, others = '…'): Bar[] {
  const all = Object.entries(m)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const shown = all.slice(0, max)
  const rest = all.slice(max).reduce((s, [, v]) => s + v, 0)
  if (rest > 0) shown.push([others, rest])
  const top = shown.reduce((m2, [, v]) => Math.max(m2, v), 0)
  return shown.map(([label, value]) => ({ label, value, pct: top > 0 ? Math.max(2, Math.round((value / top) * 100)) : 0 }))
}

/** The kinds the gateway writes, as the README's masking table names them (docs/adr/0035). */
export const KIND_NAMES = ['SECRET', 'PASSWORD', 'API_KEY', 'TOKEN', 'PRIVATE_KEY', 'COOKIE', 'EMAIL', 'PHONE', 'ID_CARD', 'BANK_CARD', 'TERM'] as const

/** The finders, as the record's `finder` names them (src/redact/ids.ts). */
export const FINDER_NAMES = ['rule', 'word', 'known', 'cookie'] as const

const KIND_HINT_KEYS: Record<string, Key> = {
  SECRET: 'hint.kind.SECRET',
  PASSWORD: 'hint.kind.PASSWORD',
  API_KEY: 'hint.kind.API_KEY',
  TOKEN: 'hint.kind.TOKEN',
  PRIVATE_KEY: 'hint.kind.PRIVATE_KEY',
  COOKIE: 'hint.kind.COOKIE',
  EMAIL: 'hint.kind.EMAIL',
  PHONE: 'hint.kind.PHONE',
  ID_CARD: 'hint.kind.ID_CARD',
  BANK_CARD: 'hint.kind.BANK_CARD',
  TERM: 'hint.kind.TERM',
}

const FINDER_HINT_KEYS: Record<string, Key> = {
  rule: 'hint.finder.rule',
  word: 'hint.finder.word',
  known: 'hint.finder.known',
  cookie: 'hint.finder.cookie',
}

/** What a kind means, for the hover card, when this version knows it; a record of another version may say one it does not. */
export function kindHintKey(kind: string): Key | undefined {
  return KIND_HINT_KEYS[kind]
}

/** What a finder means, for the hover card, when this version knows it. */
export function finderHintKey(finder: string): Key | undefined {
  return FINDER_HINT_KEYS[finder]
}

/** What the values table shows: both narrow together, neither narrows when it is left out (docs/adr/0035). */
export interface ValueFilter {
  kind?: string
  finder?: string
}

/** The values `f` keeps, in the record's order. */
export function filterValues(values: readonly ValueRecord[], f: ValueFilter): ValueRecord[] {
  return values.filter((v) => (f.kind === undefined || v.kind === f.kind) && (f.finder === undefined || v.finder === f.finder))
}

/** The names one column offers as filters: each once, the empty one dropped, in code-unit order so the menu holds still. */
export function namesOf(values: readonly ValueRecord[], field: 'kind' | 'finder'): string[] {
  return [...new Set(values.map((v) => v[field]).filter((n) => n !== ''))].sort()
}

export type WarningKey = 'warn.streak' | 'warn.unmapped' | 'warn.inTools' | 'warn.exfil'

/** The signals worth a line of their own (design §7.3), for the range shown. */
export function warnings(o: Overview, t: Totals): Array<{ key: WarningKey; n: number; tone: 'error' | 'warn' }> {
  const out: Array<{ key: WarningKey; n: number; tone: 'error' | 'warn' }> = []
  if (o.stats.failStreak > 0) out.push({ key: 'warn.streak', n: o.stats.failStreak, tone: 'error' })
  if (t.unmapped > 0) out.push({ key: 'warn.unmapped', n: t.unmapped, tone: 'warn' })
  if ((t.exfil ?? 0) > 0) out.push({ key: 'warn.exfil', n: t.exfil, tone: 'error' })
  else if (t.restoredInTools > 0) out.push({ key: 'warn.inTools', n: t.restoredInTools, tone: 'warn' })
  return out
}

/** Mean and max masking time, in ms with two decimals at most. */
export function took(t: Totals): { avg: number; max: number } {
  const r = (n: number): number => Math.round(n * 100) / 100
  return { avg: t.requests > 0 ? r(t.tookMs.sum / t.requests) : 0, max: r(t.tookMs.max) }
}

/** A record's time as the list shows it: HH:MM:SS today, MM-DD HH:MM before. */
export function timeLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A count per name, the entries that are not counts dropped. */
function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (isObject(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  return out
}

/** One range's sums with every field the card reads, a missing or odd one as zero; undefined when it is not an object at all. */
export function readTotals(v: unknown): Totals | undefined {
  if (!isObject(v)) return undefined
  const took = isObject(v.tookMs) ? v.tookMs : {}
  return {
    requests: count(v.requests),
    masked: count(v.masked),
    n: count(v.n),
    restored: count(v.restored),
    restoredInTools: count(v.restoredInTools),
    unmapped: count(v.unmapped),
    failed: count(v.failed),
    warned: count(v.warned),
    blocked: count(v.blocked),
    exfil: count(v.exfil),
    exfilBlocked: count(v.exfilBlocked),
    tookMs: { sum: count(took.sum), max: count(took.max) },
    kinds: counts(v.kinds),
    finders: counts(v.finders),
    hosts: counts(v.hosts),
    models: counts(v.models),
  }
}

/** A record the list can draw: it has a key, a time and its values; the rest is optional or counted. */
function isRecord(v: unknown): v is MaskRecord {
  return isObject(v) && typeof v.key === 'number' && typeof v.time === 'string' && Array.isArray(v.values) && v.values.every(isObject)
}

/** A place the card can name, when it has the path it names it by. */
function readPlace(v: unknown): Place | undefined {
  if (!isObject(v) || typeof v.path !== 'string' || v.path === '') return undefined
  return { path: v.path, ...(typeof v.role === 'string' ? { role: v.role } : {}), ...(typeof v.type === 'string' ? { type: v.type } : {}) }
}

/** The places in `v`: each one a place with a path, each path once, in the order given (docs/adr/0028). */
function readPlaces(v: unknown): Place[] {
  if (!Array.isArray(v)) return []
  const out: Place[] = []
  const seen = new Set<string>()
  for (const raw of v) {
    const p = readPlace(raw)
    if (p === undefined || seen.has(p.path)) continue
    seen.add(p.path)
    out.push(p)
  }
  return out
}

/**
 * The most other places the card names for one value; a record of another
 * version may keep more, and those go into its count instead, so the line
 * cannot grow without bound. The host keeps at most MAX_RECORD_PLACES - 1.
 */
const PLACES_SHOWN = 7

/** A count the card shows: a whole one, never below zero, an odd one as zero. */
const whole = (v: unknown): number => Math.max(0, Math.floor(count(v)))

/**
 * A record's value with its own fields checked and its places kept as places,
 * so a record written by another version cannot break the table: an object
 * where a name or a count belongs would be drawn as one, and React refuses
 * that. A value without a placeholder is one the table cannot name at all.
 */
function readValue(v: MaskRecord['values'][number]): ValueRecord | undefined {
  if (typeof v.placeholder !== 'string' || v.placeholder === '') return undefined
  const text = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
  const tail = text(v.tail)
  const before = text(v.before)
  const after = text(v.after)
  const at = readPlace(v.at)
  const first = stepOf(v.first ?? {})
  const places = readPlaces(v.elsewhere)
  const elsewhere = places.slice(0, PLACES_SHOWN)
  const dropped = whole(v.elsewhereOmitted) + places.length - elsewhere.length
  return {
    placeholder: v.placeholder,
    kind: text(v.kind) ?? '',
    // the name as it came: one this version does not know still shows, with no hint card (ADR-0035)
    finder: text(v.finder) ?? '',
    head: text(v.head) ?? '',
    ...(tail !== undefined ? { tail } : {}),
    len: whole(v.len),
    n: whole(v.n),
    ...(v.action === 'warn' || v.action === 'block' ? { action: v.action } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(at ? { at } : {}),
    ...(first ? { first } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(dropped > 0 ? { elsewhereOmitted: dropped } : {}),
  }
}

/**
 * The turn and step a record names, when it names both: a record written
 * before the gateway read them, and one from a call outside a step, name
 * none. Both are counted from 1, as the trajectory counts them.
 */
export function stepOf(r: { turn?: unknown; step?: unknown }): { turn: number; step: number } | undefined {
  const turn = r.turn
  const step = r.step
  if (typeof turn !== 'number' || typeof step !== 'number') return undefined
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || turn < 1 || step < 1) return undefined
  return { turn, step }
}

/** A record's step as the list shows it: turn and step, short, the words in its title (docs/adr/0030). */
export function stepLabel(at: { turn: number; step: number }): string {
  return `${at.turn}·${at.step}`
}

/**
 * A record as the list draws it: its counts as counts, its places as places
 * and its step, when it names one, as a step, so a record written by another
 * version cannot break the card.
 */
function readRecord(r: MaskRecord): MaskRecord {
  const {
    valuesOmitted,
    turn,
    step,
    model: rawModel,
    host: rawHost,
    what: rawWhat,
    tookMs: rawTook,
    title: rawTitle,
    workspace: rawWorkspace,
    session: rawSession,
    exfil: rawExfil,
    exfilHosts: rawExfilHosts,
    restoredInTools: rawInTools,
    warned: rawWarned,
    failed: rawFailed,
    blocked: rawBlocked,
    relay: rawRelay,
    ...rest
  } = r
  const text = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)
  const omitted = count(valuesOmitted)
  const at = stepOf({ turn, step })
  const model = text(rawModel)
  const title = text(rawTitle)
  const workspace = text(rawWorkspace)
  const session = text(rawSession)
  const exfil = count(rawExfil)
  const inTools = count(rawInTools)
  const warned = count(rawWarned)
  const hosts = Array.isArray(rawExfilHosts) ? rawExfilHosts.filter((x): x is string => typeof x === 'string') : undefined
  // every field the card draws is checked here: a record from another version
  // must not put an object where a name goes, or the whole card fails to render
  return {
    ...rest,
    host: text(rawHost) ?? '',
    what: rawWhat === 'chat' || rawWhat === 'embeddings' || rawWhat === 'count' || rawWhat === 'search' ? rawWhat : 'chat',
    tookMs: count(rawTook),
    n: count(r.n),
    restored: count(r.restored),
    unmapped: count(r.unmapped),
    values: r.values.map(readValue).filter((v): v is ValueRecord => v !== undefined),
    ...(model !== undefined ? { model } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(exfil > 0 ? { exfil } : {}),
    ...(hosts !== undefined && hosts.length > 0 ? { exfilHosts: hosts } : {}),
    ...(inTools > 0 ? { restoredInTools: inTools } : {}),
    ...(warned > 0 ? { warned } : {}),
    ...(rawFailed === true ? { failed: true } : {}),
    ...(rawBlocked === true ? { blocked: true } : {}),
    ...(rawRelay === true ? { relay: true } : {}),
    ...(omitted > 0 ? { valuesOmitted: omitted } : {}),
    ...(at ?? {}),
  }
}

/**
 * The overview the host half answered, with each range's sums filled in and
 * the records the list cannot draw left out, so a host of another version
 * cannot break the card; undefined when it is not an overview at all.
 */
export function readOverview(o: unknown): Overview | undefined {
  if (!isObject(o) || typeof o.active !== 'boolean' || !isObject(o.stats) || !Array.isArray(o.recent)) return undefined
  const today = readTotals(o.stats.today)
  const week = readTotals(o.stats.week)
  const month = readTotals(o.stats.month)
  if (!today || !week || !month) return undefined
  const { restoreLog: rawRestoreLog, ...rest } = o
  return {
    ...(rest as unknown as Overview),
    // a host of this version says; an older one has no such field, and the card shows the count as it is
    ...(typeof rawRestoreLog === 'boolean' ? { restoreLog: rawRestoreLog } : {}),
    values: count(o.values),
    stats: { today, week, month, failStreak: count(o.stats.failStreak) },
    recent: o.recent.filter(isRecord).map(readRecord),
    ...(Array.isArray(o.views) ? { views: o.views.filter((k): k is number => typeof k === 'number') } : {}),
  }
}

/** What the card holds: nothing yet, nothing to show, or an overview and, when the latest refresh failed, why. */
export type CardState = { status: 'loading' } | { status: 'error'; failure: Failure } | { status: 'ready'; data: Overview; stale?: Failure }

/**
 * The card's state after a refresh: a new overview replaces the old one; a
 * failed refresh keeps what was shown but marks it stale, so the card says
 * the numbers are old instead of passing them off as current.
 */
export function afterRefresh(prev: CardState, next: Result<Overview>): CardState {
  if (next.ok) return { status: 'ready', data: next.value }
  return prev.status === 'ready' ? { status: 'ready', data: prev.data, stale: next.failure } : { status: 'error', failure: next.failure }
}

/**
 * A record with nothing to say on its row: no place replaced, no unknown
 * placeholder in the reply and no failure. Such a row is dimmed; one that is
 * only there for its unknown placeholders is not, or it would read as if
 * nothing had happened.
 */
export function quiet(r: { n: number; failed?: boolean; unmapped?: number }): boolean {
  return r.n === 0 && r.failed !== true && (r.unmapped ?? 0) === 0
}

/** One line of the side-by-side view: its number, and its pieces, each plain or a replaced place. */
export interface ViewLine {
  n: number
  parts: Array<{ text: string; id?: string }>
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A body's lines as the side-by-side view shows them (docs/adr/0016): JSON pretty-printed, anything else as it is. */
export function bodyLines(body: string): string[] {
  let text = body
  try {
    text = JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    // not JSON: shown as it is
  }
  return text.split('\n')
}

/** What tells one record's values apart from another's: their placeholders, in order. */
export function valuesKey(values: readonly { placeholder: string }[]): string {
  return values.map((v) => v.placeholder).join('\u0000')
}

/**
 * The lines of a body (`bodyLines`) with each placeholder or made-up key in
 * `ids` a piece of its own; with `onlyChanged`, the lines that have one. At
 * most `max` lines.
 */
export function viewLines(all: readonly string[], ids: readonly string[], onlyChanged: boolean, max = 400): { lines: ViewLine[]; truncated: boolean } {
  const wanted = [...new Set(ids.filter((id) => id !== ''))].sort((a, b) => b.length - a.length)
  const re = wanted.length > 0 ? new RegExp(wanted.map(escapeRe).join('|'), 'g') : undefined
  const lines: ViewLine[] = []
  let truncated = false
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string
    const parts: ViewLine['parts'] = []
    let last = 0
    if (re) {
      for (const m of line.matchAll(re)) {
        if (m.index > last) parts.push({ text: line.slice(last, m.index) })
        parts.push({ text: m[0], id: m[0] })
        last = m.index + m[0].length
      }
    }
    if (onlyChanged && last === 0) continue
    if (last < line.length || parts.length === 0) parts.push({ text: line.slice(last) })
    if (lines.length >= max) {
      truncated = true
      break
    }
    lines.push({ n: i + 1, parts })
  }
  return { lines, truncated }
}

/** One page of `items`: `page` held within the pages there are, counted from 0. */
export function pageOf<T>(items: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const at = Math.min(Math.max(0, Math.floor(page)), pages - 1)
  return { items: items.slice(at * size, at * size + size), page: at, pages }
}

export type PlaceKey = 'place.system' | 'place.toolResult' | 'place.toolCall' | 'place.user' | 'place.assistant' | 'place.other'

/** What part of the conversation a value was in, read from its place in the request body (docs/adr/0024). */
export function placeKey(at: { path: string; role?: string; type?: string }): PlaceKey {
  const { path, role, type } = at
  const root = path.split('.')[0] ?? ''
  if (role === 'system' || role === 'developer' || root === 'system' || root === 'instructions' || root === 'systemInstruction') return 'place.system'
  if (role === 'tool' || type === 'tool_result' || type === 'function_call_output' || type === 'functionResponse') return 'place.toolResult'
  if (type === 'tool_use' || type === 'function_call' || /(^|\.)(tool_calls|function_call)(\.|$)/.test(path) || path.endsWith('.arguments')) return 'place.toolCall'
  if (role === 'user') return 'place.user'
  if (role === 'assistant' || role === 'model') return 'place.assistant'
  return 'place.other'
}

/**
 * A place as the card names it short: the path's first key and, when the
 * index comes right after it, that index, so `messages.3.content.0.text`
 * reads `messages.3` and a value is found by the message it went in rather
 * than by the whole path (docs/adr/0028). A path whose first key is not a
 * list reads whole, as its key: `systemInstruction.parts.0.text` has no
 * message index, and naming it `systemInstruction.0` would invent one.
 */
export function placeLabel(path: string): string {
  const segs = path.split('.')
  const head = segs[0] ?? ''
  const index = segs[1] ?? ''
  return head !== '' && /^\d+$/.test(index) ? `${head}.${index}` : head
}

/**
 * The line naming the other places a value went, `at` aside, each message
 * once; empty when it went nowhere else. The places past `elsewhereOmitted`
 * are only counted (docs/adr/0028).
 */
export function elsewhereText(v: { elsewhere?: Place[]; elsewhereOmitted?: number }, t: T): string {
  const paths = [...new Set((v.elsewhere ?? []).map((p) => placeLabel(p.path)))].filter((p) => p !== '').join(t('recent.placeSep'))
  const n = v.elsewhereOmitted ?? 0
  if (paths === '') return n > 0 ? t('recent.elsewhereOmitted', { n }) : ''
  return n > 0 ? t('recent.elsewhereMore', { paths, n }) : t('recent.elsewhere', { paths })
}

/** A value's hint as the records keep it: its head, then its tail where the record spared one (docs/adr/0019). */
export function hintOf(v: { head?: string; tail?: string }): string {
  if (!v.head) return ''
  return v.tail ? `${v.head}…${v.tail}` : `${v.head}…`
}

/** One query's answer, as the card reads it (docs/adr/0039). */
export interface QueryState {
  status: 'building' | 'paused' | 'ready' | 'partial' | 'error'
  queryId?: string
  items: QuerySummary[]
  nextCursor?: string
  matched: number
  unmapped: number
  risk: number
  coverage: QueryCoverage
  /** A build that is going asks again after this long; a paused one waits. */
  retryMs?: number
  canResume?: boolean
  reason?: string
  message?: string
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** A count from a row, as a number; anything else is zero. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function querySummaryOf(v: unknown): QuerySummary | undefined {
  const s = obj(v)
  if (!s || typeof s.ref !== 'string' || typeof s.time !== 'string' || typeof s.host !== 'string' || num(s.n) < 1) return undefined
  const turn = num(s.turn)
  const step = num(s.step)
  const key = num(s.key)
  return {
    ref: s.ref,
    ...(key > 0 ? { key } : {}),
    time: s.time,
    ...(turn > 0 && step > 0 ? { turn, step } : {}),
    ...(typeof s.model === 'string' ? { model: s.model } : {}),
    host: s.host,
    from: typeof s.from === 'string' ? s.from : '',
    n: num(s.n),
    restored: num(s.restored),
    unmapped: num(s.unmapped),
    exfil: num(s.exfil),
    failed: s.failed === true,
    evidence: s.evidence === 'kept' || s.evidence === 'unknown' ? s.evidence : 'none',
  }
}

/** The coverage an answer names; anything else reads as a partial disk scan. */
function coverageOf(v: unknown): QueryCoverage {
  const c = obj(v)
  const reasons = Array.isArray(c?.reasons) ? (c?.reasons as unknown[]).filter((r): r is string => typeof r === 'string') : []
  const scan = c?.scan === 'ready' || c?.scan === 'paused' || c?.scan === 'building' ? c.scan : 'partial'
  const storage = c?.storage === 'mixed' || c?.storage === 'memory-only' ? c.storage : 'disk'
  const detection = c?.detection === 'on' || c?.detection === 'off' ? c.detection : 'unknown'
  return { storage, scan, reasons, detection }
}

/** A query answer, or undefined when it is not of the shape this page knows. */
export function readQuery(v: unknown): QueryState | undefined {
  const q = obj(v)
  const status = q?.status
  if (status === 'building' || status === 'paused') {
    if (typeof q?.queryId !== 'string') return undefined
    const retry = num(q.retryMs)
    return {
      status,
      queryId: q.queryId,
      items: [],
      matched: 0,
      unmapped: 0,
      risk: 0,
      coverage: coverageOf(q.coverage),
      ...(retry > 0 ? { retryMs: retry } : {}),
      ...(q.canResume === true ? { canResume: true } : {}),
      ...(typeof q.reason === 'string' ? { reason: q.reason } : {}),
    }
  }
  if (status !== 'ready' && status !== 'partial') return undefined
  const page = obj(q?.page)
  if (!page || typeof page.snapshotId !== 'string' || !Array.isArray(page.items)) return undefined
  const items = page.items.map(querySummaryOf).filter((row): row is QuerySummary => row !== undefined)
  return {
    status,
    items,
    ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
    matched: num(page.matchedRequests) || items.length,
    unmapped: num(page.unmappedOccurrences),
    risk: num(page.riskMatches),
    coverage: coverageOf(page.coverage),
  }
}

/** One stored row as the card shows it, or undefined when it is not one. */
export function readRecordDetail(v: unknown): MaskRecord | undefined {
  const r = obj(v)
  const record = obj(r?.record)
  if (!record || !isRecord(record as unknown as MaskRecord)) return undefined
  const navigation = typeof r?.navigation === 'string' ? r.navigation : undefined
  return { ...(record as unknown as MaskRecord), ...(navigation !== undefined ? { navigation } : {}) } as MaskRecord
}
