/**
 * Whether the config's showPanel is on, followed as it changes (docs/adr/0017):
 * from the settings mirror (configForms) where the host has one, and from the
 * overview the host half answers, asked again every minute.
 */
import { fetchOverview, type ClientCtx } from './rpc.ts'
import { createStore, type Store } from './store.ts'

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
 * SHOW_PANEL_DESCRIPTION, which test/card.test.ts checks holds them): the
 * mirror has only the volatile fields of each schema, and another plugin may
 * have a showPanel of its own.
 */
export const DESCRIPTION_MARK = 'Show the Privacy tab at the top of the session'

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

function asForms(v: unknown): ConfigForms | undefined {
  const f = v as ConfigForms | undefined
  return f !== undefined && f !== null && typeof f.describe === 'function' && typeof f.get === 'function' ? f : undefined
}

/** The settings service, while dsh-client-ui-settings provides it; undefined before it arrives and after it goes. */
export const configForms: Store<ConfigForms | undefined> = createStore<ConfigForms | undefined>(undefined)

/**
 * Follows the `configForms` service into the store above for as long as `ctx`
 * lives. It is asked for through cordis' deferred injection, so the plugin
 * loads without it (the card and the tab need no settings service) and picks
 * it up whenever it arrives or is replaced.
 */
export function followConfigForms(ctx: ClientCtx): void {
  const hold = (scope: ClientCtx): void =>
    scope.effect(() => {
      let forms: ConfigForms | undefined
      try {
        forms = asForms(scope.get('configForms'))
      } catch {
        forms = undefined
      }
      configForms.set(forms)
      return () => {
        if (configForms.get() === forms) configForms.set(undefined)
      }
    }, 'dsh-privacy-gateway: settings service')
  if (typeof ctx.inject === 'function') ctx.inject(['configForms'], hold)
  else hold(ctx)
}

/** How often the host is asked again, to notice a config change made elsewhere. */
const RECHECK_MS = 60_000

/**
 * Whether the tab should be there, from what each source last said
 * (undefined: it has not said yet). With a settings mirror, either saying on
 * is enough and off needs both, since a mirror that has not caught up must
 * not keep the tab away; without one, the host decides.
 */
export function panelDecision(fromHost: boolean | undefined, fromMirror: boolean | undefined): boolean | undefined {
  if (fromMirror === undefined) return fromHost
  if (fromMirror || fromHost === true) return true
  return fromHost === false ? false : undefined
}

/**
 * Calls `onChange` with showPanel now and whenever it changes; returns a
 * function that stops following.
 *
 * The host's own answer (`overview.showPanel`) is the value the gateway runs
 * with; the settings mirror, while there is one, only speeds up "on"
 * (`panelDecision`).
 */
export function watchShowPanel(ctx: ClientCtx, onChange: (on: boolean) => void, forms: Store<ConfigForms | undefined> = configForms): () => void {
  let stopped = false
  let reported: boolean | undefined
  let fromHost: boolean | undefined
  let fromMirror: boolean | undefined
  const settle = (): void => {
    if (stopped) return
    const on = panelDecision(fromHost, fromMirror)
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
  let offMirror: (() => void) | undefined
  const follow = (f: ConfigForms | undefined): void => {
    try {
      offMirror?.()
    } catch {
      // already gone
    }
    offMirror = undefined
    // a mirror that went away says nothing any more: the host decides again
    fromMirror = undefined
    let m: Mirror | undefined
    try {
      m = f?.describe()
    } catch {
      m = undefined
    }
    if (m) {
      const mirror = m
      const read = (): void => {
        if (stopped) return
        const view = mirror.getSnapshot().view
        if (!view) return
        const on = showPanelOf(view.namespaces)
        // an unknown namespace says nothing; only a real reading counts
        if (on === undefined) return
        fromMirror = on
        settle()
      }
      offMirror = mirror.subscribe(read)
      void Promise.resolve(mirror.ensure()).then(read, read)
      read()
    }
    settle()
  }
  const offForms = forms.subscribe(() => follow(forms.get()))
  follow(forms.get())
  askHost()
  const timer = setInterval(askHost, RECHECK_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    offForms()
    try {
      offMirror?.()
    } catch {
      // already gone
    }
  }
}
