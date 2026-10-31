/** The pieces of the statistics card (StatsCard.ts), drawn with the Web shell's own controls. */
import { Button, IconChevronRightOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, RiskConfirmation, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, Fragment, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord, Totals } from '../records.ts'
import type { Key, T } from './locales.ts'
import { failureText, resetData, setSessionMasking, type ClientCtx } from './rpc.ts'
import { bars, hintOf, placeKey, timeLabel, took, type WarningKey } from './view.ts'
import { VendorView } from './VendorView.ts'

/** The signals worth a line of their own, one tinted line each with a warning icon. */
export function Notices(props: { t: T; items: Array<{ key: WarningKey; n: number; tone: 'error' | 'warn' }> }): ReactNode {
  if (props.items.length === 0) return null
  return h(
    'div',
    { className: 'pgw-notices', role: 'status' },
    props.items.map((w) =>
      h('div', { key: w.key, className: `pgw-notice pgw-notice--${w.tone}` }, h(IconWarningOutlineRegular, { size: 14, className: 'pgw-notice__icon' }), h('span', null, props.t(w.key, { n: w.n }))),
    ),
  )
}

interface Kpi {
  label: string
  value: string
  sub?: string
  tone?: 'warn' | 'error'
}

/** The counts of the range, one tile each in a single hairline-divided strip. */
export function Kpis(props: { totals: Totals; t: T }): ReactNode {
  const { totals: s, t } = props
  const n = (v: number | undefined): string => (v ?? 0).toLocaleString()
  const time = took(s)
  const tiles: Kpi[] = [
    { label: t('stat.requests'), value: n(s.requests) },
    { label: t('stat.masked'), value: n(s.masked) },
    { label: t('stat.n'), value: n(s.n) },
    { label: t('stat.restored'), value: n(s.restored), ...(s.restoredInTools > 0 ? { sub: t('stat.inTools', { n: s.restoredInTools }) } : {}) },
    { label: t('stat.unmapped'), value: n(s.unmapped), ...(s.unmapped > 0 ? { tone: 'warn' as const } : {}) },
    { label: t('stat.failed'), value: n(s.failed), ...(s.failed > 0 ? { tone: 'error' as const } : {}) },
  ]
  if ((s.warned ?? 0) > 0) tiles.push({ label: t('stat.warned'), value: n(s.warned), tone: 'warn' })
  if ((s.blocked ?? 0) > 0) tiles.push({ label: t('stat.blocked'), value: n(s.blocked), tone: 'warn' })
  if ((s.exfil ?? 0) > 0) tiles.push({ label: t('stat.exfil'), value: n(s.exfil), tone: 'error', ...((s.exfilBlocked ?? 0) > 0 ? { sub: t('stat.exfilBlocked', { n: s.exfilBlocked }) } : {}) })
  if (s.requests > 0) tiles.push({ label: t('stat.took'), value: t('stat.ms', { n: time.avg }), sub: t('stat.tookMax', { max: time.max }) })
  return h(
    'div',
    { className: 'pgw-kpis' },
    tiles.map((k) =>
      h(
        'div',
        { key: k.label, className: `pgw-kpi${k.tone ? ` pgw-kpi--${k.tone}` : ''}` },
        h('span', { className: 'pgw-kpi__label' }, k.label),
        h('span', { className: 'pgw-kpi__value' }, k.value),
        k.sub ? h('span', { className: 'pgw-kpi__sub' }, k.sub) : null,
      ),
    ),
  )
}

/** One distribution: its title, then a row per entry with a thin bar and the count. */
export function Dist(props: { title: string; data: Record<string, number>; empty: string }): ReactNode {
  const list = bars(props.data)
  return h(
    'div',
    { className: 'pgw-dist' },
    h('div', { className: 'pgw-section__title' }, props.title),
    list.length === 0
      ? h('div', { className: 'pgw-empty' }, props.empty)
      : list.map((b) =>
          h(
            'div',
            { className: 'pgw-bar', key: b.label },
            h('div', { className: 'pgw-bar__head' }, h('span', { className: 'pgw-bar__label', title: b.label }, b.label), h('span', { className: 'pgw-bar__value' }, b.value.toLocaleString())),
            h('div', { className: 'pgw-bar__track' }, h('div', { className: 'pgw-bar__fill', style: { width: `${b.pct}%` } })),
          ),
        ),
  )
}

