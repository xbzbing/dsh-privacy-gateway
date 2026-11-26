import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaults, resolveConfig } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { ViewStore } from '../src/views.ts'
import { RecordStore } from '../src/records.ts'
import { walkJSON } from '../src/redact/json.ts'
import { Context } from '@deepseek-ai/cordis'
import { PrivacyGatewayService } from '../src/remote.ts'

const KEY = 'sk-' + 'proj-Auditabcdefgh0123456789ABCD'
const OTHER = 'gh' + 'p_0123456789abcdefghijABCDEFGHIJ0123'
const all: MaskOptions = { secrets: true, protectEnvBlock: true, protectTools: true, maskKeys: true, context: true }
const masker = (options: Partial<MaskOptions> = {}) => new Masker(randomBytes(32), new ValueTable(5000), { ...all, ...options })
const info = { host: 'api.example.invalid', path: '/v1/chat/completions' }

const envBodies = [
  `{"messages":[{"role":"system","content":"${KEY} before <env>${KEY}</env> after ${KEY}"}]}`,
  `{"messages":[{"role":"developer","content":"\\u003cenv\\u003e\\n${KEY} caf\\u00e9\\n\\u003c/env\\u003e outside ${KEY}"}]}`,
  `{"instructions":"${KEY} <env>${KEY}","input":"plain"}`,
]

function noValues(value: unknown, values = [KEY, OTHER]): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const v of values) assert.ok(!text.includes(v), `audit output contains ${v.slice(0, 7)}`)
}

test('warned leaf and ancestor keys collect every value while wire stays unchanged', () => {
  const m = masker({ actions: { API_KEY: 'warn' } })
  const leaf = m.maskJSON(JSON.stringify({ messages: [{ role: 'user', content: 'plain' }], [KEY]: 1 }))
  assert.ok(leaf)
  assert.equal(leaf.warned?.length, 1)
  assert.equal(leaf.warned?.[0]?.[0], KEY)
  const name = `first ${KEY} second ${KEY}`
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'plain' }], metadata: { [name]: { note: OTHER } } })
  const out = m.maskJSON(body)
  assert.ok(out)
  assert.ok(out.text.includes(name), 'warned key must not change on the wire')
  assert.equal(out.warned?.filter(([v]) => v === KEY).length, 2)
  assert.equal(out.warned?.filter(([v]) => v === OTHER).length, 1)
  noValues(out.hits)
  const child = out.hits.find((h) => h.kind === 'GITHUB_TOKEN') ?? out.hits.at(-1)
  assert.ok(child?.at?.path.endsWith('.note'))
  assert.equal(child?.at?.path.match(/DSH_REDACTED:API_KEY_/g)?.length, 2)
})

test('mixed warn and mask key hits project every value in descendant paths and key context', () => {
  const mail = 'audit@kowalczyk.pl'
  const name = `${KEY} mail ${mail} again ${OTHER}`
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'plain' }], metadata: { [name]: { note: KEY } } })
  const out = masker({ personal: true, actions: { EMAIL: 'warn' } }).maskJSON(body)
  assert.ok(out)
  assert.ok(out.text.includes(mail), 'warn still reaches the vendor')
  noValues(out.text)
  noValues(out.hits, [KEY, OTHER, mail])
  assert.deepEqual(out.warned?.map(([v]) => v), [mail])
  const child = out.hits.at(-1)
  assert.ok(child?.at?.path.endsWith('.note'))
  assert.ok(child?.at?.path.includes('DSH_REDACTED:EMAIL_'))
})

