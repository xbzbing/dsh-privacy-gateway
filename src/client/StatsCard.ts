/**
 * The statistics card under the bundle's detail page (design §7.4) and, scoped
 * to one session, the Privacy view tab (docs/adr/0017). Drawn with the Web
 * shell's own controls; the pieces are in StatsParts.ts.
 */
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconWarningOutlineRegular, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { Overview } from '../remote.ts'
import type { Key, T } from './locales.ts'
import { fetchOverview, type ClientCtx } from './rpc.ts'
import { Dist, Kpis, Notices, RecordHead, RecordRow, ResetButton, SessionSwitch } from './StatsParts.ts'
import { pageOf, warnings, type Range } from './view.ts'

const REFRESH_MS = 15_000
/** Records asked for: the most the host sends, shown a page at a time. */
const LIMIT = 200
const PAGE_SIZE = 10
const RANGES: Range[] = ['today', 'week', 'month']

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Overview }

function useOverview(ctx: ClientCtx, session?: string): [State, () => void, boolean] {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const live = useRef<AbortController | null>(null)
  const load = useCallback(() => {
    live.current?.abort()
    const ac = new AbortController()
    live.current = ac
    setBusy(true)
    void fetchOverview(ctx, LIMIT, ac.signal, session).then((r) => {
      if (ac.signal.aborted) return
      setBusy(false)
      setState((prev) => (r.ok ? { status: 'ready', data: r.value } : prev.status === 'ready' ? prev : { status: 'error' }))
    })
  }, [ctx, session])
  useEffect(() => {
    load()
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }, REFRESH_MS)
    return () => {
      clearInterval(timer)
      live.current?.abort()
    }
  }, [load])
  return [state, load, busy]
}

