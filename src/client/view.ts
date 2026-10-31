/**
 * What the card shows, worked out from an overview: no DOM, no React, so the
 * unit tests run it as it is.
 */
import type { Overview } from '../remote.ts'
import type { Totals } from '../records.ts'

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

export type WarningKey = 'warn.streak' | 'warn.unmapped' | 'warn.inTools'

/** The signals worth a line of their own (design §7.3), for the range shown. */
export function warnings(o: Overview, t: Totals): Array<{ key: WarningKey; n: number; tone: 'error' | 'warn' }> {
  const out: Array<{ key: WarningKey; n: number; tone: 'error' | 'warn' }> = []
  if (o.stats.failStreak > 0) out.push({ key: 'warn.streak', n: o.stats.failStreak, tone: 'error' })
  if (t.unmapped > 0) out.push({ key: 'warn.unmapped', n: t.unmapped, tone: 'warn' })
  if (t.restoredInTools > 0) out.push({ key: 'warn.inTools', n: t.restoredInTools, tone: 'warn' })
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

/** Whether `o` reads as an overview (the host half answered, of a version this card knows). */
export function isOverview(o: unknown): o is Overview {
  const v = o as Partial<Overview> | null
  return typeof v === 'object' && v !== null && typeof v.active === 'boolean' && typeof v.stats === 'object' && v.stats !== null && Array.isArray(v.recent)
}
