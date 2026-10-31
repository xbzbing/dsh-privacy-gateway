/**
 * The configuration page's controls, built from the Web shell's own pieces:
 * the Switch, the Menu with the settings page's selector button (the one the
 * permission row opens), the themed Input, Button and Tag. Each row is title,
 * description, then the control, stacked on the left.
 */
import { Button, IconChevronDownOutlineRegular, IconCloseOutlineRegular, Input, Menu, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { addEntry, parseCount, removeEntry } from './fields.ts'
import type { T } from './locales.ts'

/** A setting's row: its title, its description, an optional note, then the control. */
export function Row(props: { title: string; hint: string; note?: ReactNode; children?: ReactNode }): ReactNode {
  return h(
    'div',
    { className: 'pgw-cfg__row' },
    h('div', { className: 'pgw-cfg__text' }, h('div', { className: 'pgw-cfg__name' }, props.title), h('div', { className: 'pgw-cfg__desc' }, props.hint), props.note ?? null),
    h('div', { className: 'pgw-cfg__control' }, props.children),
  )
}

export function SwitchControl(props: { label: string; checked: boolean; disabled: boolean; onChange(next: boolean): void }): ReactNode {
  return h(Switch, { checked: props.checked, label: props.label, disabled: props.disabled, onChange: props.onChange })
}

/**
 * The settings page's selector: a filled button with the current choice and a
 * chevron, opening the Menu below it. `multi` keeps the menu open and checks
 * every chosen row; otherwise a pick closes it.
 */
export function Select(props: {
  label: string
  items: readonly MenuEntry[]
  disabled: boolean
  selectedId?: string
  selectedIds?: readonly string[]
  multi?: boolean
  onSelect(id: string): void
}): ReactNode {
  const [open, setOpen] = useState(false)
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
        disabled: props.disabled || props.items.length === 0,
        onClick: () => setOpen((was) => !was),
      },
      h('span', { className: 'pgw-select__label' }, props.label),
      h(IconChevronDownOutlineRegular, { className: 'pgw-select__chevron' }),
    ),
  })
}

/** A list of strings: an input that adds one on Enter or Add, and a tag with a remove button for each. */
export function ListEditor(props: { t: T; list: readonly string[]; anyCase: boolean; placeholder: string; disabled: boolean; onChange(next: string[]): void }): ReactNode {
  const { t } = props
  const [draft, setDraft] = useState('')
  const next = addEntry(props.list, draft, props.anyCase)
  const add = (): void => {
    if (!next || props.disabled) return
    setDraft('')
    props.onChange(next)
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
      h(Button, { variant: 'outline', size: 'sm', disabled: props.disabled || !next, onClick: add }, t('cfg.add')),
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
                  onClick: () => props.onChange(removeEntry(props.list, entry)),
                },
                h(IconCloseOutlineRegular, { size: 12 }),
              ),
            ),
          ),
        ),
  )
}

/** A whole number, saved when the field loses focus or on Enter, and only when valid and changed. */
export function CountField(props: { t: T; value: number; min: number; label: string; disabled: boolean; onChange(next: number): void }): ReactNode {
  const [draft, setDraft] = useState(String(props.value))
  useEffect(() => setDraft(String(props.value)), [props.value])
  const parsed = parseCount(draft, props.min)
  const commit = (): void => {
    if (parsed === undefined) return
    if (parsed !== props.value) props.onChange(parsed)
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
