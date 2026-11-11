/** The side-by-side view of one recorded request (docs/adr/0016): the agent's side has a marker where the vendor's has the stand-in. */
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord, ValueRecord } from '../records.ts'
import type { T } from './locales.ts'
import { failureText, fetchVendorView, type ClientCtx, type Failure } from './rpc.ts'
import { bodyLines, hintOf, valuesKey, viewLines, type ViewLine } from './view.ts'

type State = { status: 'loading' } | { status: 'gone' } | { status: 'error'; failure: Failure } | { status: 'ready'; body: string }

/** A value's marker on the agent's side: its kind, its hint and its length, never the value. */
function marker(v: ValueRecord | undefined, t: T): string {
  if (!v) return t('view.unknown')
  const action = v.action ? ` · ${t(v.action === 'warn' ? 'action.warn' : 'action.block')}` : ''
  const hint = hintOf(v)
  return `‹${v.kind} · ${hint ? `${hint} · ` : ''}${v.len}${action}›`
}

function side(line: ViewLine, by: Map<string, ValueRecord>, agent: boolean, t: T): ReactNode[] {
  return line.parts.map((p, i) =>
    p.id === undefined
      ? p.text
      : h('mark', { key: i, className: `pgw-view__mark${agent ? ' pgw-view__mark--agent' : ''}`, title: p.id }, agent ? marker(by.get(p.id), t) : p.text),
  )
}

export function VendorView(props: { ctx: ClientCtx; t: T; record: MaskRecord; onClose: () => void }): ReactNode {
  const { ctx, t, record } = props
  const [state, setState] = useState<State>({ status: 'loading' })
  const [onlyChanged, setOnlyChanged] = useState(true)
  useEffect(() => {
    const ac = new AbortController()
    setState({ status: 'loading' })
    void fetchVendorView(ctx, record.key, ac.signal).then((r) => {
      if (ac.signal.aborted) return
      setState(!r.ok ? { status: 'error', failure: r.failure } : r.value === null ? { status: 'gone' } : { status: 'ready', body: r.value })
    })
    return () => ac.abort()
  }, [ctx, record.key])
  // the card refreshes every 15 s and hands over a new record object each time; a body of up to 4 MiB is
  // worked over again only when the record or its placeholders are different
  const values = valuesKey(record.values)
  // keyed by the record and its placeholders on purpose, not by the record object
  const by = useMemo(() => new Map(record.values.map((v) => [v.placeholder, v])), [record.key, values])
  const body = state.status === 'ready' ? state.body : undefined
  // pretty-printing and splitting depend on the body alone
  const lines = useMemo(() => (body !== undefined ? bodyLines(body) : undefined), [body])
  const view = useMemo(() => (lines ? viewLines(lines, [...by.keys()], onlyChanged) : undefined), [lines, by, onlyChanged])
  const head = h(
    'div',
    { className: 'pgw-head' },
    h('span', { className: 'pgw-dist__title' }, t('view.title')),
    h(Checkbox, { checked: onlyChanged, label: t('view.onlyChanged'), className: 'pgw-meta', onChange: setOnlyChanged }),
    h('span', { className: 'pgw-spacer' }),
    h(Button, { variant: 'outline', size: 'sm', onClick: props.onClose }, t('view.close')),
  )
  if (!view) {
    const msg =
      state.status === 'loading'
        ? t('view.loading')
        : state.status === 'gone'
          ? t('view.gone')
          : state.status === 'error'
            ? t('view.failed', { reason: failureText(state.failure, t) })
            : t('card.unavailable')
    return h('div', { className: 'pgw-view' }, head, h('div', { className: 'pgw-empty' }, msg))
  }
  return h(
    'div',
    { className: 'pgw-view' },
    head,
    view.lines.length === 0
      ? h('div', { className: 'pgw-empty' }, t('view.none'))
      : h(
          'div',
          { className: 'pgw-view__scroll' },
          h(
            'table',
            { className: 'pgw-view__table' },
            h('thead', null, h('tr', null, h('th', null, t('view.line')), h('th', null, t('view.agent')), h('th', null, t('view.vendor')))),
            h(
              'tbody',
              null,
              view.lines.map((line) =>
                h(
                  'tr',
                  { key: line.n },
                  h('td', { className: 'pgw-view__n' }, line.n),
                  h('td', { className: 'pgw-view__code' }, ...side(line, by, true, t)),
                  h('td', { className: 'pgw-view__code' }, ...side(line, by, false, t)),
                ),
              ),
            ),
          ),
        ),
    view.truncated ? h('div', { className: 'pgw-meta' }, t('view.truncated', { n: view.lines.length })) : null,
  )
}
