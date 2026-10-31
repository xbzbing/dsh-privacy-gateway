/** The rows of the excludeProviders choice on the detail page (docs/adr/0018). */
import type { ProviderEntry } from './rpc.ts'

export interface ProviderChoice {
  id: string
  name: string
  excluded: boolean
  /** The provider has an adapter now; an excluded id without one stays listed so it can be taken off. */
  registered: boolean
}

/** Every provider with an adapter, then every excluded id that has none; ids match in any case. */
export function excludeChoices(providers: readonly ProviderEntry[], excluded: readonly string[]): ProviderChoice[] {
  const has = (id: string): boolean => excluded.some((e) => e.toLowerCase() === id.toLowerCase())
  const rows: ProviderChoice[] = providers.map((p) => ({ id: p.id, name: p.name, excluded: has(p.id), registered: true }))
  for (const e of excluded) {
    if (!rows.some((r) => r.id.toLowerCase() === e.toLowerCase())) rows.push({ id: e, name: e, excluded: true, registered: false })
  }
  return rows
}

/** `excluded` with `id` taken off when it is there (in any case), else added. */
export function toggleExcluded(excluded: readonly string[], id: string): string[] {
  const k = id.toLowerCase()
  return excluded.some((e) => e.toLowerCase() === k) ? excluded.filter((e) => e.toLowerCase() !== k) : [...excluded, id]
}
