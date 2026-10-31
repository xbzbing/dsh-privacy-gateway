/**
 * The slice of the Web shell's own controls this plugin renders, declared
 * ambiently because `@deepseek-ai/dsh-client-ui-primitives` is a platform seed
 * listed in package.json `dsh.client.inject`, not an installable dependency.
 * The shapes mirror the ones the official settings pages use.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { JSX, ReactNode } from 'react'

  /** One selectable menu row. */
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
  }
  /** A hairline between item groups (not selectable). */
  export interface MenuSeparator {
    type: 'separator'
    id: string
  }
  /** A non-interactive heading row above a group of items. */
  export interface MenuLabel {
    type: 'label'
    id: string
    text: string
  }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  /** Anchored dropdown menu; `open` is controlled and `onSelect` does not close it. */
  export function Menu(props: {
    open: boolean
    autoFocus?: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    children?: ReactNode
    footer?: readonly MenuEntry[]
    selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    selection?: 'check' | 'fill'
    className?: string | undefined
    listClassName?: string | undefined
  }): JSX.Element

  export const IconChevronDownOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconCloseSmallOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconPlusOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element

  /** A switch: `checked`, its accessible name, and the change it reports. */
  export function Switch(props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }): JSX.Element
  /** A checkbox row: `checked`, its label, and the change it reports. */
  export function Checkbox(props: { checked: boolean; label?: ReactNode; disabled?: boolean; onChange(next: boolean): void }): JSX.Element
  /** A button: `variant` picks the fill, `size` the density. */
  export function Button(props: {
    variant?: 'primary' | 'outline' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    disabled?: boolean
    onClick?(): void
    children?: ReactNode
    className?: string
    title?: string
    'aria-label'?: string
  }): JSX.Element
  /** The themed native input: every `<input>` attribute passes through. */
  export function Input(props: import('react').InputHTMLAttributes<HTMLInputElement> & { className?: string }): JSX.Element
  /** A small label pill. */
  export function Tag(props: { tone?: 'neutral' | 'outline' | 'solid' | 'success' | 'warning' | 'danger' | 'info'; className?: string; title?: string; children?: ReactNode }): JSX.Element
  export const IconCloseOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconRefreshOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconTrashOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconWarningOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconChevronRightOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  export const IconChevronLeftOutlineRegular: (props: { size?: number; className?: string }) => JSX.Element
  /** A row of mutually exclusive options. */
  export function SegmentedControl<V extends string>(props: {
    id: string
    label?: string
    value: V
    disabled?: boolean
    options: ReadonlyArray<{ value: V; label: ReactNode; title?: string; disabled?: boolean }>
    onChange(next: V): void
    className?: string
  }): JSX.Element
  /** The shell's confirmation for a risky step: an acknowledgement box gates the confirm button. */
  export function RiskConfirmation(props: {
    open: boolean
    title: string
    description: ReactNode
    acknowledgeLabel: string
    cancelLabel: string
    closeLabel: string
    confirmLabel: string
    acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange(next: boolean): void
    onCancel(): void
    onConfirm(): void
  }): JSX.Element
}