export function StatsCard(props: { ctx: ClientCtx; t: T; panel?: boolean; sessionId?: string }): ReactNode {
  const { t } = props
  const [state, reload, busy] = useOverview(props.ctx, props.sessionId)
  const [range, setRange] = useState<Range>('today')
  const [open, setOpen] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const cardClass = `pgw-card${props.panel ? ' pgw-card--panel' : ''}`
  const ready = state.status === 'ready' ? state.data : undefined
  // clearing is for every session's history, so it sits on the plugin's own card only
  const resettable = !props.sessionId && ready !== undefined
  const head = h(
    'div',
    { className: 'pgw-head' },
    h(
      'div',
      { className: 'pgw-head__main' },
      props.panel ? null : h('h3', { className: 'pgw-title' }, t('card.title')),
      // the session tab: this session's own switch; the global state only when it is off
      props.sessionId && ready && typeof ready.sessionMasking === 'boolean'
        ? h(SessionSwitch, {
            ctx: props.ctx,
            t,
            session: props.sessionId,
            on: ready.sessionMasking,
            onDone: (message) => {
              setNotice(message === null ? null : { text: message, ok: false })
              reload()
            },
          })
        : null,
      ready && (!props.sessionId || !ready.active) ? h(Tag, { tone: ready.active ? 'success' : 'warning' }, t(ready.active ? 'card.on' : 'card.off')) : null,
      props.sessionId && ready && ready.sessionMasking === undefined ? h(Tag, { tone: 'outline' }, t('panel.session')) : null,
      // the value table is shared by every session, so it is told on the plugin's own card only
      ready && !props.sessionId ? h('span', { className: 'pgw-meta', title: t('card.valuesHint') }, t('card.values', { n: ready.values })) : null,
      ready && !ready.record ? h('span', { className: 'pgw-meta' }, t('card.memoryOnly')) : null,
    ),
    h(
      'div',
      { className: 'pgw-head__actions' },
      ready
        ? h(SegmentedControl<Range>, {
            id: `pgw-range-${props.sessionId ?? 'all'}`,
            label: t('card.range'),
            value: range,
            options: RANGES.map((r) => ({ value: r, label: t(`range.${r}` as Key) })),
            onChange: setRange,
          })
        : null,
      h(Button, { variant: 'ghost', size: 'sm', disabled: busy, title: t('card.refresh'), 'aria-label': t('card.refresh'), onClick: reload }, h(IconRefreshOutlineRegular, { size: 14 })),
      resettable
        ? h(ResetButton, {
            ctx: props.ctx,
            t,
            onDone: (text, ok) => {
              setNotice({ text, ok })
              setOpen(null)
              setPage(0)
              reload()
            },
          })
        : null,
    ),
  )
  const flash = notice ? h('div', { className: `pgw-flash${notice.ok ? '' : ' pgw-flash--error'}`, role: 'status' }, notice.text) : null
  const sessionOff =
    props.sessionId && ready?.sessionMasking === false
      ? h('div', { className: 'pgw-notice', role: 'status' }, h(IconWarningOutlineRegular, { size: 14, className: 'pgw-notice__icon' }), h('span', null, t('session.offNotice')))
      : null
  if (!ready) {
    return h('section', { className: cardClass }, head, h('div', { className: 'pgw-empty pgw-empty--block' }, t(state.status === 'loading' ? 'card.loading' : 'card.unavailable')))
  }
  if (props.sessionId && ready.recent.length === 0) {
    return h('section', { className: cardClass }, head, flash, sessionOff, h('div', { className: 'pgw-empty pgw-empty--block' }, t('panel.empty')))
  }
  const o = ready
  const totals = o.stats[range]
  const viewable = new Set(o.vendorView ? (o.views ?? []) : [])
  const shown = pageOf(o.recent, page, PAGE_SIZE)
  const go = (to: number): void => {
    setPage(to)
    setOpen(null)
  }
  return h(
    'section',
    { className: cardClass },
    head,
    flash,
    sessionOff,
    h(Notices, { t, items: warnings(o, totals) }),
    h(Kpis, { totals, t }),
    h(
      'div',
      { className: 'pgw-dists' },
      h(Dist, { title: t('dist.kind'), data: totals.kinds, empty: t('dist.empty') }),
      h(Dist, { title: t('dist.finder'), data: totals.finders, empty: t('dist.empty') }),
      h(Dist, { title: t('dist.host'), data: totals.hosts, empty: t('dist.empty') }),
    ),
    h(
      'div',
      { className: 'pgw-section' },
      h('div', { className: 'pgw-section__head' }, h('span', { className: 'pgw-section__title' }, t('recent.title')), o.recent.length > 0 ? h('span', { className: 'pgw-meta' }, t('recent.count', { n: o.recent.length })) : null),
      o.recent.length === 0
        ? h('div', { className: 'pgw-empty pgw-empty--block' }, t('recent.empty'))
        : h(
            'div',
            { className: 'pgw-recs', role: 'table' },
            h(RecordHead, { t }),
            shown.items.map((r) => h(RecordRow, { key: r.key, ctx: props.ctx, r, open: open === r.key, toggle: () => setOpen(open === r.key ? null : r.key), t, viewable: viewable.has(r.key) })),
          ),
      shown.pages > 1
        ? h(
            'div',
            { className: 'pgw-pager' },
            h(Button, { variant: 'ghost', size: 'sm', disabled: shown.page === 0, onClick: () => go(0) }, t('page.first')),
            h(Button, { variant: 'ghost', size: 'sm', disabled: shown.page === 0, 'aria-label': t('page.prev'), title: t('page.prev'), onClick: () => go(shown.page - 1) }, h(IconChevronLeftOutlineRegular, { size: 14 })),
            h('span', { className: 'pgw-meta pgw-pager__at' }, t('page.at', { page: shown.page + 1, pages: shown.pages })),
            h(Button, { variant: 'ghost', size: 'sm', disabled: shown.page >= shown.pages - 1, 'aria-label': t('page.next'), title: t('page.next'), onClick: () => go(shown.page + 1) }, h(IconChevronRightOutlineRegular, { size: 14 })),
          )
        : null,
    ),
  )
}
