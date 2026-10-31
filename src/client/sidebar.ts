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

import { NS, type T } from './locales.ts'
import type { ClientCtx } from './rpc.ts'
import { StatsCard } from './StatsCard.ts'
import { createStore, type Store } from './store.ts'

/** The view's identity in the strip, and the key its label registers under. */
export const VIEW_ID = 'dsh-privacy-gateway'

/** Why the last attempt to register the tab failed: the strip gave back no disposer, or it threw. */
export type PanelFailure = { code: 'noDisposer' } | { code: 'thrown'; message: string }

/** The last registration failure, for the configuration page to show and follow. */
export const panelFailure: Store<PanelFailure | undefined> = createStore<PanelFailure | undefined>(undefined)

/** A registration failure in the reader's language. */
export function panelFailureText(f: PanelFailure, t: T): string {
  return f.code === 'noDisposer' ? t('err.noDisposer') : t('err.thrown', { message: f.message })
}

/**
 * Registers the view and its label, rolled back as one; a disposer, or
 * undefined when the strip is not there to register with.
 */
export function registerPanelView(ctx: ClientCtx, t: T): (() => void) | undefined {
  panelFailure.set(undefined)
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
      panelFailure.set({ code: 'noDisposer' })
      return undefined
    }
    release = handle as () => void
  } catch (err) {
    panelFailure.set({ code: 'thrown', message: err instanceof Error ? err.message : String(err) })
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
