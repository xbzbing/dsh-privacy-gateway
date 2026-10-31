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
  /** Namespace revision fencing the next write. */
  readonly revision?: number
}

/** One namespace's live form: its value, and a write of one volatile field (or of several at once). */
export interface ConfigForm {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  mutate?(ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], revision?: number): Promise<boolean>
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

/** How often the host is asked again, to notice a config change made elsewhere. */
const RECHECK_MS = 60_000

/** How often the host is asked again while the panel is on, to notice a config change made elsewhere. */


/**
 * Calls `onChange` with showPanel now and whenever it changes; returns a
 * function that stops following.
 *
 * The host's own answer (`overview.showPanel`) decides, because that is the
 * value the gateway runs with; the settings mirror only speeds up "on", since
 * a mirror that has not caught up must not keep the tab away. A mirror reading
 * of "off" is therefore never reported on its own — it is reported as off only
 * once the host says so too.
 */
export function watchShowPanel(ctx: ClientCtx, onChange: (on: boolean) => void): () => void {
  let stopped = false
  let reported: boolean | undefined
  let fromHost: boolean | undefined
  let fromMirror: boolean | undefined
  const settle = (): void => {
    if (stopped) return
    // either source saying on is enough; off needs both to say so
    const on = fromMirror === true || fromHost === true ? true : fromMirror === false && fromHost === false ? false : undefined
    if (on === undefined || on === reported) return
    reported = on
    onChange(on)
  }
  const askHost = (): void => {
    void fetchOverview(ctx, 1).then((r) => {
      if (stopped || !r.ok) return
      fromHost = r.value.showPanel === true
      settle()
    })
  }
  const forms = formsOf(ctx)
  let mirror: Mirror | undefined
  try {
    mirror = forms?.describe()
  } catch {
    mirror = undefined
  }
  let offMirror: (() => void) | undefined
  if (mirror) {
    const m = mirror
    const read = (): void => {
      const view = m.getSnapshot().view
      if (!view) return
      const on = showPanelOf(view.namespaces)
      // an unknown namespace says nothing; only a real reading counts
      if (on === undefined) return
      fromMirror = on
      settle()
    }
    offMirror = m.subscribe(read)
    void Promise.resolve(m.ensure()).then(read, read)
    read()
  }
  askHost()
  const timer = setInterval(askHost, RECHECK_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    try {
      offMirror?.()
    } catch {
      // already gone
    }
  }
}
