/**
 * The Privacy tab of the session's right sidebar (docs/adr/0017): the same
 * statistics as the detail page's card, offered only while the config's
 * showPanel is on. The sidebar's registry is optional, so the type is
 * registered from a deferred injection rather than the plugin's own inject
 * list, and released when showPanel goes off.
 */
import { createElement as h, Fragment } from 'react'
import type { ReactNode } from 'react'

import { NS, type T } from './locales.ts'
import type { ClientCtx } from './rpc.ts'
import { StatsCard } from './StatsCard.ts'

/** This type's identity in the tab system, and the key its body and title register under. */
export const SIDEBAR_ID = 'dsh-privacy-gateway'
/** What openTab names. */
export const SIDEBAR_KIND = 'dsh-privacy-gateway'

interface GuideEntry {
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: (props: { size?: number; className?: string }) => ReactNode
}

interface TabDefinition {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  keepMounted?: boolean
  title: (address: string) => string
  guide?: GuideEntry[]
}

interface Registry {
  register(definition: TabDefinition): () => void
}

export function registryOf(ctx: ClientCtx): Registry | undefined {
  try {
    const r = ctx.get('sidebarRightTabs') as Registry | undefined
    return r !== undefined && typeof r.register === 'function' ? r : undefined
  } catch {
    return undefined
  }
}

/** The plugin's shield, drawn in its own colours in both themes. */
export function ShieldIcon(props: { size?: number; className?: string }): ReactNode {
  const size = props.size ?? 16
  return h(
    'svg',
    { width: size, height: size, viewBox: '4.5 4.5 27 27', fill: 'none', className: props.className, 'aria-hidden': true },
    h('path', { d: 'M18 6L28.5 9.6V17.4C28.5 23.3 24.2 28.3 18 30C11.8 28.3 7.5 23.3 7.5 17.4V9.6L18 6Z', fill: '#6E50E6' }),
    h('path', { d: 'M14.4 14.2C13.5 14.2 13.1 14.7 13.1 15.6V16.7C13.1 17.5 12.7 18.1 12 18.1C12.7 18.1 13.1 18.7 13.1 19.5V20.6C13.1 21.5 13.5 22 14.4 22', stroke: '#fff', strokeWidth: 1.6, strokeLinecap: 'round' }),
    h('path', { d: 'M21.6 14.2C22.5 14.2 22.9 14.7 22.9 15.6V16.7C22.9 17.5 23.3 18.1 24 18.1C23.3 18.1 22.9 18.7 22.9 19.5V20.6C22.9 21.5 22.5 22 21.6 22', stroke: '#fff', strokeWidth: 1.6, strokeLinecap: 'round' }),
    h('circle', { cx: 15.7, cy: 18.1, r: 1.15, fill: '#fff' }),
    h('circle', { cx: 18, cy: 18.1, r: 1.15, fill: '#fff' }),
    h('circle', { cx: 20.3, cy: 18.1, r: 1.15, fill: '#fff' }),
  )
}

/**
 * Registers the tab type, its body and its title, rolled back as one; a
 * disposer, or undefined when the host has no right sidebar.
 */
export function registerSidebarTab(ctx: ClientCtx, t: T): (() => void) | undefined {
  const registry = registryOf(ctx)
  if (!registry) return undefined
  let releaseType: (() => void) | undefined
  try {
    releaseType = registry.register({
      id: SIDEBAR_ID,
      kind: SIDEBAR_KIND,
      priority: 'extension',
      title: () => t('panel.tab'),
      guide: [{ id: 'privacy', order: 40, title: () => t('panel.tab'), description: () => t('panel.guide'), icon: ShieldIcon }],
    })
  } catch {
    return undefined
  }
  const releases: Array<() => void> = []
  const rollback = (): void => {
    for (const r of [...releases].reverse()) {
      try {
        r()
      } catch {
        // already gone
      }
    }
    releases.length = 0
    try {
      releaseType?.()
    } catch {
      // already gone
    }
    releaseType = undefined
  }
  try {
    const body = ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_ID, locale: NS }, () => h(StatsCard, { ctx, t, panel: true })),
    )
    if (typeof body === 'function') releases.push(body as () => void)
    const title = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: SIDEBAR_ID }, () =>
        h(Fragment, null, h(ShieldIcon, { size: 16, className: 'pgw-tab-icon' }), h('span', null, t('panel.tab'))),
      ),
    )
    if (typeof title === 'function') releases.push(title as () => void)
  } catch {
    rollback()
    return undefined
  }
  return rollback
}
