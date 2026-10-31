/**
 * The shell's own controls (`@deepseek-ai/dsh-client-ui-primitives`), so this
 * plugin's page looks like the rest of DSH instead of drawing its own. The
 * package is a module the Web shell registers for client halves; a deployment
 * that does not offer it falls back to plain elements, and the page still works.
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'

/** The controls this page uses, as the shell's package spells them. */
export interface UiControl {
  /** `checked` + `label` + `onChange(next)`, and `disabled`. */
  Switch?: (props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }) => ReactNode
  /** `checked` + `label` + `onChange(next)`, and `disabled`. */
  Checkbox?: (props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }) => ReactNode
  /** `variant` + `size` + `onClick` + children. */
  Button?: (props: { variant?: string; size?: string; disabled?: boolean; onClick?(): void; children?: ReactNode }) => ReactNode
}

declare const require: (id: string) => unknown

let loaded: UiControl | null | undefined

/** The shell's controls, or undefined where the shell does not provide them. */
export function controls(): UiControl | undefined {
  if (loaded !== undefined) return loaded ?? undefined
  try {
    const mod = require('@deepseek-ai/dsh-client-ui-primitives') as UiControl | undefined
    loaded = mod !== undefined && typeof mod === 'object' ? mod : null
  } catch {
    loaded = null
  }
  return loaded ?? undefined
}

/** A switch, as the shell draws one, or a plain checkbox where it has none. */
export function switchOf(props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }): ReactNode {
  const Switch = controls()?.Switch
  if (Switch) return h(Switch, props)
  return h('label', { className: 'pgw-fallback pgw-fallback--switch' }, h('input', { type: 'checkbox', role: 'switch', checked: props.checked, disabled: props.disabled, onChange: () => props.onChange(!props.checked) }), props.label)
}

/** A checkbox, as the shell draws one, or a plain input where it has none. */
export function checkboxOf(props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }): ReactNode {
  const Checkbox = controls()?.Checkbox
  if (Checkbox) return h(Checkbox, props)
  return h('label', { className: 'pgw-fallback pgw-fallback--check' }, h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: () => props.onChange(!props.checked) }), props.label)
}

/** A button, as the shell draws one, or a plain one where it has none. */
export function buttonOf(props: { variant?: string; size?: string; disabled?: boolean; onClick?(): void; children?: ReactNode }): ReactNode {
  const Button = controls()?.Button
  if (Button) return h(Button, props)
  return h('button', { type: 'button', className: 'pgw-btn', disabled: props.disabled, onClick: props.onClick }, props.children)
}
