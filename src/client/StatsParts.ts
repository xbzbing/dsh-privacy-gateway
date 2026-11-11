/** The pieces of the statistics card (StatsCard.ts), drawn with the Web shell's own controls. */
import {
  Button,
  HoverCard,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconInfoOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  RiskConfirmation,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, Fragment, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'

import type { MaskRecord, Totals } from '../records.ts'
import type { Key, T } from './locales.ts'
import { failureText, resetData, setSessionMasking, type ClientCtx } from './rpc.ts'
import { bars, elsewhereText, filterValues, finderHintKey, hintOf, kindHintKey, namesOf, placeKey, placeLabel, stepLabel, stepOf, timeLabel, took, type WarningKey } from './view.ts'
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

/**
 * What kind and finder mean, for the shell's hover card (docs/adr/0035).
 * The shell's card is a fixed 244px wide, so this says only the definition:
 * a table of the names would be squeezed into a tall column.
 */
export function HintCard(props: { t: T; field: 'kind' | 'finder'; note?: boolean }): ReactNode {
  const { t, field } = props
  return h(
    'div',
    { className: 'pgw-hint' },
    h('div', { className: 'pgw-hint__title' }, t(field === 'kind' ? 'hint.kind.title' : 'hint.finder.title')),
    h('div', { className: 'pgw-hint__body' }, t(field === 'kind' ? 'hint.kind.body' : 'hint.finder.body')),
    props.note === true ? h('div', { className: 'pgw-hint__note' }, t('hint.count')) : null,
  )
}

/** One name and what it stands for, for the hover card on that name. */
function NameHint(props: { t: T; name: string; meaning: Key }): ReactNode {
  return h('div', { className: 'pgw-hint' }, h('div', { className: 'pgw-hint__title pgw-mono' }, props.name), h('div', { className: 'pgw-hint__body' }, props.t(props.meaning)))
}

/**
 * One distribution: the title explains the dimension, each name explains
 * itself, then a row per entry with a thin bar and the count. The entries past
 * the sixth are summed into one row (`others`) rather than dropped. The
 * hover cards are only for kind and finder; a host explains nothing.
 */
export function Dist(props: { t: T; title: string; data: Record<string, number>; empty: string; others: string; field?: 'kind' | 'finder' }): ReactNode {
  const { t, field } = props
  const list = bars(props.data, 6, props.others)
  const head =
    field === undefined
      ? props.title
      : h(HoverCard, {
          anchor: h('span', { className: 'pgw-dist__anchor' }, props.title, h(IconInfoOutlineRegular, { size: 12, className: 'pgw-dist__info' })),
          content: h(HintCard, { t, field, note: true }),
        })
  return h(
    'div',
    { className: 'pgw-dist' },
    h('div', { className: 'pgw-section__title' }, head),
    list.length === 0
      ? h('div', { className: 'pgw-empty' }, props.empty)
      : list.map((b) => {
          const key = field === undefined ? undefined : (field === 'kind' ? kindHintKey : finderHintKey)(b.label)
          // the help cursor and the native title stay only where no card explains the name (the host rows and the summed one)
          const label = h('span', key === undefined ? { className: 'pgw-bar__label', title: b.label } : { className: 'pgw-bar__label pgw-bar__label--hint' }, b.label)
          const labelNode = key === undefined || field === undefined ? label : h(HoverCard, { anchor: label, content: h(NameHint, { t, name: b.label, meaning: key }) })
          return h(
            'div',
            { className: 'pgw-bar', key: b.label },
            h('div', { className: 'pgw-bar__head' }, labelNode, h('span', { className: 'pgw-bar__value' }, b.value.toLocaleString())),
            h('div', { className: 'pgw-bar__track' }, h('div', { className: 'pgw-bar__fill', style: { width: `${b.pct}%` } })),
          )
        }),
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
    h('span', { title: t('recent.stepHint') }, t('recent.col.step')),
    h('span', null, t('recent.col.where')),
    h('span', null, t('recent.col.from')),
    h('span', { className: 'pgw-rec__num', title: t('recent.placesHint') }, t('recent.col.places')),
    h('span', { className: 'pgw-rec__num', title: t('recent.restoredHint') }, t('recent.col.restored')),
  )
}

/** The menu's id for the row that takes a filter off. */
const ANY = '*'

/**
 * A kind or finder column head: the shell's menu narrows the rows below to one
 * name, and the hover card says what the dimension and each name mean
 * (docs/adr/0035). The two columns narrow together.
 */
function FilterHead(props: { t: T; field: 'kind' | 'finder'; names: readonly string[]; value: string | undefined; hint: ReactNode; onChange(next: string | undefined): void }): ReactNode {
  const { t, field } = props
  const [open, setOpen] = useState(false)
  const label = t(field === 'kind' ? 'col.kind' : 'col.finder')
  const items: MenuEntry[] = [{ id: ANY, label: t('filter.all') }, ...props.names.map((name) => ({ id: name, label: name }))]
  const button = h(
    'button',
    {
      type: 'button',
      className: `pgw-filter${props.value === undefined ? '' : ' pgw-filter--on'}`,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-label': t('filter.aria', { name: t(field === 'kind' ? 'filter.kind' : 'filter.finder'), value: props.value ?? t('filter.all') }),
      onClick: () => setOpen((was) => !was),
    },
    props.value === undefined ? label : `${label} · ${props.value}`,
    h(IconChevronDownOutlineRegular, { size: 10, className: 'pgw-filter__chevron' }),
  )
  return h(Menu, {
    open,
    onClose: () => setOpen(false),
    items,
    selectedId: props.value ?? ANY,
    onSelect: (id: string) => {
      setOpen(false)
      props.onChange(id === ANY ? undefined : id)
    },
    align: 'start',
    portal: true,
    // the menu and the explanation must not open over each other: while the menu is up, hovering only moves the pointer
    anchor: h(HoverCard, { anchor: button, content: props.hint, disabled: open }),
  })
}

/** One record: a row that opens onto its values and, when kept, the vendor view. */
export function RecordRow(props: { ctx: ClientCtx; r: MaskRecord; open: boolean; toggle: () => void; t: T; viewable: boolean }): ReactNode {
  const { r, t } = props
  const [viewing, setViewing] = useState(false)
  // the values table narrowed to one kind and one finder, as its column heads pick them (docs/adr/0035)
  const [kind, setKind] = useState<string | undefined>(undefined)
  const [finder, setFinder] = useState<string | undefined>(undefined)
  const shown = filterValues(r.values, { ...(kind === undefined ? {} : { kind }), ...(finder === undefined ? {} : { finder }) })
  const kindNames = namesOf(r.values, 'kind')
  const finderNames = namesOf(r.values, 'finder')
  const detailId = useId()
  // where the request sat in its session: the turn and step the trajectory names it by (docs/adr/0030)
  const at = stepOf(r)
  const stepWords = at ? t('recent.stepAt', at) : ''
  // the details say it in full: the step the request went out in, not the step a value came from
  const stepLine = at ? t('recent.stepSent', at) : ''
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
    [t('recent.col.step'), stepWords],
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
      h('span', { className: 'pgw-rec__step', title: stepWords || undefined }, at ? stepLabel(at) : ''),
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
          at ? h('div', { className: 'pgw-meta' }, stepLine) : null,
          r.values.length === 0
            ? h('div', { className: 'pgw-empty' }, t('recent.noValues'))
            : h(
                'table',
                { className: 'pgw-values' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { key: 'col.placeholder' }, t('col.placeholder')),
                    h(
                      'th',
                      { key: 'col.kind' },
                      h(FilterHead, { t, field: 'kind', names: kindNames, value: kind, hint: h(HintCard, { t, field: 'kind' }), onChange: setKind }),
                    ),
                    h(
                      'th',
                      { key: 'col.finder' },
                      h(FilterHead, { t, field: 'finder', names: finderNames, value: finder, hint: h(HintCard, { t, field: 'finder' }), onChange: setFinder }),
                    ),
                    h('th', { key: 'col.head' }, t('col.head')),
                    h('th', { key: 'col.len' }, t('col.len')),
                    h('th', { key: 'col.n' }, t('col.n')),
                    h('th', { key: 'col.action' }, t('col.action')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  shown.length === 0
                    ? h('tr', { key: 'none', className: 'pgw-values__empty' }, h('td', { colSpan: 7 }, t('filter.none')))
                    : shown.flatMap((v) => {
                      const elsewhere = elsewhereText(v, t)
                      // a value this run sent before says where it first went (docs/adr/0030)
                      const firstText = v.first ? t('recent.valueFirst', { turn: v.first.turn, step: v.first.step }) : at ? t('recent.valueFirstHere') : ''
                      // the row shows where the value went and what was around it: either alone is worth a line
                      const placed = v.at !== undefined || v.before !== undefined || v.after !== undefined || elsewhere !== '' || firstText !== ''
                      return [
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
                        placed
                          ? h(
                              'tr',
                              { key: `${v.placeholder}:ctx`, className: 'pgw-values__ctx' },
                              h(
                                'td',
                                { colSpan: 7 },
                                h(
                                  'div',
                                  { className: 'pgw-ctx' },
                                  h(
                                    'div',
                                    { className: 'pgw-ctx__line' },
                                    v.at
                                      ? h(Tag, { tone: 'neutral', className: 'pgw-ctx__place', title: v.at.path }, t(placeKey(v.at)), h('span', { className: 'pgw-ctx__path pgw-mono' }, `· ${placeLabel(v.at.path)}`))
                                      : null,
                                    v.before !== undefined || v.after !== undefined
                                      ? h('span', { className: 'pgw-ctx__text', title: t('recent.contextHint') }, v.before ?? '', h('mark', { className: 'pgw-ctx__mark pgw-mono' }, v.placeholder), v.after ?? '')
                                      : null,
                                  ),
                                  elsewhere !== '' ? h('div', { className: 'pgw-ctx__more' }, elsewhere) : null,
                                  firstText !== '' ? h('div', { className: 'pgw-ctx__more' }, firstText) : null,
                                ),
                              ),
                            )
                          : null,
                      ]
                    }),
                ),
              ),
          r.valuesOmitted ? h('div', { className: 'pgw-meta' }, t('recent.omitted', { n: r.valuesOmitted.toLocaleString() })) : null,
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
      h(Switch, { checked: on, label: t('session.mask'), disabled: busy, onChange: (next) => (next ? apply(true) : setAsking(true)) }),
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