/** The records' column heads, the same grid as each row; for the eye only, since each row names its columns itself. */
export function RecordHead(props: { t: T }): ReactNode {
  const { t } = props
  return h(
    'div',
    { className: 'pgw-rec pgw-rec--head', 'aria-hidden': true },
    h('span', null),
    h('span', null, t('recent.col.time')),
    h('span', null, t('recent.col.where')),
    h('span', null, t('recent.col.from')),
    h('span', { className: 'pgw-rec__num', title: t('recent.placesHint') }, t('recent.col.places')),
    h('span', { className: 'pgw-rec__num', title: t('recent.restoredHint') }, t('recent.col.restored')),
  )
}

/** One record: a row that opens onto its values and, when kept, the vendor view. */
export function RecordRow(props: { ctx: ClientCtx; r: MaskRecord; open: boolean; toggle: () => void; t: T; viewable: boolean }): ReactNode {
  const { r, t } = props
  const [viewing, setViewing] = useState(false)
  const detailId = useId()
  // who it came from: the workspace and the session, by name where the host could tell them (docs/adr/0020)
  const from = [r.workspace, r.title ?? r.session].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ')
  const places = r.failed
    ? h(Tag, { tone: 'danger' }, t('recent.failed'))
    : r.blocked
      ? h(Tag, { tone: 'danger' }, t('recent.blocked'))
      : h('span', { className: r.exfil ? 'pgw-rec__bad' : undefined }, r.n.toLocaleString())
  const placesWords = r.failed ? t('recent.failed') : r.blocked ? t('recent.blocked') : r.n.toLocaleString()
  // the row's name reads each column with its head, as the visual heads above it say them
  const name = [
    [t('recent.col.time'), timeLabel(r.time)],
    [t('recent.col.where'), [r.model ?? r.what, r.host].filter(Boolean).join(' · ')],
    [t('recent.col.from'), from],
    [t('recent.col.places'), placesWords],
    [t('recent.col.restored'), r.restored.toLocaleString()],
  ]
    .filter(([, v]) => v !== '')
    .map(([k, v]) => t('recent.cell', { name: k as string, value: v as string }))
    .join(t('recent.cellSep'))
  return h(
    'li',
    { className: 'pgw-recs__item' },
    h(
      'button',
      {
        type: 'button',
        className: `pgw-rec${r.n === 0 && !r.failed ? ' pgw-rec--zero' : ''}${props.open ? ' pgw-rec--open' : ''}`,
        'aria-expanded': props.open,
        'aria-controls': props.open ? detailId : undefined,
        'aria-label': name,
        onClick: props.toggle,
      },
      h(IconChevronRightOutlineRegular, { size: 12, className: 'pgw-rec__chevron' }),
      h('span', { className: 'pgw-rec__time' }, timeLabel(r.time)),
      h('span', { className: 'pgw-rec__where', title: [r.model, r.host].filter(Boolean).join(' · ') }, h('span', { className: 'pgw-rec__model' }, r.model ?? r.what), h('span', { className: 'pgw-rec__host' }, r.host)),
      h('span', { className: 'pgw-rec__from', title: from }, from),
      h('span', { className: 'pgw-rec__num' }, places),
      h('span', { className: 'pgw-rec__num pgw-rec__dim' }, r.restored.toLocaleString()),
    ),
    props.open
      ? h(
          'div',
          { className: 'pgw-detail', id: detailId },
          r.exfil ? h('div', { className: 'pgw-notice pgw-notice--error' }, h(IconWarningOutlineRegular, { size: 14, className: 'pgw-notice__icon' }), t('recent.exfil', { hosts: (r.exfilHosts ?? []).join(', ') })) : null,
          r.values.length === 0
            ? h('div', { className: 'pgw-empty' }, t('recent.noValues'))
            : h(
                'table',
                { className: 'pgw-values' },
                h('thead', null, h('tr', null, ...(['col.placeholder', 'col.kind', 'col.finder', 'col.head', 'col.len', 'col.n', 'col.action'] as Key[]).map((k) => h('th', { key: k }, t(k))))),
                h(
                  'tbody',
                  null,
                  r.values.flatMap((v) => [
                    h(
                      'tr',
                      { key: v.placeholder, className: v.before !== undefined || v.after !== undefined ? 'pgw-values__has' : undefined },
                      h('td', { className: 'pgw-mono' }, v.placeholder),
                      h('td', null, v.kind),
                      h('td', null, v.finder),
                      h('td', { className: 'pgw-mono' }, hintOf(v)),
                      h('td', null, v.len),
                      h('td', null, v.n),
                      h('td', null, v.action ? t(v.action === 'warn' ? 'action.warn' : 'action.block') : ''),
                    ),
                    v.before !== undefined || v.after !== undefined
                      ? h(
                          'tr',
                          { key: `${v.placeholder}:ctx`, className: 'pgw-values__ctx' },
                          h(
                            'td',
                            { colSpan: 7 },
                            v.at ? h(Tag, { tone: 'neutral', className: 'pgw-ctx__place', title: v.at.path }, t(placeKey(v.at))) : null,
                            h('span', { className: 'pgw-ctx__text', title: t('recent.contextHint') }, v.before ?? '', h('mark', { className: 'pgw-ctx__mark pgw-mono' }, v.placeholder), v.after ?? ''),
                          ),
                        )
                      : null,
                  ]),
                ),
              ),
          props.viewable && !viewing ? h('div', null, h(Button, { variant: 'outline', size: 'sm', onClick: () => setViewing(true) }, t('view.open'))) : null,
          props.viewable && viewing ? h(VendorView, { ctx: props.ctx, t, record: r, onClose: () => setViewing(false) }) : null,
        )
      : null,
  )
}