test('trueforms are deduplicated request-only inputs for mask, warn, block, keys, and escaped arguments', () => {
  for (const action of [undefined, 'warn', 'block'] as const) {
    const m = masker({ ...(action ? { actions: { API_KEY: action } } : {}) })
    const body = JSON.stringify({
      messages: [{ role: 'user', content: `${KEY} ${KEY}` }],
      metadata: { [KEY]: 'plain' },
      arguments: JSON.stringify({ note: KEY }),
    })
    const out = m.maskJSON(body)
    assert.ok(out)
    assert.deepEqual(out.trueforms, [[KEY, out.hits[0]?.placeholder]])
    assert.equal(m.preview(KEY).trueforms, undefined)
    assert.equal(m.maskText(KEY).trueforms, undefined)
    assert.equal(m.maskKey(KEY, '').trueforms, undefined)
    const allowed = masker({ allow: [KEY] }).maskJSON(body)
    assert.equal(allowed?.trueforms, undefined)
  }
})

test('protected env bytes stay on the wire but never in nearby audit context', () => {
  for (const body of envBodies) {
    const out = masker().maskJSON(body)
    assert.ok(out)
    const p = out.hits[0]?.placeholder
    assert.ok(p)
    const original = JSON.parse(body)
    const text = original.messages?.[0]?.content ?? original.instructions
    const start = text.indexOf('<env>')
    const close = text.indexOf('</env>')
    const end = close < 0 ? text.length : close + '</env>'.length
    const safe = text.slice(0, start).split(KEY).join(p) + text.slice(start, end) + text.slice(end).split(KEY).join(p)
    const wire = JSON.parse(out.text)
    assert.equal(wire.messages?.[0]?.content ?? wire.instructions, safe)
    noValues(out.hits)
    const kept = body.slice(body.indexOf('\\u003cenv'), body.indexOf(' outside'))
    if (body.includes('\\u003cenv')) assert.ok(out.text.includes(kept), 'protected escaping stays unchanged')
  }
})

test('literal dotted roots never inherit tool, definition, argument, or host-env exemptions', () => {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'plain' }],
    'tools.note': KEY,
    'functions.note': KEY,
    'response_format.note': KEY,
    'instructions.note': `<env>${KEY}</env>`,
    'system.note': `<env>${KEY}</env>`,
    'systemInstruction.note': `<env>${KEY}</env>`,
    'messages.0.content': `<env>${KEY}</env>`,
    tools: [{ description: KEY }],
    functions: [{ description: KEY }],
    instructions: { note: `<env>${KEY}</env>` },
    metadata: { 'functionCall.args': { name: KEY }, functionCall: { args: { name: KEY } } },
  })
  for (const maskKeys of [false, true]) {
    const out = masker({ maskKeys }).maskJSON(body)
    assert.ok(out)
    const doc = JSON.parse(out.text)
    for (const k of ['tools.note', 'functions.note', 'response_format.note', 'instructions.note', 'system.note', 'systemInstruction.note', 'messages.0.content']) {
      noValues(doc[k], [KEY])
    }
    assert.equal(doc.tools[0].description, KEY)
    assert.equal(doc.functions[0].description, KEY)
    assert.equal(doc.instructions.note, `<env>${KEY}</env>`)
    assert.equal(doc.metadata['functionCall.args'].name, KEY, 'a literal field is not a real tool argument')
    noValues(doc.metadata.functionCall.args.name, [KEY])
  }
})

test('structural traversal keeps literal, empty, numeric, and prototype keys distinct in places and arguments', () => {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'plain' }],
    metadata: { '': { '0': { 'a.b': { role: 'assistant', type: 'literal', note: KEY } } } },
    ['__proto__']: { role: 'developer', ['constructor']: { type: 'prototype', ['toString']: OTHER } },
    ['']: { tools: { note: KEY } },
    tools: [{ description: KEY, parameters: { 'a.b': KEY } }],
    input: [{ type: 'additional_tools', tools: [{ description: OTHER, config: KEY }] }],
  })
  const out = masker({ protectTools: false }).maskJSON(body)
  assert.ok(out)
  const doc = JSON.parse(out.text)
  noValues(doc.metadata)
  noValues(doc.__proto__)
  noValues(doc[''], [KEY])
  const literal = out.hits.find((h) => h.at?.type === 'literal')
  assert.equal(literal?.at?.role, 'assistant')
  assert.equal(literal?.at?.path, 'metadata..0.a.b.note')
  const proto = out.hits.find((h) => h.at?.type === 'prototype')
  assert.equal(proto?.at?.role, 'developer')
  assert.equal(doc.tools[0].parameters['a.b'], KEY, 'real definitions keep non-description strings')
  noValues(doc.tools[0].description)
  assert.equal(doc.input[0].tools[0].config, KEY)
  noValues(doc.input[0].tools[0].description)
})

