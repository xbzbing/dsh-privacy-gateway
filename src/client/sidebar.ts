/**
 * The Privacy tab of the conversation's view strip — the 「隐私保护」 tab beside
 * Chat, Trajectory, Git and the rest (docs/adr/0017). It is the same card as
 * the plugin's detail page, narrowed to the session the tab belongs to, and it
 * exists only while the config's showPanel is on.
 *
 * A view registers through `conversation.view`, the same seat the Git panel
 * takes; the strip renders one view at a time and passes the session it is
 * showing.
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'

import { NS, type T } from './locales.ts'
import type { ClientCtx } from './rpc.ts'
import { StatsCard } from './StatsCard.ts'

/** The view's identity in the strip, and the key its label registers under. */
export const VIEW_ID = 'dsh-privacy-gateway'

/** Why the last mount attempt failed, for the configuration page to show. */
export let lastFailure: string | undefined

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
 * Registers the view and its label, rolled back as one; a disposer, or
 * undefined when the strip is not there to register with.
 */
export function registerPanelView(ctx: ClientCtx, t: T): (() => void) | undefined {
  lastFailure = undefined
  let release: (() => void) | undefined
  try {
    const handle = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register(
        // beside Chat (0), Trajectory (10), Context (20) and Git (30), ahead of Stats (40); the label is
        // text, which is what the strip projects
        { name: 'conversation.view', id: VIEW_ID, order: 35, locale: NS, label: () => t('panel.tab') },
        (props: { sessionId?: string }) => h(StatsCard, { ctx, t, panel: true, ...(props?.sessionId ? { sessionId: props.sessionId } : {}) }),
      ),
    )
    if (typeof handle !== 'function') {
      lastFailure = 'slots.inject returned no disposer'
      return undefined
    }
    release = handle as () => void
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err)
    return undefined
  }
  return () => {
    const r = release
    release = undefined
    try {
      r?.()
    } catch {
      // already gone
    }
  }
}
