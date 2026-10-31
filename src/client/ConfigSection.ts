/**
 * This plugin's configuration, drawn in two official places from one component
 * (docs/adr/0017, docs/adr/0018):
 *  - the bundle's detail page (`plugins.bundle.config`), inline, where the
 *    entry's form is taken from the settings mirror;
 *  - the plugin manager's row page (`plugins.row.config`), which hands the
 *    entry's `form` over itself.
 * Both write through the same revision-aware `mutate`, and both use the Web
 * shell's own controls (configControls.ts).
 *
 * The fields are the everyday ones (fields.ts, docs/adr/0021), all volatile:
 * a change applies from the next model request, without remounting the plugin.
 * Each group folds; a folded group's header says its state, and which groups
 * are open is kept in this browser.
 */
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { CountField, Fold, ListEditor, Row, Select, SwitchControl } from './configControls.ts'
import { choiceValue, countValue, FIELDS, GROUPS, groupSummary, inline, listValue, pickedSummary, switchValue, type FieldSpec, type GroupId } from './fields.ts'
import type { Key, T } from './locales.ts'
import { findNamespace, formsOf } from './panelConfig.ts'
import { lastFailure } from './sidebar.ts'
import { excludeChoices, toggleExcluded } from './providerChoice.ts'
import { fetchProviders, type ClientCtx, type ProviderEntry } from './rpc.ts'

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
function useMirrorForm(ctx: ClientCtx): RowForm | undefined {
  const [tick, bump] = useState(0)
  const forms = useMemo(() => formsOf(ctx), [ctx])
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
  void tick
  const snap = form?.getSnapshot()
  return useMemo(() => {
    if (!form) return undefined
    const mutate = form.mutate
    const write = mutate
      ? (ops: readonly FieldOp[], revision?: number) => mutate.call(form, ops, revision)
      : async (ops: readonly FieldOp[]): Promise<boolean> => {
          // a form without the batch call: one field at a time, which is all this page writes
          for (const op of ops) if (!(await form.set(op.path.join('.'), op.value))) return false
          return true
        }
    const state = form.getSnapshot()
    return { state: { status: state.status, value: state.value, revision: state.revision, writable: state.writable !== false }, mutate: write }
  }, [form, write0(snap)])
}

/** A stable re-render key for the mirror's snapshot, so the memo above re-runs when it changes. */
function write0(snap: { status: string; revision?: number } | undefined): string {
  return snap ? `${snap.status}:${snap.revision ?? ''}` : ''
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

export function ConfigSection(props: { ctx: ClientCtx; t: T; form?: RowForm }): ReactNode {
  const { ctx, t } = props
  const mirrored = useMirrorForm(ctx)
  const form = props.form ?? mirrored
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
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
  const value = state?.value ?? {}
  useEffect(() => {
    const abort = new AbortController()
    void fetchProviders(ctx, abort.signal).then((r) => {
      if (abort.signal.aborted) return
      setUnavailable(!r.ok)
      setProviders(r.ok ? r.providers : [])
    })
    return () => abort.abort()
  }, [ctx])
  if (!form) return h('div', { className: 'pgw-empty' }, t('cfg.unavailable'))
  const disabled = !ready || busy || !writable
  const write = (path: string, next: unknown): void => {
    if (disabled) return
    setBusy(true)
    setFailed(false)
    void form.mutate([{ op: 'set', path: [path], value: next }], form.state.revision).then(
      (ok) => {
        setBusy(false)
        if (!ok) setFailed(true)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }
  const control = (f: FieldSpec): ReactNode => {
    const title = t(key(`cfg.f.${f.key}`))
    switch (f.kind) {
      case 'switch':
        return h(SwitchControl, { label: title, checked: switchValue(value[f.key], f.default), disabled, onChange: (next) => write(f.key, next) })
      case 'choice': {
        const now = choiceValue(value[f.key], f.choices, f.default)
        return h(Select, {
          label: t(key(`cfg.f.${f.key}.${now}`)),
          items: f.choices.map((c) => ({ id: c, label: t(key(`cfg.f.${f.key}.${c}`)) })),
          selectedId: now,
          disabled,
          onSelect: (id) => {
            if (id !== now) write(f.key, id)
          },
        })
      }
      case 'list':
        return h(ListEditor, { t, list: listValue(value[f.key], f.default), anyCase: f.anyCase, placeholder: t(key(`cfg.f.${f.key}.placeholder`)), disabled, onChange: (next) => write(f.key, next) })
      case 'count':
        return h(CountField, { t, value: countValue(value[f.key], f.min, f.default), min: f.min, label: title, disabled, onChange: (next) => write(f.key, next) })
      case 'providers':
        return providerSelect(listValue(value[f.key], f.default))
    }
  }
  const providerSelect = (excluded: string[]): ReactNode => {
    const rows = excludeChoices(providers ?? [], excluded)
    const names = rows.filter((r) => r.excluded).map((r) => r.name)
    const summary = pickedSummary(names, t('cfg.sep'))
    const label = summary.kind === 'none' ? t('cfg.excludedNone') : summary.kind === 'some' ? summary.names : t('cfg.excludedMany', { names: summary.names, n: summary.n })
    return h(Select, {
      label,
      multi: true,
      // an excluded id without an adapter stays listed so it can be unchecked
      items: rows.map((r) => ({ id: r.id, label: r.registered ? r.name : `${r.name}（${t('cfg.providerAbsent')}）` })),
      selectedIds: rows.filter((r) => r.excluded).map((r) => r.id),
      disabled,
      onSelect: (id) => write('excludeProviders', toggleExcluded(excluded, id)),
    })
  }
  const note = (f: FieldSpec): ReactNode => {
    // why the tab would not appear, said where the switch is (docs/adr/0017)
    if (f.key === 'showPanel' && lastFailure) return h('div', { className: 'pgw-cfg__desc pgw-cfg__desc--error' }, `${t('cfg.sidebarFailed')} ${lastFailure}`)
    if (f.key === 'excludeProviders' && unavailable) return h('div', { className: 'pgw-cfg__desc pgw-cfg__desc--error' }, t('cfg.providerListUnavailable'))
    return undefined
  }
  const group = (g: GroupId): ReactNode => {
    const fields = FIELDS.filter((f) => f.group === g)
    const name = t(key(`cfg.g.${g}`))
    const isOpen = open.includes(g)
    const parts = groupSummary(g, value)
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
      fields.map((f) => h(Row, { key: f.key, title: t(key(`cfg.f.${f.key}`)), hint: t(key(`cfg.f.${f.key}.hint`)), note: note(f), inline: inline(f), half: f.half === true }, control(f))),
    )
  }
  return h(
    'section',
    { className: 'pgw-cfg' },
    // the row page carries its own heading; the inline section on the bundle page needs one
    props.form ? null : h('h3', { className: 'pgw-title' }, t('cfg.title')),
    failed ? h('div', { className: 'pgw-notice pgw-notice--error', role: 'alert' }, t('cfg.failed')) : null,
    h('div', { className: 'pgw-cfg__folds' }, GROUPS.map(group)),
    h('p', { className: 'pgw-cfg__desc pgw-cfg__foot' }, t('cfg.applies'), ' ', t('cfg.others')),
  )
}

