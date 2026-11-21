/**
 * The empty state's diagram: what the gateway does to a request and its reply
 * (docs/adr/0001, docs/adr/0003). Drawn as inline SVG so it follows the theme's
 * colours through `--dsw-*`, needs no image asset, and scales with the panel.
 * The accent is the plugin's brand violet; the vendor box is green because the
 * model only ever sees placeholders, and the placeholder tags are amber because
 * a reply is not restored by default.
 */
import { createElement as h, useId } from 'react'
import type { ReactNode } from 'react'

import type { T } from './locales.ts'

/** One line of text in the drawing, centred on `x`. */
function label(x: number, y: number, cls: string, text: string): ReactNode {
  return h('text', { x, y, textAnchor: 'middle', className: cls }, text)
}

/** A small arrow marker in one of the two strokes; the id must be unique per page. */
function arrowHead(id: string, cls: string): ReactNode {
  return h(
    'marker',
    { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
    h('path', { d: 'M 0 0 L 10 5 L 0 10 z', className: cls }),
  )
}

export function PrincipleDiagram(props: { t: T }): ReactNode {
  const { t } = props
  // two cards (the tab and the detail page) can both draw this, so the ids are per instance
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const out = `pgw-diagram-out-${id}`
  const back = `pgw-diagram-back-${id}`
  return h(
    'div',
    { className: 'pgw-diagram' },
    h(
      'svg',
      { className: 'pgw-diagram__svg', viewBox: '0 0 640 200', role: 'img', 'aria-label': t('panel.diagramNote') },
      h('defs', null, arrowHead(out, 'pgw-diagram__head-out'), arrowHead(back, 'pgw-diagram__head-in')),
      // the boxes: the caller, the gateway, the model service — all centred on y=100
      h('rect', { x: 8, y: 68, width: 140, height: 64, rx: 10, className: 'pgw-diagram__box' }),
      h('rect', { x: 228, y: 52, width: 184, height: 96, rx: 10, className: 'pgw-diagram__gateway' }),
      h('rect', { x: 492, y: 68, width: 140, height: 64, rx: 10, className: 'pgw-diagram__vendor' }),
      label(78, 104, 'pgw-diagram__title', t('panel.diagramAgent')),
      label(320, 94, 'pgw-diagram__title', t('panel.diagramGateway')),
      label(320, 112, 'pgw-diagram__sub', t('panel.diagramGatewaySub')),
      label(562, 104, 'pgw-diagram__title', t('panel.diagramVendor')),
      // out on top, back underneath, both level with the boxes' centre line
      h('path', { d: 'M 148 84 L 228 84', className: 'pgw-diagram__out', markerEnd: `url(#${out})` }),
      h('path', { d: 'M 412 84 L 492 84', className: 'pgw-diagram__out', markerEnd: `url(#${out})` }),
      h('path', { d: 'M 492 116 L 412 116', className: 'pgw-diagram__in', markerEnd: `url(#${back})` }),
      h('path', { d: 'M 228 116 L 148 116', className: 'pgw-diagram__in', markerEnd: `url(#${back})` }),
      label(188, 75, 'pgw-diagram__label', t('panel.diagramRequest')),
      label(452, 75, 'pgw-diagram__chip', t('panel.diagramPlaceholder')),
      label(452, 129, 'pgw-diagram__chip', t('panel.diagramPlaceholder')),
      label(188, 129, 'pgw-diagram__label', t('panel.diagramReply')),
    ),
    h('p', { className: 'pgw-diagram__note' }, t('panel.diagramNote')),
    h('p', { className: 'pgw-diagram__hint' }, t('panel.empty')),
  )
}
