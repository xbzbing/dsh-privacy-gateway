/**
 * dsh-privacy-gateway client half: the statistics card, in the
 * `plugins.detail.section` slot of this bundle's detail page. It sits under
 * the page's own content, so the config form the host renders stays as it is.
 */
import { createElement as h } from 'react'

import { DICTIONARIES, NS, type T } from './locales.ts'
import type { ClientCtx } from './rpc.ts'
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
}

module.exports = { name, inject, apply }
