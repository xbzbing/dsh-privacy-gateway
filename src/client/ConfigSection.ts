/**
 * This plugin's configuration page, drawn on the plugin manager's own row page
 * (the `plugins.row.config` slot). The page hands the configuration over as
 * `form`: the entry's live values and the write the shell owns, so the page
 * never looks a namespace up by shape (docs/adr/0017, docs/adr/0018).
 *
 * The two fields are the volatile ones — showPanel and excludeProviders — so a
 * write takes effect without remounting the gateway.
 */
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { T } from './locales.ts'
import { excludeChoices, toggleExcluded } from './providerChoice.ts'
import { fetchProviders, type ClientCtx, type ProviderEntry } from './rpc.ts'
import { buttonOf, checkboxOf, switchOf } from './ui.ts'

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

export function ConfigSection(props: { ctx: ClientCtx; t: T; form?: RowForm }): ReactNode {
  const { ctx, t, form } = props
  const [, tick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null)
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
      if (!abort.signal.aborted) setProviders(r.ok ? r.providers : [])
    })
    return () => abort.abort()
  }, [ctx])
  // the shell replaces the state object on every accepted write; a nudge is all a re-render needs
  void tick
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
  const setShowPanel = (next: boolean): void => write([{ op: 'set', path: ['showPanel'], value: next }])
  const setExcluded = (next: string[]): void => write([{ op: 'set', path: ['excludeProviders'], value: next }])
  const add = (): void => {
    const id = added.trim()
    if (id === '') return
    setAdded('')
    if (!excluded.some((e) => e.toLowerCase() === id.toLowerCase())) setExcluded([...excluded, id])
  }
  const disabled = !ready || busy || !writable
  return h(
    'section',
    { className: 'pgw-cfg' },
    !form
      ? h('div', { className: 'pgw-empty' }, t('cfg.unavailable'))
      : h(
          'div',
          { className: 'pgw-cfg__body' },
          switchOf({ checked: showPanel, label: h('span', { className: 'pgw-cfg__label' }, t('cfg.showPanel'), h('span', { className: 'pgw-meta' }, t('cfg.showPanelHint'))), disabled, onChange: setShowPanel }),
          h(
            'div',
            { className: 'pgw-cfg__group' },
            h('div', { className: 'pgw-cfg__label' }, t('cfg.excludeProviders'), h('div', { className: 'pgw-meta' }, t('cfg.excludeProvidersHint'))),
            providers === null
              ? h('div', { className: 'pgw-meta' }, t('card.loading'))
              : excludeChoices(providers, excluded).map((c) =>
                  h(
                    'div',
                    { key: c.id, className: 'pgw-cfg__row' },
                    checkboxOf({
                      checked: c.excluded,
                      disabled,
                      label: h('span', null, c.name, c.name !== c.id ? h('code', { className: 'pgw-meta' }, ` ${c.id}`) : null, c.registered ? null : h('span', { className: 'pgw-meta' }, ` · ${t('cfg.providerAbsent')}`)),
                      onChange: () => setExcluded(toggleExcluded(excluded, c.id)),
                    }),
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
              buttonOf({ variant: 'outline', size: 'sm', disabled: disabled || added.trim() === '', onClick: add, children: t('cfg.providerAdd') }),
            ),
          ),
          failed ? h('div', { className: 'pgw-warn pgw-warn--error' }, t('cfg.failed')) : null,
          h('div', { className: 'pgw-meta' }, t('cfg.others')),
        ),
  )
}
