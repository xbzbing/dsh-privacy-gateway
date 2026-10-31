/**
 * dsh-privacy-gateway client half:
 *  - the bundle's configuration, in the `plugins.bundle.config` slot of its
 *    detail page and the `plugins.row.config` slot of its row (docs/adr/0021);
 *  - the statistics card, in the `plugins.detail.section` slot of this
 *    bundle's detail page, under the page's own content;
 *  - the Privacy tab at the top of the session, in the `conversation.view`
 *    strip, while the config's showPanel is on (docs/adr/0017).
 */
import { createElement as h } from 'react'

import { ConfigSection, type RowForm } from './ConfigSection.ts'
import { PACKAGE, ROW_ID } from './ids.ts'
import { DICTIONARIES, NS, type T } from './locales.ts'
import { followConfigForms, watchShowPanel } from './panelConfig.ts'
import type { ClientCtx } from './rpc.ts'
import { registerPanelView } from './sidebar.ts'
import { StatsCard } from './StatsCard.ts'
import { ensureStyles } from './styles.ts'

interface DetailProps {
  subject?: { kind?: string; pkg?: { name?: string } }
}

const name = 'dsh-privacy-gateway'
const inject = ['slots', 'locale', 'connection']

function apply(ctx: ClientCtx): void {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES) ?? undefined, 'dsh-privacy-gateway: dictionaries')
  const t = ctx.locale.bind(NS) as T
  // the settings service is optional: the configuration page and the tab's quick "on" follow it when it is there
  followConfigForms(ctx)
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
