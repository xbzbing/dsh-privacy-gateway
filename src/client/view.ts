/**
 * What the card shows, worked out from an overview: no DOM, no React, so the
 * unit tests run it as it is.
 */
import type { Overview } from '../remote.ts'
import type { MaskRecord, Place, Totals, ValueRecord } from '../records.ts'
import type { T } from './locales.ts'
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

/** The finders the table knows by name; a record of another version may say one it does not. */
const FINDERS = ['rule', 'word', 'known', 'cookie'] as const satisfies readonly ValueRecord['finder'][]

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
    finder: FINDERS.find((f) => f === v.finder) ?? 'rule',
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
  const { valuesOmitted, turn, step, ...rest } = r
  const omitted = count(valuesOmitted)
  const at = stepOf({ turn, step })
  return {
    ...rest,
    n: count(r.n),
    restored: count(r.restored),
    unmapped: count(r.unmapped),
    values: r.values.map(readValue).filter((v): v is ValueRecord => v !== undefined),
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
  return {
    ...(o as unknown as Overview),
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
