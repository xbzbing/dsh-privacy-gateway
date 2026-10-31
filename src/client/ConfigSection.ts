/**
 * This plugin's configuration, drawn in two official places from one component
 * (docs/adr/0017, docs/adr/0018):
 *  - the bundle's detail page (`plugins.bundle.config`), inline, where the
 *    entry's form is taken from the settings mirror;
 *  - the plugin manager's row page (`plugins.row.config`), which hands the
 *    entry's `form` over itself.
 * Both write through the same revision-aware `mutate`, one write at a time
 * (writeQueue.ts), and both use the Web shell's own controls (configControls.ts).
 *
 * The fields are the everyday ones (fields.ts, docs/adr/0021), all volatile:
 * a change applies from the next model request, without remounting the plugin.
 * A change that sends content as it is or deletes kept data is confirmed
 * first, with the shell's RiskConfirmation.
 * Each group folds; a folded group's header says its state, and which groups
 * are open is kept in this browser.
 */
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { CountField, Fold, ListEditor, Row, Select, SwitchControl } from './configControls.ts'
import { choiceValue, countValue, FIELDS, GROUPS, groupSummary, inline, listValue, pickedSummary, riskOf, switchValue, type FieldSpec, type GroupId, type RiskyChange } from './fields.ts'
import type { Key, T } from './locales.ts'
import { configForms, findNamespace } from './panelConfig.ts'
import { excludeChoices, toggleExcluded } from './providerChoice.ts'
import { fetchProviders, type ClientCtx, type ProviderEntry } from './rpc.ts'
import { panelFailure, panelFailureText } from './sidebar.ts'
import { WriteQueue, type QueueState } from './writeQueue.ts'

/** One path-addressed write, as the settings service takes it. */
interface FieldOp {
  op: 'set'
  path: readonly string[]
  value: unknown
}

/** The page's form, as `plugins.row.config` hands it over. */
export interface RowForm {
  state: { status: string; value?: Record<string, unknown>; revision?: number; writable: boolean }
  mutate(ops: readonly FieldOp[], revision?: number): Promise<boolean>
}

/** The entry's form found in the settings mirror, for the copy of this page that gets no `form` prop. */
function useMirrorForm(): RowForm | undefined {
  const [, bump] = useState(0)
  const forms = useSyncExternalStore(configForms.subscribe, configForms.get)
  const mirror = useMemo(() => {
    try {
      return forms?.describe()
    } catch {
      return undefined
    }
  }, [forms])
  useEffect(() => {
    if (!mirror) return
    void Promise.resolve(mirror.ensure()).catch(() => {})
    return mirror.subscribe(() => bump((n) => n + 1))
  }, [mirror])
  const view = mirror?.getSnapshot().view
  const ns = useMemo(() => (view ? findNamespace(view.namespaces) : undefined), [view])
  const form = useMemo(() => {
    try {
      return forms && ns !== undefined ? forms.get(ns) : undefined
    } catch {
      return undefined
    }
  }, [forms, ns])
  useEffect(() => (form ? form.subscribe(() => bump((n) => n + 1)) : undefined), [form])
  // the form's snapshot keeps its identity until it changes, so it is the memo's key
  const snap = form?.getSnapshot()
  return useMemo(() => {
    if (!form || !snap) return undefined
    const mutate = form.mutate
    const write = mutate
      ? (ops: readonly FieldOp[], revision?: number) => mutate.call(form, ops, revision)
      : async (ops: readonly FieldOp[]): Promise<boolean> => {
          // a form without the batch call: one field at a time, which is all this page writes
          for (const op of ops) if (!(await form.set(op.path.join('.'), op.value))) return false
          return true
        }
    return { state: { status: snap.status, value: snap.value, revision: snap.revision, writable: snap.writable !== false }, mutate: write }
  }, [form, snap])
}

/** Where the open groups are kept, so the page comes back as it was left. */
const OPEN_KEY = 'dsh-privacy-gateway.config.open'

/** The groups open on first visit: the masking switches. */
const FIRST_OPEN: readonly GroupId[] = ['mask']

function readOpen(): GroupId[] {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? 'null')
    if (Array.isArray(raw)) return GROUPS.filter((g) => raw.includes(g))
  } catch {
    // unreadable or unavailable storage: start as on a first visit
  }
  return [...FIRST_OPEN]
}

function writeOpen(open: readonly GroupId[]): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(open))
  } catch {
    // storage full or blocked: the page still folds, it just forgets
  }
}

/** Locale keys built from a field's name (they all exist: test/fields.test.ts checks them). */
const key = (s: string): Key => s as Key

