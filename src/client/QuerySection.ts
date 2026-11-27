/**
 * The history query under the card (docs/adr/0039): the counts above cover
 * every day on disk, so the list below has to reach past the memory's latest
 * records. A query is built a slice at a time; the page shows what is built,
 * says when it is still going, and asks for the next slice rather than
 * restarting.
 */
import { Button, IconRefreshOutlineRegular, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord } from '../records.ts'
import type { QueryEvent } from '../query.ts'
import type { Key, T } from './locales.ts'
import { RecordRow } from './StatsParts.ts'
import { failureText, fetchRecord, fetchRecords, type ClientCtx } from './rpc.ts'
import type { QueryState } from './view.ts'

/** The ranges the query offers; a custom range is a later slice. */
const RANGES = [
  { value: 'today', label: 'range.today' },
  { value: 'week', label: 'range.week' },
  { value: 'month', label: 'range.month' },
] as const

/** The events the query narrows by. */
const EVENTS = [
  { value: 'all', label: 'query.event.all' },
  { value: 'anomalies', label: 'query.event.anomalies' },
  { value: 'unmapped', label: 'query.event.unmapped' },
  { value: 'exfil', label: 'query.event.exfil' },
  { value: 'failed', label: 'query.event.failed' },
] as const

type Range = (typeof RANGES)[number]['value']