/** The reset button and its confirmation: the box must be checked before Clear is offered. */
export function ResetButton(props: { ctx: ClientCtx; t: T; onDone(message: string, ok: boolean): void }): ReactNode {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const close = (): void => {
    setOpen(false)
    setAck(false)
  }
  const run = (): void => {
    setBusy(true)
    void resetData(props.ctx).then((r) => {
      setBusy(false)
      close()
      props.onDone(r.ok ? t('card.resetDone', { n: r.value }) : t('card.resetFailed', { message: failureText(r.failure, t) }), r.ok)
    })
  }
  return h(
    Fragment,
    null,
    h(Button, { variant: 'ghost', size: 'sm', className: 'pgw-reset', disabled: busy, onClick: () => setOpen(true) }, h(IconTrashOutlineRegular, { size: 14 }), h('span', null, t('card.reset'))),
    h(RiskConfirmation, {
      open,
      title: t('card.resetTitle'),
      description: t('card.resetBody'),
      acknowledgeLabel: t('card.resetAck'),
      cancelLabel: t('card.cancel'),
      closeLabel: t('card.close'),
      confirmLabel: t('card.resetConfirm'),
      acknowledged: ack,
      disabled: busy,
      onAcknowledgedChange: setAck,
      onCancel: close,
      onConfirm: run,
    }),
  )
}

/**
 * The session tab's masking switch (docs/adr/0023). Turning it off asks
 * first, since this session's requests then go out as they are; turning it
 * back on takes effect at once.
 */
export function SessionSwitch(props: { ctx: ClientCtx; t: T; session: string; on: boolean; onDone(message: string | null): void }): ReactNode {
  const { t } = props
  const [on, setOn] = useState(props.on)
  const [asking, setAsking] = useState(false)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => setOn(props.on), [props.on])
  const close = (): void => {
    setAsking(false)
    setAck(false)
  }
  const apply = (next: boolean): void => {
    setBusy(true)
    void setSessionMasking(props.ctx, props.session, next).then((r) => {
      setBusy(false)
      close()
      if (r.ok) setOn(r.value)
      props.onDone(r.ok ? null : t('session.failed', { message: failureText(r.failure, t) }))
    })
  }
  return h(
    Fragment,
    null,
    // the visible words are the switch's label: they name it, and a click on them flips it
    h(
      'label',
      { className: 'pgw-session' },
      h(Switch, { checked: on, disabled: busy, onChange: (next) => (next ? apply(true) : setAsking(true)) }),
      h('span', { className: 'pgw-session__label' }, t('session.mask')),
    ),
    h(RiskConfirmation, {
      open: asking,
      title: t('session.offTitle'),
      description: t('session.offBody'),
      acknowledgeLabel: t('session.offAck'),
      cancelLabel: t('card.cancel'),
      closeLabel: t('card.close'),
      confirmLabel: t('session.offConfirm'),
      acknowledged: ack,
      disabled: busy,
      onAcknowledgedChange: setAck,
      onCancel: close,
      onConfirm: () => apply(false),
    }),
  )
}