/** A change waiting on its confirmation, and how to tell its caller whether it was written. */
interface Asking {
  f: FieldSpec
  next: unknown
  change: RiskyChange
  resolve(ok: boolean): void
}

export function ConfigSection(props: { ctx: ClientCtx; t: T; form?: RowForm }): ReactNode {
  const { ctx, t } = props
  const mirrored = useMirrorForm()
  const form = props.form ?? mirrored
  // the queue sends with the form as it is when each write goes, not as it was when it was queued
  const formRef = useRef(form)
  formRef.current = form
  const [queueState, setQueueState] = useState<QueueState>({ busy: false, failed: false })
  const [queue] = useState(
    () =>
      new WriteQueue((path, value, followOn) => {
        const f = formRef.current
        if (!f) return Promise.resolve(false)
        // the first write is fenced by the revision the page read; the ones queued behind it by the latest
        return f.mutate([{ op: 'set', path: [path], value }], followOn ? undefined : f.state.revision)
      }, setQueueState),
  )
  const [asking, setAsking] = useState<Asking | null>(null)
  const [ack, setAck] = useState(false)
  const failure = useSyncExternalStore(panelFailure.subscribe, panelFailure.get)
  const ids = useId()
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [open, setOpen] = useState<GroupId[]>(readOpen)
  const toggle = (g: GroupId): void =>
    setOpen((was) => {
      const next = was.includes(g) ? was.filter((x) => x !== g) : GROUPS.filter((x) => x === g || was.includes(x))
      writeOpen(next)
      return next
    })
  const state = form?.state
  const ready = state?.status === 'ready'
  const writable = state?.writable !== false
  const saved = state?.value ?? {}
  // what each field shows and the next change starts from: the saved value, or the one still on its way
  const value = (k: FieldSpec['key']): unknown => queue.latest(k, saved[k])
  useEffect(() => {
    const abort = new AbortController()
    void fetchProviders(ctx, abort.signal).then((r) => {
      if (abort.signal.aborted) return
      setUnavailable(!r.ok)
      setProviders(r.ok ? r.value : [])
    })
    return () => abort.abort()
  }, [ctx])
  if (!form) return h('div', { className: 'pgw-empty' }, t('cfg.unavailable'))
  const disabled = !ready || !writable
  const providerName = (id: string): string => providers?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.name ?? id
  /** Writes `next` to `f`, asking first when the change is a risky one; resolves with whether it was written. */
  const write = (f: FieldSpec, next: unknown): Promise<boolean> => {
    if (disabled) return Promise.resolve(false)
    const change = riskOf(f, value(f.key), next)
    if (!change) return queue.write(f.key, next)
    return new Promise((resolve) => {
      setAck(false)
      setAsking((was) => {
        // a newer risky change replaces one still being asked about
        was?.resolve(false)
        return { f, next, change, resolve }
      })
    })
  }
  const closeAsking = (ok: boolean): void => {
    const a = asking
    setAsking(null)
    setAck(false)
    if (!a) return
    if (ok) void queue.write(a.f.key, a.next).then(a.resolve)
    else a.resolve(false)
  }
  const control = (f: FieldSpec): ReactNode => {
    const title = t(key(`cfg.f.${f.key}`))
    switch (f.kind) {
      case 'switch':
        return h(SwitchControl, { label: title, checked: switchValue(value(f.key), f.default), disabled, onChange: (next) => void write(f, next) })
      case 'choice': {
        const now = choiceValue(value(f.key), f.choices, f.default)
        return h(Select, {
          label: t(key(`cfg.f.${f.key}.${now}`)),
          labelledBy: `${ids}${f.key}`,
          items: f.choices.map((c) => ({ id: c, label: t(key(`cfg.f.${f.key}.${c}`)) })),
          selectedId: now,
          disabled,
          onSelect: (id) => {
            if (id !== now) void write(f, id)
          },
        })
      }
      case 'list':
        return h(ListEditor, { t, list: listValue(value(f.key), f.default), anyCase: f.anyCase, placeholder: t(key(`cfg.f.${f.key}.placeholder`)), disabled, onChange: (next) => write(f, next) })
      case 'count':
        return h(CountField, { t, value: countValue(value(f.key), f.min, f.default), min: f.min, label: title, disabled, onChange: (next) => write(f, next) })
      case 'providers':
        return providerSelect(f)
    }
  }
  const providerSelect = (f: FieldSpec): ReactNode => {
    const excluded = listValue(value(f.key), [])
    const rows = excludeChoices(providers ?? [], excluded)
    const names = rows.filter((r) => r.excluded).map((r) => r.name)
    const summary = pickedSummary(names, t('cfg.sep'))
    const label = summary.kind === 'none' ? t('cfg.excludedNone') : summary.kind === 'some' ? summary.names : t('cfg.excludedMany', { names: summary.names, n: summary.n })
    return h(Select, {
      label,
      labelledBy: `${ids}${f.key}`,
      multi: true,
      // an excluded id without an adapter stays listed so it can be unchecked
      items: rows.map((r) => ({ id: r.id, label: r.registered ? r.name : t('cfg.providerAbsent', { name: r.name }) })),
      selectedIds: rows.filter((r) => r.excluded).map((r) => r.id),
      disabled,
      // each tick starts from the choice as it will be once the ticks before it are saved
      onSelect: (id) => void write(f, toggleExcluded(listValue(value(f.key), []), id)),
    })
  }
  const note = (f: FieldSpec): ReactNode => {
    // why the tab would not appear, said where the switch is (docs/adr/0017)
    if (f.key === 'showPanel' && failure) return h('div', { className: 'pgw-cfg__desc pgw-cfg__desc--error' }, t('cfg.sidebarFailed', { reason: panelFailureText(failure, t) }))
    if (f.key === 'excludeProviders' && unavailable) return h('div', { className: 'pgw-cfg__desc pgw-cfg__desc--error' }, t('cfg.providerListUnavailable'))
    return undefined
  }
  const shown = Object.fromEntries(FIELDS.map((f) => [f.key, value(f.key)]))
  const group = (g: GroupId): ReactNode => {
    const fields = FIELDS.filter((f) => f.group === g)
    const name = t(key(`cfg.g.${g}`))
    const isOpen = open.includes(g)
    const parts = groupSummary(g, shown)
    const problem = fields.some((f) => note(f) !== undefined)
    const summary = ready
      ? [
          ...parts.map((p, i) => h('span', { key: i, className: p.off ? 'pgw-fold__part pgw-fold__part--off' : 'pgw-fold__part' }, t(key(p.key), p.params))),
          problem ? h('span', { key: 'problem', className: 'pgw-fold__part pgw-fold__part--error' }, t('cfg.s.problem')) : null,
        ]
      : null
    return h(
      Fold,
      { key: g, title: name, summary, open: isOpen, toggleLabel: t(isOpen ? 'cfg.collapse' : 'cfg.expand', { name }), onToggle: () => toggle(g) },
      fields.map((f) =>
        h(Row, { key: f.key, title: t(key(`cfg.f.${f.key}`)), titleId: `${ids}${f.key}`, hint: t(key(`cfg.f.${f.key}.hint`)), note: note(f), inline: inline(f), half: f.half === true }, control(f)),
      ),
    )
  }
  const confirm = asking ? riskWords(asking, t, asking.f.key === 'excludeProviders' ? providerName : (x) => x) : null
  return h(
    Fragment,
    null,
    h(
      'section',
      { className: 'pgw-cfg', 'aria-busy': queueState.busy || undefined },
      // the row page carries its own heading; the inline section on the bundle page needs one
      props.form ? null : h('h3', { className: 'pgw-title' }, t('cfg.title')),
      queueState.failed ? h('div', { className: 'pgw-notice pgw-notice--error', role: 'alert' }, t('cfg.failed')) : null,
      h('div', { className: 'pgw-cfg__folds' }, GROUPS.map(group)),
      h('p', { className: 'pgw-cfg__desc pgw-cfg__foot' }, t('cfg.applies'), ' ', t('cfg.others')),
    ),
    h(RiskConfirmation, {
      open: asking !== null,
      title: confirm?.title ?? '',
      description: confirm?.body ?? '',
      acknowledgeLabel: confirm?.ack ?? '',
      cancelLabel: t('card.cancel'),
      closeLabel: t('card.close'),
      confirmLabel: t('cfg.risk.confirm'),
      acknowledged: ack,
      onAcknowledgedChange: setAck,
      onCancel: () => closeAsking(false),
      onConfirm: () => closeAsking(true),
    }),
  )
}

/** The confirmation's words for a risky change: what it costs, in general and for this field. */
function riskWords(a: Asking, t: T, name: (entry: string) => string): { title: string; body: string; ack: string } {
  const { change } = a
  const params: Record<string, string | number> = {}
  if (change.added) params.names = change.added.map(name).join(t('cfg.sep'))
  if (change.from !== undefined) params.from = change.from
  if (change.to !== undefined) params.to = change.to
  return {
    title: t(change.risk === 'send' ? 'cfg.risk.send.title' : 'cfg.risk.delete.title'),
    body: t(key(`cfg.r.${a.f.key}`), params),
    ack: t(change.risk === 'send' ? 'cfg.risk.send.ack' : 'cfg.risk.delete.ack'),
  }
}
