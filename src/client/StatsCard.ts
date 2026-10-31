/** The statistics card under the bundle's detail page (design §7.4). */
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord, Totals } from '../records.ts'
import type { Overview } from '../remote.ts'
import type { Key, T } from './locales.ts'
import { fetchOverview, type ClientCtx } from './rpc.ts'
import { bars, pageOf, timeLabel, took, warnings, type Range } from './view.ts'
import { VendorView } from './VendorView.ts'

const REFRESH_MS = 15_000
/** Records asked for: the most the host sends, shown a page at a time. */
const LIMIT = 200
const PAGE_SIZE = 10
const RANGES: Range[] = ['today', 'week', 'month']

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Overview }

function useOverview(ctx: ClientCtx): [State, () => void, boolean] {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const live = useRef<AbortController | null>(null)
  const load = useCallback(() => {
    live.current?.abort()
    const ac = new AbortController()
    live.current = ac
    setBusy(true)
    void fetchOverview(ctx, LIMIT, ac.signal).then((r) => {
      if (ac.signal.aborted) return
      setBusy(false)
      setState((prev) => (r.ok ? { status: 'ready', data: r.value } : prev.status === 'ready' ? prev : { status: 'error' }))
    })
  }, [ctx])
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

function Stat(props: { label: string; value: number; sub?: string; tone?: 'warn' | 'error' }): ReactNode {
  return h(
    'div',
    { className: `pgw-stat${props.tone ? ` pgw-stat--${props.tone}` : ''}` },
    h('span', { className: 'pgw-stat__label' }, props.label),
    h('span', { className: 'pgw-stat__value' }, props.value.toLocaleString()),
    props.sub ? h('span', { className: 'pgw-stat__sub' }, props.sub) : null,
  )
}

function Dist(props: { title: string; data: Record<string, number>; empty: string }): ReactNode {
  const list = bars(props.data)
  return h(
    'div',
    { className: 'pgw-dist' },
    h('div', { className: 'pgw-dist__title' }, props.title),
    list.length === 0
      ? h('div', { className: 'pgw-empty' }, props.empty)
      : list.map((b) =>
          h(
            'div',
            { className: 'pgw-bar', key: b.label },
            h('span', { className: 'pgw-bar__label', title: b.label }, b.label),
            h('span', { className: 'pgw-bar__track' }, h('span', { className: 'pgw-bar__fill', style: { width: `${b.pct}%`, display: 'block' } })),
            h('span', { className: 'pgw-bar__value' }, b.value.toLocaleString()),
          ),
        ),
  )
}

function Totals_(props: { t: Totals; tr: T }): ReactNode {
  const { t, tr } = props
  return h(
    'div',
    { className: 'pgw-stats' },
    h(Stat, { label: tr('stat.requests'), value: t.requests }),
    h(Stat, { label: tr('stat.masked'), value: t.masked }),
    h(Stat, { label: tr('stat.n'), value: t.n }),
    h(Stat, { label: tr('stat.restored'), value: t.restored, ...(t.restoredInTools > 0 ? { sub: tr('stat.inTools', { n: t.restoredInTools }) } : {}) }),
    h(Stat, { label: tr('stat.unmapped'), value: t.unmapped, ...(t.unmapped > 0 ? { tone: 'warn' as const } : {}) }),
    h(Stat, { label: tr('stat.failed'), value: t.failed, ...(t.failed > 0 ? { tone: 'error' as const } : {}) }),
    (t.warned ?? 0) > 0 ? h(Stat, { label: tr('stat.warned'), value: t.warned, tone: 'warn' }) : null,
    (t.blocked ?? 0) > 0 ? h(Stat, { label: tr('stat.blocked'), value: t.blocked, tone: 'warn' }) : null,
    (t.exfil ?? 0) > 0
      ? h(Stat, { label: tr('stat.exfil'), value: t.exfil, tone: 'error', ...((t.exfilBlocked ?? 0) > 0 ? { sub: tr('stat.exfilBlocked', { n: t.exfilBlocked }) } : {}) })
      : null,
  )
}

function Record_(props: { ctx: ClientCtx; r: MaskRecord; open: boolean; toggle: () => void; tr: T; viewable: boolean }): ReactNode {
  const { r, tr } = props
  const [viewing, setViewing] = useState(false)
  const where = [r.host, r.model].filter(Boolean).join(' · ')
  const right = r.failed
    ? h('span', { className: 'pgw-row__fail' }, tr('recent.failed'))
    : r.blocked
      ? h('span', { className: 'pgw-row__fail' }, tr('recent.blocked'))
      : h('span', { className: r.exfil ? 'pgw-row__fail' : undefined }, tr('recent.places', { n: r.n }))
  return h(
    Fragment,
    null,
    h(
      'button',
      { type: 'button', className: `pgw-row${r.n === 0 && !r.failed ? ' pgw-row--zero' : ''}`, 'aria-expanded': props.open, onClick: props.toggle },
      h('span', { className: 'pgw-row__time' }, timeLabel(r.time)),
      h('span', { className: 'pgw-row__where', title: where }, where),
      right,
      h('span', { className: 'pgw-row__time' }, tr('recent.restored', { n: r.restored })),
    ),
    props.open
      ? h(
          'div',
          { className: 'pgw-detail' },
          r.exfil ? h('div', { className: 'pgw-warn pgw-warn--error' }, tr('recent.exfil', { hosts: (r.exfilHosts ?? []).join(', ') })) : null,
          r.values.length === 0
            ? h('div', { className: 'pgw-empty' }, tr('recent.noValues'))
            : h(
                'table',
                null,
                h('thead', null, h('tr', null, ...(['col.placeholder', 'col.kind', 'col.finder', 'col.head', 'col.len', 'col.n', 'col.action'] as Key[]).map((k) => h('th', { key: k }, tr(k))))),
                h(
                  'tbody',
                  null,
                  r.values.map((v) =>
                    h(
                      'tr',
                      { key: v.placeholder },
                      h('td', null, v.placeholder),
                      h('td', null, v.kind),
                      h('td', null, v.finder),
                      h('td', null, v.head ? `${v.head}…` : ''),
                      h('td', null, v.len),
                      h('td', null, v.n),
                      h('td', null, v.action ? tr(v.action === 'warn' ? 'action.warn' : 'action.block') : ''),
                    ),
                  ),
                ),
              ),
          props.viewable && !viewing ? h('button', { type: 'button', className: 'pgw-btn pgw-detail__btn', onClick: () => setViewing(true) }, tr('view.open')) : null,
          props.viewable && viewing ? h(VendorView, { ctx: props.ctx, t: tr, record: r, onClose: () => setViewing(false) }) : null,
        )
      : null,
  )
}

export function StatsCard(props: { ctx: ClientCtx; t: T; panel?: boolean }): ReactNode {
  const { t } = props
  const [state, reload, busy] = useOverview(props.ctx)
  const [range, setRange] = useState<Range>('today')
  const [open, setOpen] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const cardClass = `pgw-card${props.panel ? ' pgw-card--panel' : ''}`
  const head = (extra: ReactNode[]): ReactNode =>
    h(
      'div',
      { className: 'pgw-head' },
      props.panel ? null : h('h3', { className: 'pgw-title' }, t('card.title')),
      ...extra,
      h('span', { className: 'pgw-spacer' }),
      h('button', { type: 'button', className: 'pgw-btn', onClick: reload, disabled: busy }, t('card.refresh')),
    )
  if (state.status !== 'ready') {
    return h('section', { className: cardClass }, head([]), h('div', { className: 'pgw-empty' }, t(state.status === 'loading' ? 'card.loading' : 'card.unavailable')))
  }
  const o = state.data
  const totals = o.stats[range]
  const time = took(totals)
  const viewable = new Set(o.vendorView ? (o.views ?? []) : [])
  const shown = pageOf(o.recent, page, PAGE_SIZE)
  const go = (to: number): void => {
    setPage(to)
    setOpen(null)
  }
  return h(
    'section',
    { className: cardClass },
    head([
      h('span', { key: 'b', className: `pgw-badge pgw-badge--${o.active ? 'on' : 'off'}` }, t(o.active ? 'card.on' : 'card.off')),
      h('span', { key: 'v', className: 'pgw-meta' }, t('card.values', { n: o.values })),
      o.record ? null : h('span', { key: 'm', className: 'pgw-meta' }, t('card.memoryOnly')),
    ]),
    h(
      'div',
      { className: 'pgw-tabs', role: 'tablist' },
      RANGES.map((r) => h('button', { key: r, type: 'button', role: 'tab', className: 'pgw-tab', 'aria-selected': r === range, onClick: () => setRange(r) }, t(`range.${r}` as Key))),
    ),
    ...warnings(o, totals).map((w) => h('div', { key: w.key, className: `pgw-warn${w.tone === 'error' ? ' pgw-warn--error' : ''}` }, t(w.key, { n: w.n }))),
    h(Totals_, { t: totals, tr: t }),
    h(
      'div',
      { className: 'pgw-dists' },
      h(Dist, { title: t('dist.kind'), data: totals.kinds, empty: t('dist.empty') }),
      h(Dist, { title: t('dist.finder'), data: totals.finders, empty: t('dist.empty') }),
      h(Dist, { title: t('dist.host'), data: totals.hosts, empty: t('dist.empty') }),
    ),
    totals.requests > 0 ? h('div', { className: 'pgw-meta' }, t('took', time)) : null,
    h('div', { className: 'pgw-dist__title' }, t('recent.title')),
    o.recent.length === 0
      ? h('div', { className: 'pgw-empty' }, t('recent.empty'))
      : h(
          'div',
          { className: 'pgw-list' },
          shown.items.map((r) =>
            h(Record_, { key: r.key, ctx: props.ctx, r, open: open === r.key, toggle: () => setOpen(open === r.key ? null : r.key), tr: t, viewable: viewable.has(r.key) }),
          ),
        ),
    shown.pages > 1
      ? h(
          'div',
          { className: 'pgw-pager' },
          h('button', { type: 'button', className: 'pgw-btn', disabled: shown.page === 0, onClick: () => go(0) }, t('page.first')),
          h('button', { type: 'button', className: 'pgw-btn', disabled: shown.page === 0, onClick: () => go(shown.page - 1) }, t('page.prev')),
          h('span', { className: 'pgw-meta' }, t('page.of', { page: shown.page + 1, pages: shown.pages, n: o.recent.length })),
          h('button', { type: 'button', className: 'pgw-btn', disabled: shown.page >= shown.pages - 1, onClick: () => go(shown.page + 1) }, t('page.next')),
        )
      : null,
  )
}