/** The local day `days` back from today, as the day files are named. */
function dayBefore(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - (days - 1))
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The day after today, so the range ends where the files do. */
function tomorrow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function QuerySection(props: { ctx: ClientCtx; t: T; sessionId?: string }): ReactNode {
  const { ctx, t } = props
  const [range, setRange] = useState<Range>('today')
  const [event, setEvent] = useState<QueryEvent>('anomalies')
  const [state, setState] = useState<QueryState | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ ref: string; record?: MaskRecord; failed?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const live = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const run = useCallback(
    (mode: Record<string, unknown>, signal: AbortSignal): void => {
      void fetchRecords(ctx, mode, signal).then((r) => {
        if (signal.aborted) return
        setBusy(false)
        if (!r.ok) {
          setState({ status: 'error', items: [], matched: 0, unmapped: 0, risk: 0, coverage: { storage: 'disk', scan: 'partial', reasons: [], detection: 'unknown' }, message: failureText(r.failure, t) })
          return
        }
        setState(r.value)
        // a build that is still going asks again on its own; one that ran out of
        // its slice waits for the reader to ask for the next one
        if (r.value.status === 'building' && r.value.retryMs !== undefined) {
          timer.current = setTimeout(() => {
            void fetchRecords(ctx, { mode: 'poll', queryId: r.value.queryId }, signal).then((again) => {
              if (signal.aborted || !again.ok) return
              setState(again.value)
            })
          }, r.value.retryMs)
        }
      })
    },
    [ctx, t],
  )

  // a new range or event is a new query: the old one is dropped
  useEffect(() => {
    live.current?.abort()
    const ac = new AbortController()
    live.current = ac
    setBusy(true)
    setOpen(null)
    setDetail(null)
    run({ mode: 'start', from: dayBefore(range === 'today' ? 1 : range === 'week' ? 7 : 30), to: tomorrow(), event, limit: 50, ...(props.sessionId ? { session: props.sessionId } : {}) }, ac.signal)
    return () => {
      ac.abort()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [range, event, props.sessionId, run])

  const again = (mode: Record<string, unknown>): void => {
    live.current?.abort()
    const ac = new AbortController()
    live.current = ac
    setBusy(true)
    run(mode, ac.signal)
  }

  const toggle = (ref: string): void => {
    if (open === ref) {
      setOpen(null)
      setDetail(null)
      return
    }
    setOpen(ref)
    setDetail({ ref })
    void fetchRecord(ctx, ref).then((r) => {
      setDetail({ ref, ...(r.ok && r.value ? { record: r.value } : { failed: true }) })
    })
  }

  const rows = state?.items ?? []
  const coverage = state?.coverage
  const status = (): string => {
    if (state === null) return t('query.loading')
    if (state.status === 'error') return t('query.failed', { message: state.message ?? '' })
    if (state.status === 'building') return t('query.building', { n: state.matched })
    if (state.status === 'paused') return t('query.paused', { reason: t(`query.reason.${state.reason}` as Key) })
    const parts = [t('query.matched', { n: state.matched })]
    if (state.unmapped > 0) parts.push(t('query.unmapped', { n: state.unmapped }))
    if (state.risk > 0) parts.push(t('query.risk', { n: state.risk }))
    if (coverage?.scan === 'partial') parts.push(t('query.partial'))
    return parts.join(' · ')
  }

  return h(
    'div',
    { className: 'pgw-query' },
    h(
      'div',
      { className: 'pgw-query__head' },
      h('span', { className: 'pgw-section__title' }, t('query.title')),
      h(
        'div',
        { className: 'pgw-query__controls' },
        h(SegmentedControl<Range>, {
          id: 'pgw-query-range',
          label: t('query.range'),
          value: range,
          options: RANGES.map((r) => ({ value: r.value, label: t(r.label as Key) })),
          onChange: setRange,
        }),
        h(SegmentedControl<QueryEvent>, {
          id: 'pgw-query-event',
          label: t('query.event'),
          value: event,
          options: EVENTS.map((e) => ({ value: e.value, label: t(e.label as Key) })),
          onChange: setEvent,
        }),
        h(
          Button,
          { variant: 'ghost', size: 'sm', disabled: busy, title: t('card.refresh'), 'aria-label': t('card.refresh'), onClick: () => again({ mode: 'start', from: dayBefore(range === 'today' ? 1 : range === 'week' ? 7 : 30), to: tomorrow(), event, limit: 50, ...(props.sessionId ? { session: props.sessionId } : {}) }) },
          h(IconRefreshOutlineRegular, { size: 14 }),
        ),
      ),
    ),
    h('div', { className: 'pgw-meta', role: 'status' }, status()),
    state?.status === 'paused' && state.canResume
      ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => again({ mode: 'resume', queryId: state.queryId }) }, t('query.resume'))
      : null,
    coverage?.detection === 'off' ? h('div', { className: 'pgw-meta' }, t('query.detectionOff')) : null,
    rows.length === 0
      ? h('div', { className: 'pgw-empty' }, t('query.empty'))
      : h(
          'ul',
          { className: 'pgw-recs__list', 'aria-label': t('query.title') },
          rows.map((row) =>
            h(
              'li',
              { key: row.ref, className: 'pgw-recs__item' },
              h(
                'button',
                {
                  type: 'button',
                  className: `pgw-rec${open === row.ref ? ' pgw-rec--open' : ''}`,
                  'aria-expanded': open === row.ref,
                  onClick: () => toggle(row.ref),
                },
                h('span', { className: 'pgw-rec__time' }, row.time.slice(11, 19)),
                h('span', { className: 'pgw-rec__step' }, row.turn !== undefined && row.step !== undefined ? `${row.turn}·${row.step}` : ''),
                h('span', { className: 'pgw-rec__where' }, row.model ?? row.host),
                h('span', { className: 'pgw-rec__from' }, row.from),
                h('span', { className: 'pgw-rec__num' }, String(row.n)),
                h('span', { className: 'pgw-rec__num pgw-rec__dim' }, `${row.restored}${row.unmapped > 0 ? ` ?${row.unmapped}` : ''}`),
              ),
              open === row.ref
                ? h(
                    'div',
                    { className: 'pgw-detail' },
                    detail?.record
                      ? h(RecordRow, { ctx, r: detail.record, open: true, toggle: () => toggle(row.ref), t, viewable: false })
                      : h('div', { className: 'pgw-empty' }, t(detail?.failed ? 'query.recordGone' : 'query.loading')),
                  )
                : null,
            ),
          ),
        ),
    state?.nextCursor ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => again({ mode: 'page', cursor: state.nextCursor }) }, t('query.more')) : null,
  )
}