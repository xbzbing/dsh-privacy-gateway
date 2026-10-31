/**
 * The settings the configuration page edits, described once so the page and
 * its test agree on names, kinds and defaults (docs/adr/0021). The client half
 * does not import the host's schema (it would pull schemastery into the page),
 * so test/fields.test.ts checks these defaults against `defaults` in config.ts,
 * and that each field is volatile there: the settings service writes only
 * volatile fields, and the plugin applies them without remounting.
 *
 * The rest (actions, cookieNames, cookieKeep, protectEnvBlock, protectTools,
 * excludeHosts, maxValues, keepMegabytes, keepRecords) stay in cordis.patch.yml:
 * they are for the person wiring the gateway, not for everyday use.
 */

export type GroupId = 'mask' | 'lists' | 'record' | 'view'

interface Base<K extends string> {
  key: K
  group: GroupId
}

export type FieldSpec =
  | (Base<'enabled' | 'secrets' | 'personal' | 'shape' | 'record' | 'vendorView' | 'showPanel'> & { kind: 'switch'; default: boolean })
  | (Base<'toolGuard'> & { kind: 'choice'; choices: readonly string[]; default: string })
  | (Base<'words' | 'allow'> & { kind: 'list'; default: readonly string[]; anyCase: boolean })
  | (Base<'keepDays'> & { kind: 'count'; min: number; default: number })
  | (Base<'excludeProviders'> & { kind: 'providers'; default: readonly string[] })

export const GROUPS: readonly GroupId[] = ['mask', 'lists', 'record', 'view']

export const FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', group: 'mask', kind: 'switch', default: true },
  { key: 'secrets', group: 'mask', kind: 'switch', default: true },
  { key: 'personal', group: 'mask', kind: 'switch', default: false },
  { key: 'shape', group: 'mask', kind: 'switch', default: false },
  { key: 'toolGuard', group: 'mask', kind: 'choice', choices: ['off', 'warn', 'block'], default: 'off' },
  // words are matched as written, allow in any case (README, config.ts)
  { key: 'words', group: 'lists', kind: 'list', default: [], anyCase: false },
  { key: 'allow', group: 'lists', kind: 'list', default: [], anyCase: true },
  { key: 'record', group: 'record', kind: 'switch', default: true },
  { key: 'keepDays', group: 'record', kind: 'count', min: 1, default: 30 },
  { key: 'vendorView', group: 'record', kind: 'switch', default: false },
  { key: 'showPanel', group: 'view', kind: 'switch', default: false },
  { key: 'excludeProviders', group: 'view', kind: 'providers', default: [] },
]

/** A switch's value in the form, its default when unset or not a boolean. */
export function switchValue(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** A choice's value in the form, its default when unset or not one of the choices. */
export function choiceValue(v: unknown, choices: readonly string[], fallback: string): string {
  return typeof v === 'string' && choices.includes(v) ? v : fallback
}

/** A list's entries in the form, its default when unset. */
export function listValue(v: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...fallback]
}

/** A count's value in the form, its default when unset or below the minimum. */
export function countValue(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback
}

/** `list` with `raw` added, trimmed; undefined when it is empty or already there. */
export function addEntry(list: readonly string[], raw: string, anyCase: boolean): string[] | undefined {
  const entry = raw.trim()
  if (entry === '') return undefined
  const same = anyCase ? (x: string) => x.trim().toLowerCase() === entry.toLowerCase() : (x: string) => x.trim() === entry
  return list.some(same) ? undefined : [...list, entry]
}

/** `list` without `entry`. */
export function removeEntry(list: readonly string[], entry: string): string[] {
  return list.filter((x) => x !== entry)
}

/** A typed count: a whole number at least `min`, else undefined. */
export function parseCount(raw: string, min: number): number | undefined {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) && n >= min ? n : undefined
}

/** What the provider picker's button says: none, up to two names, or two names and the count. */
export function pickedSummary(names: readonly string[], sep: string): { kind: 'none' } | { kind: 'some'; names: string } | { kind: 'many'; names: string; n: number } {
  if (names.length === 0) return { kind: 'none' }
  if (names.length <= 2) return { kind: 'some', names: names.join(sep) }
  return { kind: 'many', names: names.slice(0, 2).join(sep), n: names.length }
}
