/**
 * The bundle's own configuration on its detail page (the `plugins.bundle.config`
 * slot, docs/adr/0017): the switch for the right sidebar's Privacy panel. The
 * detail page draws no form of its own, so the switch is this plugin's; it
 * writes the volatile showPanel field through the settings `configForms`
 * service, which takes effect without remounting the gateway.
 */
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { T } from './locales.ts'
import { findNamespace, formsOf } from './panelConfig.ts'
import type { ClientCtx } from './rpc.ts'

export function ConfigSection(props: { ctx: ClientCtx; t: T }): ReactNode {
  const { ctx, t } = props
  const [, setTick] = useState(0)
  const [pending, setPending] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
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
  const snap = form?.getSnapshot()
  const ready = snap?.status === 'ready'
  const checked = pending ?? snap?.value?.showPanel === true
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
          'label',
          { className: 'pgw-switch' },
          h('input', { type: 'checkbox', role: 'switch', checked, disabled: !ready || pending !== null || snap?.writable === false, onChange: toggle }),
          h('span', { className: 'pgw-switch__text' }, h('span', null, t('cfg.showPanel')), h('span', { className: 'pgw-meta' }, t('cfg.showPanelHint'))),
        ),
    failed ? h('div', { className: 'pgw-warn pgw-warn--error' }, t('cfg.failed')) : null,
    h('div', { className: 'pgw-meta' }, t('cfg.others')),
  )
}
