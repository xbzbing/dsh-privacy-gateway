import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { defaults, resolveConfig } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { keyHead, shapeOf } from '../src/redact/shape.ts'

const KEY = 'sk-' + 'proj-w3axCByTQgK1Px9mZq7Lr2Vt'
const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const HEX = 'deadbeef0123456789abcdef01234567'
const chat = (content: string) => JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }
const enc = new TextEncoder()

function engine(over: Record<string, unknown> = {}) {
  return new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, personal: true, shape: true, ...over }))
}

function sent(ex: { text: string }): string {
  return (JSON.parse(ex.text) as { messages: Array<{ content: string }> }).messages[0]?.content ?? ''
}

function sameForm(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string
    const y = b[i] as string
    const cls = (c: string) => (/[A-Z]/.test(c) ? 'A' : /[a-z]/.test(c) ? 'a' : /[0-9]/.test(c) ? '0' : c)
    if (cls(x) !== cls(y) && !(/[0-9a-f]/.test(x) && /[0-9a-f]/.test(y))) return false
  }
  return true
}

test('a made-up key keeps the head, the length, the separators and the kind of each character', () => {
  const k = randomBytes(32)
  assert.equal(keyHead(KEY), 'sk-proj-')
  assert.equal(keyHead(GH), 'ghp_')
  assert.equal(keyHead('AKIA' + 'IOSFODNN7EXAMPLE'), 'AKIA')
  for (const v of [KEY, GH, HEX, 'AKIA' + 'IOSFODNN7EXAMPLE']) {
    const f = shapeOf(k, 'API_KEY', v)
    assert.ok(f && f !== v, v)
    assert.ok(f.startsWith(keyHead(v)))
    assert.ok(sameForm(v, f), `${v} → ${f}`)
    assert.equal(shapeOf(k, 'API_KEY', v), f)
  }
  assert.match(shapeOf(k, 'API_KEY', HEX) ?? '', /^[0-9a-f]+$/)
  // personal data, the user's words, short values and other characters go as placeholders
  assert.equal(shapeOf(k, 'EMAIL', 'abcdefghij'), undefined)
  assert.equal(shapeOf(k, 'TERM', 'abcdefghij'), undefined)
  assert.equal(shapeOf(k, 'SECRET', 'short'), undefined)
  assert.equal(shapeOf(k, 'PASSWORD', 'pa$$word!longer'), undefined)
})

test('shape sends a key as a made-up one, the same every turn, and puts it back in the reply', () => {
  const e = engine()
  const a = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(a)
  const f = sent(a).slice(4)
  assert.ok(!a.text.includes(KEY) && !a.text.includes('{{'))
  assert.ok(sameForm(KEY, f))
  assert.equal(a.restoreBody(JSON.stringify({ choices: [{ message: { content: `use ${f}.` } }] })), JSON.stringify({ choices: [{ message: { content: `use ${KEY}.` } }] }))
  a.finish()
  const b = e.maskRequest(chat(`again ${KEY}`), info)
  assert.equal(b && sent(b), `again ${f}`)
  const [r] = e.records.recent()
  assert.equal(r?.values[0]?.placeholder, f)
  assert.equal(r?.restored, 1)
})

test('a name before the key stays; personal data still goes as a placeholder', () => {
  const e = engine()
  const ex = e.maskRequest(chat(`OPENAI_API_KEY=${KEY} mail rina.k@kowalczyk.pl`), info)
  assert.ok(ex)
  const s = sent(ex)
  assert.match(s, /^OPENAI_API_KEY=sk-proj-[A-Za-z0-9]{24} mail \{\{EMAIL_[a-z2-7]{8}\}\}$/)
})

test('a made-up key that comes back in the history is not masked again', () => {
  const e = engine()
  const a = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(a)
  const f = sent(a).slice(4)
  const b = e.maskRequest(chat(`the vendor wrote ${f}`), info)
  assert.ok(b)
  assert.equal(sent(b), `the vendor wrote ${f}`)
})

test('a made-up key split between two stream events comes back whole', () => {
  const e = engine()
  const a = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(a)
  const f = sent(a).slice(4)
  const ev = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
  const r = a.streamRestorer()
  const out = r.push(enc.encode(ev(`k=${f.slice(0, 12)}`))) + r.push(enc.encode(ev(`${f.slice(12)} ok`))) + r.end()
  const text = out
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => (JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content: string } }> }).choices[0]?.delta.content)
    .join('')
  assert.equal(text, `k=${KEY} ok`)
})

test('a made-up key in a tool call\'s arguments comes back escaped as JSON needs, counted as in tools', () => {
  const e = engine()
  const a = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(a)
  const f = sent(a).slice(4)
  const body = JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ cmd: `export K=${f}` }) } }] } }] })
  const out = JSON.parse(a.restoreBody(body)) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> }
  assert.deepEqual(JSON.parse(out.choices[0]?.message.tool_calls[0]?.function.arguments ?? ''), { cmd: `export K=${KEY}` })
  a.finish()
  assert.equal(e.records.recent()[0]?.restoredInTools, 1)
})

test('/privacy test with shape shows the made-up key, and nothing is remembered', () => {
  const e = engine()
  const r = e.preview(`key ${KEY}`)
  assert.ok(!r.text.includes(KEY))
  assert.match(r.text, /^key sk-proj-/)
  assert.equal(e.values, 0)
})

test('the made-up keys survive the table making room, and still come back', () => {
  const e = engine({ maxValues: 100 })
  const a = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(a)
  const f = sent(a).slice(4)
  for (let i = 0; i < 60; i++) e.maskRequest(chat(`n ${'sk-' + 'proj-' + String(i).padStart(4, '0') + 'abcdefghijklmnopqrstu'}`), info)
  const b = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(b)
  assert.equal(sent(b), `key ${f}`)
  assert.ok(b.restoreBody(JSON.stringify({ choices: [{ message: { content: f } }] })).includes(KEY))
})
