/**
 * dsh-privacy-gateway client half:
 *  - the bundle's configuration, in the `plugins.bundle.config` slot of its
 *    detail page: the switch for the sidebar's Privacy panel;
 *  - the statistics card, in the `plugins.detail.section` slot of this
 *    bundle's detail page, under the page's own content;
 *  - the Privacy tab of the session's right sidebar, while the config's
 *    showPanel is on (docs/adr/0017).
 */
import { createElement as h } from 'react'

import { ConfigSection, type RowForm } from './ConfigSection.ts'
import { DICTIONARIES, NS, type T } from './locales.ts'
import { watchShowPanel } from './panelConfig.ts'
import type { ClientCtx } from './rpc.ts'
import { registerPanelView } from './sidebar.ts'
import { StatsCard } from './StatsCard.ts'
import { ensureStyles } from './styles.ts'

/** The bundle's package name: the page whose subject it is gets the card. */
export const PACKAGE = 'dsh-privacy-gateway'
/** The row this bundle's patch inserts: its configuration page is keyed by it. */
export const ROW_ID = 'dsh-privacy-gateway'

interface DetailProps {
  subject?: { kind?: string; pkg?: { name?: string } }
}

const name = 'dsh-privacy-gateway'
const inject = ['slots', 'locale', 'connection']

function apply(ctx: ClientCtx): void {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES) ?? undefined, 'dsh-privacy-gateway: dictionaries')
  const t = ctx.locale.bind(NS) as T
  ctx.effect(() => {
    const handle = ctx.slots.inject('plugins.detail.section', () =>
      ctx.slots.register({ name: 'plugins.detail.section', id: 'dsh-privacy-gateway-stats', locale: NS }, (props: DetailProps) =>
        props.subject?.kind === 'bundle' && props.subject.pkg?.name === PACKAGE ? h(StatsCard, { ctx, t }) : null,
      ),
    )
    return typeof handle === 'function' ? (handle as () => void) : undefined
  }, 'dsh-privacy-gateway: statistics card')
  // the configuration is drawn in two official places, from one component (docs/adr/0017): the bundle's
  // detail page, where it is in sight, and the plugin manager's row page, which hands over the entry's form
  ctx.effect(() => {
    const handle = ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, (props: { view?: string }) =>
        props.view === 'summary' ? t('cfg.title') : h(ConfigSection, { ctx, t }),
      ),
    )
    return typeof handle === 'function' ? (handle as () => void) : undefined
  }, 'dsh-privacy-gateway: configuration (bundle page)')
  ctx.effect(() => {
    const handle = ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register({ name: 'plugins.row.config', key: `${PACKAGE}#${ROW_ID}`, locale: NS }, (props: { view?: string; form?: RowForm }) =>
        props.view === 'summary' ? t('cfg.title') : h(ConfigSection, { ctx, t, form: props.form }),
      ),
    )
    return typeof handle === 'function' ? (handle as () => void) : undefined
  }, 'dsh-privacy-gateway: configuration (row page)')

  // the view tab in the conversation's strip, registered while showPanel is on (docs/adr/0017)
  let want = false
  let release: (() => void) | undefined
  const unmount = (): void => {
    const r = release
    release = undefined
    r?.()
  }
  const reconcile = (): void => {
    if (want && !release) release = registerPanelView(ctx, t)
    else if (!want) unmount()
  }
  ctx.effect(() => {
    const stop = watchShowPanel(ctx, (on) => {
      want = on
      reconcile()
    })
    return () => {
      stop()
      want = false
      unmount()
    }
  }, 'dsh-privacy-gateway: view tab')
}

module.exports = { name, inject, apply }
