/**
 * This plugin's configuration, drawn in two official places from one component
 * (docs/adr/0017, docs/adr/0018):
 *  - the bundle's detail page (`plugins.bundle.config`), inline, where the
 *    entry's form is taken from the settings mirror;
 *  - the plugin manager's row page (`plugins.row.config`), which hands the
 *    entry's `form` over itself.
 * Both write through the same revision-aware `mutate`, and both use the Web
 * shell's own controls — the Switch for the toggle and the Menu for picking
 * providers, the way the git panel picks a model.
 *
 * The two fields are the volatile ones — showPanel and excludeProviders — so a
 * write takes effect without remounting the gateway.
 */
import { Button, IconChevronDownOutlineRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { T } from './locales.ts'
import { findNamespace, formsOf } from './panelConfig.ts'
import { lastFailure, registryOf } from './sidebar.ts'
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

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

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

export function ConfigSection(props: { ctx: ClientCtx; t: T; form?: RowForm }): ReactNode {
  const { ctx, t } = props
  const mirrored = useMirrorForm(ctx)
  const form = props.form ?? mirrored
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [picker, setPicker] = useState(false)
  const [added, setAdded] = useState('')
  const state = form?.state
  const ready = state?.status === 'ready'
  const writable = state?.writable !== false
  const value = state?.value ?? {}
  const showPanel = value.showPanel === true
  const excluded = useMemo(() => strings(value.excludeProviders), [value])
  useEffect(() => {
    const abort = new AbortController()
    void fetchProviders(ctx, abort.signal).then((r) => {
      if (abort.signal.aborted) return
      setUnavailable(!r.ok)
      setProviders(r.ok ? r.providers : [])
    })
    return () => abort.abort()
  }, [ctx])
  const write = (ops: readonly FieldOp[]): void => {
    if (!form || busy || !ready || !writable) return
    setBusy(true)
    setFailed(false)
    void form.mutate(ops, form.state.revision).then(
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
  const disabled = !ready || busy || !writable
  const rows = excludeChoices(providers ?? [], excluded)
  const add = (): void => {
    const id = added.trim()
    if (id === '') return
    setAdded('')
    if (!excluded.some((e) => e.toLowerCase() === id.toLowerCase())) write([{ op: 'set', path: ['excludeProviders'], value: [...excluded, id] }])
  }
  const remove = (id: string): void => write([{ op: 'set', path: ['excludeProviders'], value: toggleExcluded(excluded, id) }])
  if (!form) return h('div', { className: 'pgw-empty' }, t('cfg.unavailable'))
  return h(
    'section',
    { className: 'pgw-cfg' },
    // the row page carries its own heading; the inline section on the bundle page needs one
    props.form ? null : h('h3', { className: 'pgw-title' }, t('cfg.title')),
    h(
      'div',
      { className: 'pgw-cfg__field' },
      h(
        'div',
        { className: 'pgw-cfg__text' },
        h('span', { className: 'pgw-cfg__name' }, t('cfg.showPanel')),
        h('span', { className: 'pgw-meta' }, t('cfg.showPanelHint')),
        // why the tab would not appear, said where the switch is (docs/adr/0017)
        registryOf(ctx)
          ? lastFailure
            ? h('span', { className: 'pgw-meta pgw-warn' }, `${t('cfg.sidebarFailed')} ${lastFailure}`)
            : null
          : h('span', { className: 'pgw-meta pgw-warn' }, t('cfg.noSidebar')),
      ),
      h('div', { className: 'pgw-cfg__control' }, h(Switch, { checked: showPanel, label: t('cfg.showPanel'), disabled, onChange: (next) => write([{ op: 'set', path: ['showPanel'], value: next }]) })),
    ),
    h(
      'div',
      { className: 'pgw-cfg__field' },
      h('div', { className: 'pgw-cfg__text' }, h('span', { className: 'pgw-cfg__name' }, t('cfg.excludeProviders')), h('span', { className: 'pgw-meta' }, t('cfg.excludeProvidersHint'))),
      h(
        'div',
        { className: 'pgw-cfg__control' },
        h(Menu, {
          open: picker,
          align: 'end',
          portal: true,
          selection: 'check',
          selectedIds: excluded,
          anchor: h(
            'button',
            {
              type: 'button',
              className: 'pgw-picker',
              disabled,
              'aria-haspopup': 'menu',
              'aria-expanded': picker,
              onClick: () => setPicker((was) => !was),
            },
            h('span', null, excluded.length === 0 ? t('cfg.excludedNone') : t('cfg.excludedCount', { n: excluded.length })),
            h(IconChevronDownOutlineRegular, { size: 14 }),
          ),
          items: rows.length === 0 ? [] : rows.map((c) => ({ id: c.id, label: h('span', { className: 'pgw-picker__row' }, c.name, c.registered ? null : h('span', { className: 'pgw-meta' }, ` · ${t('cfg.providerAbsent')}`)) })),
          // a menu of checkboxes: choosing one adds or removes it and leaves the menu open, like a filter list
          onSelect: (id) => write([{ op: 'set', path: ['excludeProviders'], value: toggleExcluded(excluded, id) }]),
          onClose: () => setPicker(false),
          footer: [],
        }),
      ),
    ),
    unavailable ? h('div', { className: 'pgw-meta' }, t('cfg.providerListUnavailable')) : null,
    excluded.length === 0
      ? null
      : h(
          'div',
          { className: 'pgw-cfg__chips' },
          excluded.map((id) =>
            h('span', { key: id, className: 'pgw-chip' }, h('span', null, rows.find((r) => r.id.toLowerCase() === id.toLowerCase())?.name ?? id), h('button', { type: 'button', className: 'pgw-chip__x', 'aria-label': t('cfg.remove', { name: id }), disabled, onClick: () => remove(id) }, '×')),
          ),
        ),
    h(
      'div',
      { className: 'pgw-cfg__add' },
      h('input', {
        type: 'text',
        value: added,
        placeholder: t('cfg.providerPlaceholder'),
        disabled,
        onChange: (e: { target: { value: string } }) => setAdded(e.target.value),
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Enter') add()
        },
      }),
      h(Button, { variant: 'outline', size: 'sm', disabled: disabled || added.trim() === '', onClick: add }, h('span', null, t('cfg.providerAdd'))),
    ),
    failed ? h('div', { className: 'pgw-warn pgw-warn--error' }, t('cfg.failed')) : null,
    h('div', { className: 'pgw-meta' }, t('cfg.others')),
  )
}
