/** The side-by-side view of one recorded request (docs/adr/0016): the agent's side has a marker where the vendor's has the stand-in. */
import { createElement as h, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord, ValueRecord } from '../records.ts'
import type { T } from './locales.ts'
import { fetchVendorView, type ClientCtx } from './rpc.ts'
import { hintOf, viewLines, type ViewLine } from './view.ts'

type State = { status: 'loading' } | { status: 'gone' } | { status: 'error' } | { status: 'ready'; body: string }

/** A value's marker on the agent's side: its kind, its hint and its length, never the value. */
function marker(v: ValueRecord | undefined, t: T): string {
  if (!v) return '‹?›'
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
      setState(!r.ok ? { status: 'error' } : r.body === null ? { status: 'gone' } : { status: 'ready', body: r.body })
    })
    return () => ac.abort()
  }, [ctx, record.key])
  const by = useMemo(() => new Map(record.values.map((v) => [v.placeholder, v])), [record])
  const view = useMemo(() => (state.status === 'ready' ? viewLines(state.body, [...by.keys()], onlyChanged) : undefined), [state, by, onlyChanged])
  const head = h(
    'div',
    { className: 'pgw-head' },
    h('span', { className: 'pgw-dist__title' }, t('view.title')),
    h(
      'label',
      { className: 'pgw-meta pgw-check' },
      h('input', { type: 'checkbox', checked: onlyChanged, onChange: () => setOnlyChanged(!onlyChanged) }),
      t('view.onlyChanged'),
    ),
    h('span', { className: 'pgw-spacer' }),
    h('button', { type: 'button', className: 'pgw-btn', onClick: props.onClose }, t('view.close')),
  )
  if (!view) {
    const msg = state.status === 'loading' ? 'view.loading' : state.status === 'gone' ? 'view.gone' : 'card.unavailable'
    return h('div', { className: 'pgw-view' }, head, h('div', { className: 'pgw-empty' }, t(msg)))
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
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('view.agent')), h('th', null, t('view.vendor')))),
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
