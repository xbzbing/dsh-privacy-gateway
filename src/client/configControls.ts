/**
 * The configuration page's controls, built from the Web shell's own pieces:
 * the Switch, the Menu with the settings page's selector button (the one the
 * permission row opens), the themed Input, Button and Tag. A row puts a
 * switch, a choice or a count beside its words, as the settings page does, and
 * a list below them. Rows sit in folding sections, one per group, whose header
 * says the group's state while it is folded.
 */
import { Button, IconChevronDownOutlineRegular, IconCloseOutlineRegular, Input, Menu, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { addEntry, parseCount, removeEntry } from './fields.ts'
import type { T } from './locales.ts'

/**
 * A setting's row: its title, its description and an optional note, with the
 * control beside them (`inline`) or below. `titleId` names the title, for a
 * control that takes its accessible name from it.
 */
export function Row(props: { title: string; titleId?: string; hint: string; note?: ReactNode; inline: boolean; half: boolean; children?: ReactNode }): ReactNode {
  const cls = ['pgw-cfg__row', props.inline ? 'pgw-cfg__row--inline' : '', props.half ? 'pgw-cfg__row--half' : ''].filter(Boolean).join(' ')
  return h(
    'div',
    { className: cls },
    h('div', { className: 'pgw-cfg__text' }, h('div', { className: 'pgw-cfg__name', id: props.titleId }, props.title), h('div', { className: 'pgw-cfg__desc' }, props.hint), props.note ?? null),
    h('div', { className: 'pgw-cfg__control' }, props.children),
  )
}

/**
 * One group's folding section: a header button with the group's name, a
 * one-line summary of its state (shown folded) and a chevron; the rows below
 * only while open.
 */
export function Fold(props: { title: string; summary: ReactNode; open: boolean; toggleLabel: string; onToggle(): void; children?: ReactNode }): ReactNode {
  const id = useId()
  return h(
    'section',
    { className: 'pgw-fold', 'data-open': props.open || undefined },
    h(
      'h4',
      { className: 'pgw-fold__heading' },
      h(
        'button',
        { type: 'button', id: `${id}-h`, className: 'pgw-fold__head', 'aria-expanded': props.open, 'aria-controls': props.open ? `${id}-b` : undefined, title: props.toggleLabel, onClick: props.onToggle },
        h(IconChevronDownOutlineRegular, { className: 'pgw-fold__chevron' }),
        h('span', { className: 'pgw-fold__title' }, props.title),
        props.open ? null : h('span', { className: 'pgw-fold__summary' }, props.summary),
      ),
    ),
    props.open ? h('div', { id: `${id}-b`, role: 'region', 'aria-labelledby': `${id}-h`, className: 'pgw-fold__body' }, h('div', { className: 'pgw-fold__grid' }, props.children)) : null,
  )
}

export function SwitchControl(props: { label: string; checked: boolean; disabled: boolean; onChange(next: boolean): void }): ReactNode {
  return h(Switch, { checked: props.checked, label: props.label, disabled: props.disabled, onChange: props.onChange })
}

/**
 * The settings page's selector: a filled button with the current choice and a
 * chevron, opening the Menu below it. `multi` keeps the menu open and checks
 * every chosen row; otherwise a pick closes it. The button is named by the
 * row's title (`labelledBy`) followed by the current choice.
 */
export function Select(props: {
  label: string
  labelledBy?: string
  items: readonly MenuEntry[]
  disabled: boolean
  selectedId?: string
  selectedIds?: readonly string[]
  multi?: boolean
  onSelect(id: string): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const valueId = useId()
  useEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])
  return h(Menu, {
    open,
    onClose: () => setOpen(false),
    items: props.items,
    ...(props.multi ? { selectedIds: props.selectedIds ?? [], selection: 'check' as const } : { selectedId: props.selectedId }),
    onSelect: (id: string) => {
      if (!props.multi) setOpen(false)
      props.onSelect(id)
    },
    align: 'start',
    portal: true,
    anchor: h(
      'button',
      {
        type: 'button',
        className: 'pgw-select',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-labelledby': props.labelledBy ? `${props.labelledBy} ${valueId}` : undefined,
        disabled: props.disabled || props.items.length === 0,
        onClick: () => setOpen((was) => !was),
      },
      h('span', { className: 'pgw-select__label', id: valueId }, props.label),
      h(IconChevronDownOutlineRegular, { className: 'pgw-select__chevron' }),
    ),
  })
}

