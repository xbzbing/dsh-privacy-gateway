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

/**
 * What a change to a field can cost, asked about before it is written (as the
 * session switch asks, docs/adr/0023): `send`, content goes to the model
 * service as it is; `delete`, kept data is thrown away. Which way of changing
 * the field is the risky one follows from its kind (`riskOf`).
 */
export type Risk = 'send' | 'delete'

interface Base<K extends string> {
  key: K
  group: GroupId
  /** Takes one of the group's two columns when the page is wide enough; otherwise the whole width. */
  half?: true
  risk?: Risk
}

export type FieldSpec =
  | (Base<'enabled' | 'secrets' | 'personal' | 'shape' | 'maskKeys' | 'record' | 'recordContext' | 'vendorView' | 'showPanel'> & { kind: 'switch'; default: boolean })
  | (Base<'toolGuard'> & { kind: 'choice'; choices: readonly string[]; default: string })
  | (Base<'words' | 'allow'> & { kind: 'list'; default: readonly string[]; anyCase: boolean; risky: 'add' | 'remove' })
  | (Base<'keepDays'> & { kind: 'count'; min: number; default: number })
  | (Base<'excludeProviders'> & { kind: 'providers'; default: readonly string[] })

export const GROUPS: readonly GroupId[] = ['mask', 'lists', 'record', 'view']

export const FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', group: 'mask', kind: 'switch', default: true, risk: 'send' },
  { key: 'secrets', group: 'mask', kind: 'switch', default: true, half: true, risk: 'send' },
  { key: 'personal', group: 'mask', kind: 'switch', default: false, half: true, risk: 'send' },
  { key: 'shape', group: 'mask', kind: 'switch', default: false, half: true },
  { key: 'toolGuard', group: 'mask', kind: 'choice', choices: ['off', 'warn', 'block'], default: 'off', half: true },
  // keys travel to the vendor too: off sends a secret used as a key as it is (docs/adr/0029)
  { key: 'maskKeys', group: 'mask', kind: 'switch', default: true, risk: 'send' },
  // words are matched as written, allow in any case (README, config.ts)
  // a word taken out of words, like a value put into allow, goes as it is from then on
  { key: 'words', group: 'lists', kind: 'list', default: [], anyCase: false, half: true, risk: 'send', risky: 'remove' },
  { key: 'allow', group: 'lists', kind: 'list', default: [], anyCase: true, half: true, risk: 'send', risky: 'add' },
  // off drops the records still waiting to be written; fewer days deletes the older day files
  { key: 'record', group: 'record', kind: 'switch', default: true, half: true, risk: 'delete' },
  { key: 'keepDays', group: 'record', kind: 'count', min: 1, default: 30, half: true, risk: 'delete' },
  { key: 'recordContext', group: 'record', kind: 'switch', default: true },
  // off clears the copies kept so far
  { key: 'vendorView', group: 'record', kind: 'switch', default: false, risk: 'delete' },
  { key: 'showPanel', group: 'view', kind: 'switch', default: false },
  { key: 'excludeProviders', group: 'view', kind: 'providers', default: [], risk: 'send' },
]

/** A change that needs confirming: its risk, and what the confirmation names (the entries added or taken out, or the counts before and after). */
export interface RiskyChange {
  risk: Risk
  added?: string[]
  removed?: string[]
  from?: number
  to?: number
}

/**
 * Whether changing `f` from `before` to `after` needs confirming: a switch
 * turned off, a provider choice that gains an entry, a list that gains or
 * loses one (as its `risky` says), a count made smaller. Both values are the form's, read with the field's default.
 */
