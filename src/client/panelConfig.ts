/**
 * Whether the config's showPanel is on, followed as it changes (docs/adr/0017):
 * from the settings mirror (configForms) where the host has one, else from the
 * overview the host half answers, asked again every minute.
 */
import { fetchOverview, type ClientCtx } from './rpc.ts'

interface NamespaceView {
  readonly ns: string
  readonly schema: unknown
  readonly value?: unknown
}

export interface FormSnapshot {
  readonly status: string
  readonly value?: Record<string, unknown>
  readonly writable?: boolean
}

/** One namespace's live form: its value, and a write of one volatile field. */
export interface ConfigForm {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

export interface Mirror {
  getSnapshot(): { readonly view?: { readonly namespaces: readonly NamespaceView[] } }
  subscribe(listener: () => void): () => void
  ensure(): Promise<void>
}

export interface ConfigForms {
  describe(): Mirror
  get(ns: string): ConfigForm
}

/**
 * The words of showPanel's description (host src/config.ts
 * SHOW_PANEL_DESCRIPTION): the mirror has only the volatile fields of each
 * schema, and another plugin may have a showPanel of its own.
 */
const DESCRIPTION_MARK = 'Show the Privacy panel in the right sidebar'

/**
 * The fields a serialized settings schema declares. schemastery's toJSON()
 * writes a reference table (`{uid, refs}`), not a nested one: the root node is
 * `refs[uid]` and its `dict` holds the field names. A nested `dict` is read
 * too, so a schema that arrives the plain way still works.
 */
export function schemaFields(schema: unknown): string[] {
  const s = schema as { uid?: unknown; refs?: Record<string, unknown>; dict?: Record<string, unknown> } | undefined
  const refs = s?.refs
  const node = refs !== null && typeof refs === 'object' && typeof s?.uid !== 'undefined' ? (refs[String(s.uid)] as { dict?: Record<string, unknown> } | undefined) : undefined
  const dict = (node?.dict ?? s?.dict) as Record<string, unknown> | undefined
  return dict !== null && typeof dict === 'object' ? Object.keys(dict) : []
}

/**
 * The namespace that is this plugin's: it declares showPanel, and its entry id,
 * its other field or showPanel's description says it is ours.
 */
export function findNamespace(namespaces: readonly NamespaceView[]): string | undefined {
  for (const row of namespaces) {
    const fields = schemaFields(row.schema)
    if (!fields.includes('showPanel')) continue
    if (row.ns.includes('privacy-gateway') || fields.includes('excludeProviders')) return row.ns
    if (JSON.stringify(row.schema ?? null).includes(DESCRIPTION_MARK)) return row.ns
  }
  return undefined
}

/** showPanel in the namespace that is ours; undefined when there is none. */
export function showPanelOf(namespaces: readonly NamespaceView[]): boolean | undefined {
  const ns = findNamespace(namespaces)
  if (ns === undefined) return undefined
  const v = namespaces.find((row) => row.ns === ns)?.value as { showPanel?: unknown } | undefined
  return typeof v === 'object' && v !== null && v.showPanel === true
}

export function formsOf(ctx: ClientCtx): ConfigForms | undefined {
  try {
    const f = ctx.get('configForms') as ConfigForms | undefined
    return f !== undefined && typeof f.describe === 'function' ? f : undefined
  } catch {
    return undefined
  }
}

const POLL_MS = 60_000

/** Calls `onChange` with showPanel now and whenever it changes; returns a function that stops following. */
export function watchShowPanel(ctx: ClientCtx, onChange: (on: boolean) => void): () => void {
  let stopped = false
  let current: boolean | undefined
  const report = (on: boolean | undefined): void => {
    if (stopped || on === undefined || on === current) return
    current = on
    onChange(on)
  }
  const forms = formsOf(ctx)
  let mirror: Mirror | undefined
  try {
    mirror = forms?.describe()
  } catch {
    mirror = undefined
  }
  if (mirror) {
    const m = mirror
    const read = (): void => {
      const view = m.getSnapshot().view
      if (view) report(showPanelOf(view.namespaces))
    }
    const off = m.subscribe(read)
    read()
    // a mirror without this plugin's namespace in it: the host half answers instead
    const fallback = (): void => {
      if (current === undefined && !stopped) {
        void fetchOverview(ctx, 1).then((r) => {
          if (r.ok && current === undefined) report(r.value.showPanel === true)
        })
      }
    }
    void Promise.resolve(m.ensure()).then(
      () => {
        read()
        fallback()
      },
      fallback,
    )
    return () => {
      stopped = true
      try {
        off()
      } catch {
        // already gone
      }
    }
  }
  const ask = (): void => {
    void fetchOverview(ctx, 1).then((r) => {
      if (r.ok) report(r.value.showPanel === true)
    })
  }
  ask()
  const timer = setInterval(ask, POLL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