/**
 * A list of strings: an input that adds one on Enter or Add, and a tag with a
 * remove button for each. `onChange` resolves with whether the change was
 * saved; the typed entry is cleared only then, so a refused or cancelled one
 * can be tried again.
 */
export function ListEditor(props: { t: T; list: readonly string[]; anyCase: boolean; placeholder: string; disabled: boolean; onChange(next: string[]): Promise<boolean> }): ReactNode {
  const { t } = props
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const next = addEntry(props.list, draft, props.anyCase)
  const add = (): void => {
    if (!next || props.disabled || saving) return
    const sent = draft
    setSaving(true)
    void props.onChange(next).then((ok) => {
      setSaving(false)
      // the field may have been edited while the change was on its way: keep what is there now
      if (ok) setDraft((now) => (now === sent ? '' : now))
    })
  }
  return h(
    'div',
    { className: 'pgw-cfg__list' },
    h(
      'div',
      { className: 'pgw-cfg__add' },
      h(Input, {
        className: 'pgw-cfg__input',
        type: 'text',
        value: draft,
        placeholder: props.placeholder,
        'aria-label': props.placeholder,
        disabled: props.disabled,
        onChange: (e) => setDraft(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        },
      }),
      h(Button, { variant: 'outline', size: 'sm', disabled: props.disabled || saving || !next, onClick: add }, t('cfg.add')),
    ),
    props.list.length === 0
      ? h('div', { className: 'pgw-cfg__desc' }, t('cfg.listEmpty'))
      : h(
          'div',
          { className: 'pgw-cfg__tags' },
          props.list.map((entry) =>
            h(
              Tag,
              { key: entry, tone: 'neutral', className: 'pgw-cfg__tag', title: entry },
              h('span', { className: 'pgw-cfg__tagText' }, entry),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pgw-cfg__tagX',
                  'aria-label': t('cfg.remove', { name: entry }),
                  disabled: props.disabled,
                  onClick: () => void props.onChange(removeEntry(props.list, entry)),
                },
                h(IconCloseOutlineRegular, { size: 12 }),
              ),
            ),
          ),
        ),
  )
}

/**
 * A whole number, saved when the field loses focus or on Enter, and only when
 * valid and changed. A change that is not saved (refused, or not confirmed)
 * puts the saved number back.
 */
export function CountField(props: { t: T; value: number; min: number; label: string; disabled: boolean; onChange(next: number): Promise<boolean> }): ReactNode {
  const [draft, setDraft] = useState(String(props.value))
  // the number on its way: Enter, then the blur a confirmation dialog causes, must not send it twice
  const sending = useRef<number | undefined>(undefined)
  useEffect(() => setDraft(String(props.value)), [props.value])
  const parsed = parseCount(draft, props.min)
  const commit = (): void => {
    if (parsed === undefined || parsed === props.value || parsed === sending.current) return
    const saved = props.value
    sending.current = parsed
    void props.onChange(parsed).then((ok) => {
      sending.current = undefined
      if (!ok) setDraft(String(saved))
    })
  }
  return h(
    'div',
    { className: 'pgw-cfg__list' },
    h(Input, {
      className: 'pgw-cfg__input pgw-cfg__input--count',
      type: 'number',
      inputMode: 'numeric',
      min: props.min,
      step: 1,
      value: draft,
      'aria-label': props.label,
      'aria-invalid': parsed === undefined,
      disabled: props.disabled,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === 'Enter') commit()
      },
    }),
    parsed === undefined ? h('div', { className: 'pgw-cfg__desc pgw-cfg__desc--error', role: 'alert' }, props.t('cfg.countInvalid', { min: props.min })) : null,
  )
}
