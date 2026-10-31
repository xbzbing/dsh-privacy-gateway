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

import { ConfigSection } from './ConfigSection.ts'
import { DICTIONARIES, NS, type T } from './locales.ts'
import { watchShowPanel } from './panelConfig.ts'
import type { ClientCtx } from './rpc.ts'
import { registerSidebarTab, registryOf } from './sidebar.ts'
import { StatsCard } from './StatsCard.ts'
import { ensureStyles } from './styles.ts'

/** The bundle's package name: the page whose subject it is gets the card. */
export const PACKAGE = 'dsh-privacy-gateway'

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
  // the detail page draws no form for a bundle: only an entry under its package name gives it a configuration section
  ctx.effect(() => {
    const handle = ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE, locale: NS }, (props: { view?: string }) =>
        props.view === 'summary' ? t('cfg.title') : h(ConfigSection, { ctx, t }),
      ),
    )
    return typeof handle === 'function' ? (handle as () => void) : undefined
  }, 'dsh-privacy-gateway: configuration')

  // the sidebar tab: registered while showPanel is on and the sidebar's registry is there
  let want = false
  let release: (() => void) | undefined
  let sidebarCtx: ClientCtx | undefined
  const unmount = (): void => {
    const r = release
    release = undefined
    r?.()
  }
  const reconcile = (): void => {
    const target = sidebarCtx ?? ctx
    if (want && !release && registryOf(target)) release = registerSidebarTab(target, t)
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
  }, 'dsh-privacy-gateway: sidebar tab')
  // the registry may come after this plugin, or never: waited for apart from the plugin's own inject list
  ctx.inject?.(['sidebarRightTabs'], (child) => {
    sidebarCtx = child
    reconcile()
    child.effect(() => () => {
      if (sidebarCtx === child) sidebarCtx = undefined
      unmount()
    }, 'dsh-privacy-gateway: sidebar registry')
  })
}

module.exports = { name, inject, apply }