test('walker lossless segments and display-only keys preserve legacy callback positions and wire escaping', () => {
  const body = '{"a.b":{"":{"0":["caf\\u00e9"]}}}'
  const values: unknown[] = []
  const keys: unknown[] = []
  const out = walkJSON(body, (path, shown, key, value, segments) => {
    values.push([path, shown, key, value, segments])
    return value
  }, (path, shown, name, segments) => {
    keys.push([path, shown, name, segments])
    return name === 'a.b' ? { shown: 'safe' } : undefined
  })
  assert.equal(out, body)
  assert.deepEqual(values, [['a.b..0.0', 'safe..0.0', '0', 'café', ['a.b', '', '0', '0']]])
  assert.deepEqual(keys[0], ['', '', 'a.b', []])
  assert.deepEqual(keys[1], ['a.b', 'safe', '', ['a.b']])
  assert.equal(walkJSON('{"one":"x"}', (_path, _shown, _key, value) => value, (_path, _shown, name) => name === 'one' ? 'two' : undefined), '{"two":"x"}')
})

test('warned Unicode-escaped keys are hidden in the decoded vendor view without changing wire bytes', () => {
  const views = new ViewStore()
  const e = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, vendorView: true, actions: { API_KEY: 'warn' } }), { views })
  const escaped = KEY.replace('Audit', '\\u0041udit')
  const body = `{"messages":[{"role":"user","content":"plain"}],"metadata":{"${escaped}":1}}`
  const ex = e.maskRequest(body, info)
  assert.ok(ex)
  assert.equal(ex.text, body)
  ex.finish()
  const key = e.records.recent()[0]?.key
  assert.ok(key)
  const vendor = views.get(key)
  assert.ok(vendor)
  noValues(JSON.parse(vendor), [KEY])
})

test('warned keys and descendants never reach records, JSONL, or Remote payload projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpg-masking-audit-'))
  const views = new ViewStore()
  const e = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, vendorView: true, actions: { API_KEY: 'warn' } }), { records: new RecordStore({ dir, keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, flushDelayMs: 0 }), views })
  try {
    const name = `first ${KEY} then ${KEY}`
    const ex = e.maskRequest(JSON.stringify({ messages: [{ role: 'user', content: 'plain' }], metadata: { [name]: { note: OTHER } } }), info)
    assert.ok(ex)
    assert.ok(ex.text.includes(name))
    ex.finish()
    const recent = e.records.recent()
    assert.equal(recent.length, 1)
    const key = recent[0]?.key
    assert.ok(key)
    noValues(recent)
    noValues(e.records.stats())
    const service = new PrivacyGatewayService(new Context(), {
      overview: (limit) => ({ active: true, secrets: true, personal: false, record: true, values: e.values, recent: e.records.recent(limit), stats: e.records.stats() }),
      vendorView: (key) => {
        const body = views.get(key)
        return body === undefined ? null : { key, body }
      },
    })
    noValues(await service.overview({ limit: 10 }))
    const vendor = await service.vendorView({ key })
    assert.ok(vendor)
    noValues(vendor)
    noValues(JSON.parse(vendor.body))
    for (const body of envBodies) e.maskRequest(body, info)?.finish()
    noValues(await service.overview({ limit: 10 }))
    await e.records.flush()
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    assert.equal(files.length, 1)
    noValues(readFileSync(join(dir, files[0] as string), 'utf8'))
  } finally {
    await e.records.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
