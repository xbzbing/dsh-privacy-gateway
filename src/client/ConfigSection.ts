/**
 * The bundle's own configuration on its detail page (the `plugins.bundle.config`
 * slot, docs/adr/0017): the switch for the right sidebar's Privacy panel, and
 * the providers whose requests go on unmasked (docs/adr/0018). The detail page
 * draws no form of its own, so both are this plugin's; they write the volatile
 * showPanel and excludeProviders fields through the settings `configForms`
 * service, which takes effect without remounting the gateway.
 */
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { T } from './locales.ts'
import { findNamespace, formsOf } from './panelConfig.ts'
import { excludeChoices, toggleExcluded } from './providerChoice.ts'
import { fetchProviders, type ClientCtx, type ProviderEntry } from './rpc.ts'

export function ConfigSection(props: { ctx: ClientCtx; t: T }): ReactNode {
  const { ctx, t } = props
  const [, setTick] = useState(0)
  const [pending, setPending] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null)
  const [excludePending, setExcludePending] = useState<string[] | null>(null)
  const [added, setAdded] = useState('')
  const bump = (): void => setTick((n) => n + 1)
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
    return mirror.subscribe(bump)
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
  useEffect(() => (form ? form.subscribe(bump) : undefined), [form])
  useEffect(() => {
    const abort = new AbortController()
    void fetchProviders(ctx, abort.signal).then((r) => {
      if (!abort.signal.aborted) setProviders(r.ok ? r.providers : [])
    })
    return () => abort.abort()
  }, [ctx])
  const snap = form?.getSnapshot()
  const ready = snap?.status === 'ready'
  const checked = pending ?? snap?.value?.showPanel === true
  const excluded = excludePending ?? stringsOf(snap?.value?.excludeProviders)
  const busy = !ready || pending !== null || excludePending !== null || snap?.writable === false
  const writeExcluded = (next: string[]): void => {
    if (!form || busy) return
    setExcludePending(next)
    setFailed(false)
    void form.set('excludeProviders', next).then(
      (ok) => {
        setExcludePending(null)
        if (!ok) setFailed(true)
      },
      () => {
        setExcludePending(null)
        setFailed(true)
      },
    )
  }
  const add = (): void => {
    const id = added.trim()
    if (id === '') return
    setAdded('')
    if (!excluded.some((e) => e.toLowerCase() === id.toLowerCase())) writeExcluded([...excluded, id])
  }
  const toggle = (): void => {
    if (!form || pending !== null) return
    const next = !checked
    setPending(next)
    setFailed(false)
    void form.set('showPanel', next).then(
      (ok) => {
        setPending(null)
        if (!ok) setFailed(true)
      },
      () => {
        setPending(null)
        setFailed(true)
      },
    )
  }
  return h(
    'section',
    { className: 'pgw-card' },
    h('h3', { className: 'pgw-title' }, t('cfg.title')),
    !form
      ? h('div', { className: 'pgw-empty' }, t(mirror && view ? 'cfg.unavailable' : 'card.loading'))
      : h(
          'div',
          { className: 'pgw-cfg' },
          h(
            'label',
            { className: 'pgw-switch' },
            h('input', { type: 'checkbox', role: 'switch', checked, disabled: busy, onChange: toggle }),
            h('span', { className: 'pgw-switch__text' }, h('span', null, t('cfg.showPanel')), h('span', { className: 'pgw-meta' }, t('cfg.showPanelHint'))),
          ),
          h(
            'fieldset',
            { className: 'pgw-providers' },
            h('legend', null, t('cfg.excludeProviders')),
            h('div', { className: 'pgw-meta' }, t('cfg.excludeProvidersHint')),
            providers === null
              ? h('div', { className: 'pgw-meta' }, t('card.loading'))
              : excludeChoices(providers, excluded).map((c) =>
                  h(
                    'label',
                    { key: c.id, className: 'pgw-check' },
                    h('input', { type: 'checkbox', checked: c.excluded, disabled: busy, onChange: () => writeExcluded(toggleExcluded(excluded, c.id)) }),
                    h('span', null, c.name, c.name !== c.id ? h('code', { className: 'pgw-meta' }, ` ${c.id}`) : null, c.registered ? null : h('span', { className: 'pgw-meta' }, ` · ${t('cfg.providerAbsent')}`)),
                  ),
                ),
            h(
              'div',
              { className: 'pgw-add' },
              h('input', {
                type: 'text',
                value: added,
                placeholder: t('cfg.providerPlaceholder'),
                disabled: busy,
                onChange: (e: { target: { value: string } }) => setAdded(e.target.value),
                onKeyDown: (e: { key: string }) => {
                  if (e.key === 'Enter') add()
                },
              }),
              h('button', { type: 'button', className: 'pgw-btn', disabled: busy || added.trim() === '', onClick: add }, t('cfg.providerAdd')),
            ),
          ),
        ),
    failed ? h('div', { className: 'pgw-warn pgw-warn--error' }, t('cfg.failed')) : null,
    h('div', { className: 'pgw-meta' }, t('cfg.others')),
  )
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