export function riskOf(f: FieldSpec, before: unknown, after: unknown): RiskyChange | undefined {
  if (!f.risk) return undefined
  switch (f.kind) {
    case 'switch':
      return switchValue(before, f.default) && !switchValue(after, f.default) ? { risk: f.risk } : undefined
    case 'list':
    case 'providers': {
      // provider ids, like allow values, match in any case
      const anyCase = f.kind === 'providers' || f.anyCase
      const norm = (x: string): string => (anyCase ? x.trim().toLowerCase() : x.trim())
      const diff = (from: readonly string[], to: readonly string[]): string[] => {
        const had = new Set(from.map(norm))
        return to.filter((x) => !had.has(norm(x)))
      }
      const old = listValue(before, f.default)
      const now = listValue(after, f.default)
      if (f.kind === 'list' && f.risky === 'remove') {
        const removed = diff(now, old)
        return removed.length > 0 ? { risk: f.risk, removed } : undefined
      }
      const added = diff(old, now)
      return added.length > 0 ? { risk: f.risk, added } : undefined
    }
    case 'count': {
      const from = countValue(before, f.min, f.default)
      const to = countValue(after, f.min, f.default)
      return to < from ? { risk: f.risk, from, to } : undefined
    }
    case 'choice':
      return undefined
  }
}

/** Whether a field's control sits beside its words (a switch, a choice, a count) or below them (a list, the provider picker). */
export function inline(f: FieldSpec): boolean {
  return f.kind === 'switch' || f.kind === 'choice' || f.kind === 'count'
}

/** The field with this key and kind; every pair named here is in FIELDS. */
function spec<Kind extends FieldSpec['kind']>(k: FieldSpec['key'], kind: Kind): Extract<FieldSpec, { kind: Kind }> {
  const f = FIELDS.find((x) => x.key === k && x.kind === kind)
  if (!f) throw new Error(`no ${kind} field ${k}`)
  return f as Extract<FieldSpec, { kind: Kind }>
}

/** One piece of a folded group's one-line summary: a locale key, its parameters, and whether it reads as off. */
export interface SummaryPart {
  key: string
  params?: Record<string, string | number>
  off?: true
}

/** What a group's header says while it is folded, so the page can stay short without hiding the state. */
export function groupSummary(g: GroupId, value: Record<string, unknown>): SummaryPart[] {
  const on = (k: 'enabled' | 'secrets' | 'personal' | 'shape' | 'record' | 'vendorView' | 'showPanel'): boolean => switchValue(value[k], spec(k, 'switch').default)
  switch (g) {
    case 'mask': {
      if (!on('enabled')) return [{ key: 'cfg.s.maskOff', off: true }]
      const kinds = (['secrets', 'personal'] as const).filter(on)
      const parts: SummaryPart[] = kinds.length === 0 ? [{ key: 'cfg.s.maskNothing', off: true }] : kinds.map((k) => ({ key: `cfg.s.${k}` }))
      if (on('shape')) parts.push({ key: 'cfg.s.shape' })
      const guard = spec('toolGuard', 'choice')
      parts.push({ key: `cfg.s.toolGuard.${choiceValue(value.toolGuard, guard.choices, guard.default)}` })
      return parts
    }
    case 'lists':
      return [
        { key: 'cfg.s.words', params: { n: listValue(value.words, spec('words', 'list').default).length } },
        { key: 'cfg.s.allow', params: { n: listValue(value.allow, spec('allow', 'list').default).length } },
      ]
    case 'record': {
      const days = spec('keepDays', 'count')
      const parts: SummaryPart[] = on('record') ? [{ key: 'cfg.s.record', params: { n: countValue(value.keepDays, days.min, days.default) } }] : [{ key: 'cfg.s.recordOff', off: true }]
      if (on('vendorView')) parts.push({ key: 'cfg.s.vendorView' })
      return parts
    }
    case 'view': {
      const n = listValue(value.excludeProviders, spec('excludeProviders', 'providers').default).length
      return [on('showPanel') ? { key: 'cfg.s.panel' } : { key: 'cfg.s.panelOff', off: true }, n === 0 ? { key: 'cfg.s.providersAll' } : { key: 'cfg.s.providersSome', params: { n } }]
    }
  }
}

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
