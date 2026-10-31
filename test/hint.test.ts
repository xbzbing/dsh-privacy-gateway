import test from 'node:test'
import assert from 'node:assert/strict'

import { hint } from '../src/redact/find.ts'
import { KEY_KINDS, keyHead } from '../src/redact/shape.ts'

const KINDS = ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PRIVATE_KEY', 'COOKIE', 'TERM', 'EMAIL', 'PHONE']
const PERSONAL = new Set(['EMAIL', 'PHONE'])
// value starts that once read as a public prefix, and real ones
const STARTS = ['', 'AKIA', 'abc_', 'pass-', 'ab-', 'x_', 'sk-', 'sk-proj-', 'ghp_', 'xoxb-', 'oc_sk_', 'Pass-']
const BODY = 'Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY'

/** How many of v's characters the hint shows that are not a public prefix, and how many follow that prefix. */
function shown(kind: string, v: string): { visible: number; rest: number } {
  const h = hint(kind, v, PERSONAL.has(kind))
  const len = [...v].length
  assert.equal(h.len, len)
  assert.ok(v.startsWith(h.head), `${kind} ${v}: head ${h.head}`)
  if (h.tail) assert.ok(v.endsWith(h.tail), `${kind} ${v}: tail ${h.tail}`)
  const prefix = KEY_KINDS.has(kind) && !PERSONAL.has(kind) ? keyHead(v).length : 0
  assert.ok(h.head.length >= Math.min(prefix, h.head.length))
  return { visible: h.head.length - Math.min(prefix, h.head.length) + (h.tail?.length ?? 0), rest: len - prefix }
}

test('a hint never shows a short value or most of one, for every kind and length', () => {
  for (const kind of KINDS) {
    for (const start of STARTS) {
      for (let n = 0; n <= BODY.length; n++) {
        const v = start + BODY.slice(0, n)
        if (v.length < 2) continue
        const { visible, rest } = shown(kind, v)
        assert.ok(rest - visible >= Math.max(4, Math.ceil(rest / 2)) || visible === 0, `${kind} ${v}: ${visible} of ${rest} shown`)
      }
    }
  }
})

test('only a vendor key keeps its known prefix; other values and made-up prefixes stay hidden', () => {
  assert.deepEqual(hint('SECRET', 'AKIA12', false), { head: 'AK', len: 6 })
  assert.deepEqual(hint('API_KEY', 'AKIA12', false), { head: 'AKIA', len: 6 })
  assert.deepEqual(hint('PASSWORD', 'abc_d1', false), { head: 'ab', len: 6 })
  assert.deepEqual(hint('PASSWORD', 'pass-wd', false), { head: 'pa', len: 7 })
  assert.deepEqual(hint('PASSWORD', 'Pass-w0rd!', false), { head: 'Pas', tail: '!', len: 10 })
  assert.deepEqual(hint('API_KEY', 'abcd_' + BODY, false), { head: 'abcd', tail: 'wY', len: 5 + BODY.length })
  assert.deepEqual(hint('API_KEY', 'xoxb-' + BODY, false), { head: 'xoxb-Zq7L', tail: 'wY', len: 5 + BODY.length })
  assert.equal(keyHead('pass-' + BODY), '')
  assert.equal(keyHead('oc_sk_' + BODY), 'oc_sk_')
})

test('a made-up key keeps only a vendor key\'s known prefix', async () => {
  const { shapeOf } = await import('../src/redact/shape.ts')
  const k = new Uint8Array(32).fill(7)
  const v = 'abcd_' + BODY
  assert.ok(!(shapeOf(k, 'PASSWORD', v) ?? 'abcd_').startsWith('abcd_'))
  assert.ok(!(shapeOf(k, 'API_KEY', v) ?? 'abcd_').startsWith('abcd_'))
  assert.ok(shapeOf(k, 'API_KEY', 'xoxb-' + BODY)?.startsWith('xoxb-'))
  assert.ok(!shapeOf(k, 'PASSWORD', 'xoxb-' + BODY)?.startsWith('xoxb-'))
})
