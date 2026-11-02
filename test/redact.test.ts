import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadKey, tagOf } from '../src/redact/key.ts'
import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { newTally, Restorer } from '../src/redact/restore.ts'
import { notASlug } from '../src/redact/rules.ts'

// Built from pieces so no literal in the repository reads as a live credential.
const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const GITHUB = 'gh' + 'p_0123456789abcdefghijABCDEFGHIJ0123'
const AWS = 'AK' + 'IA47TIRLA73LFEDL7E'
const PLACEHOLDER = /\{\{API_KEY_[a-z2-7]{8}\}\}/g

const all: MaskOptions = { secrets: true, protectEnvBlock: true, protectTools: true }

function setup(options: MaskOptions = all, key: Uint8Array = randomBytes(32)) {
  const table = new ValueTable(5000)
  return { table, masker: new Masker(key, table, options), restorer: new Restorer(table) }
}

test('the three P0 key forms are masked, and restored', () => {
  const { masker, restorer } = setup()
  const text = `openai ${OPENAI}, github ${GITHUB} and aws ${AWS}.`
  const { text: masked, n } = masker.maskText(text)
  assert.equal(n, 3)
  for (const v of [OPENAI, GITHUB, AWS]) assert.ok(!masked.includes(v), v)
  assert.equal(masked.match(PLACEHOLDER)?.length, 3)
  assert.equal(restorer.restoreText(masked), text)
})

test('sk- slugs in article URLs are no keys; keys beside them are', () => {
  const { masker } = setup()
  for (const s of [
    'https://www.cnbc.com/2026/10/28/sk-hynix-third-quarter-profit.html',
    'https://www.techpowerup.com/354203/sk-hynix-announces-3q26-financial-results',
  ]) {
    assert.deepEqual(masker.maskText(s), { text: s, n: 0, hits: [] })
  }
  for (const key of [
    OPENAI,
    'sk-' + '0123456789abcdef'.repeat(2),
    'sk-or-v1-' + '0123456789abcdef'.repeat(4),
    'sk-' + '1f0e3dad-9990-4b5c-8a1b-2c3d4e5f6a7b',
  ]) {
    const { text, n } = masker.maskText(`url sk-hynix-third-quarter-profit key ${key}`)
    assert.equal(n, 1, key)
    assert.ok(!text.includes(key) && text.includes('sk-hynix-third-quarter-profit'), text)
  }
  assert.equal(notASlug('sk-hynix-third-quarter-profit'), false)
})

test('a key inside a longer word is no key', () => {
  const { masker } = setup()
  assert.equal(masker.maskText(`X${AWS}`).n, 0)
  assert.equal(masker.maskText(`${AWS}Z`).n, 0)
  assert.equal(masker.maskText(`ask-${OPENAI.slice(3)}`).n, 0)
})

test('placeholders are deterministic, idempotent, and stable across a restart with the same key', () => {
  const key = randomBytes(32)
  const a = setup(all, key)
  const b = setup(all, key)
  const once = a.masker.maskText(`key ${OPENAI}`).text
  assert.equal(b.masker.maskText(`key ${OPENAI}`).text, once)
  assert.deepEqual(a.masker.maskText(once), { text: once, n: 0, hits: [] })
  assert.notEqual(tagOf(key, 'API_KEY', OPENAI), tagOf(key, 'API_KEY', `${OPENAI}x`))
  assert.notEqual(setup().masker.maskText(`key ${OPENAI}`).text, once)
})

test('secrets: false masks nothing', () => {
  const { masker } = setup({ ...all, secrets: false })
  assert.equal(masker.maskText(`key ${OPENAI}`).n, 0)
})

test('loadKey keeps one 0600 key file and reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpg-key-'))
  try {
    const path = join(dir, 'state', 'redact.key')
    const first = loadKey(path)
    assert.equal(first.persisted, true)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'state')).mode & 0o777, 0o700)
    assert.deepEqual(loadKey(path).key, first.key)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maskJSON leaves what is not a model request alone', () => {
  const { masker } = setup()
  assert.equal(masker.maskJSON('not json'), null)
  assert.equal(masker.maskJSON(JSON.stringify({ query: OPENAI })), null)
  assert.equal(masker.maskJSON(JSON.stringify({ messages: 'x' })), null)
})

test('maskJSON keeps every byte it does not mask', () => {
  const { masker } = setup()
  const body = `{ "model" : "${OPENAI}",\n  "messages":[{"role":"user","content":"key ${OPENAI} \\u00e9"}], "stream":true }`
  const out = masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 1)
  // model is kept; only the content string is rewritten
  assert.ok(out.text.startsWith(`{ "model" : "${OPENAI}",\n  "messages":[{"role":"user","content":"key {{API_KEY_`))
  // the escape beside the masked value stays as it was written
  assert.ok(out.text.endsWith(` \\u00e9"}], "stream":true }`))
  const p = PLACEHOLDER.exec(out.text)?.[0] ?? ''
  PLACEHOLDER.lastIndex = 0
  assert.equal(out.text, body.replace(`key ${OPENAI}`, `key ${p}`))
  assert.ok(JSON.parse(out.text))
})

test('the <env> block and the tools array reach the vendor byte for byte (oc2dsh gate)', () => {
  const { masker } = setup()
  const system = `You are an agent.\n<env>\n  Working directory: /tmp/${OPENAI}\n</env>\nUse ${GITHUB} for pushes.`
  const tools = [
    { type: 'function', function: { name: 'bash', description: `Run a command. Example token ${OPENAI}`, parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string', default: AWS } } } } },
  ]
  const toolsJSON = JSON.stringify(tools)
  const body = `{"model":"big-pickle","messages":[{"role":"system","content":${JSON.stringify(system)}},{"role":"user","content":"push with ${GITHUB}"}],"tools":${toolsJSON}}`
  const out = masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 2) // the system prompt's text outside <env>, and the user's message
  const doc = JSON.parse(out.text) as { messages: Array<{ content: string }>; tools: unknown }
  const sys = doc.messages[0]?.content ?? ''
  assert.ok(sys.includes(`<env>\n  Working directory: /tmp/${OPENAI}\n</env>`))
  assert.ok(!sys.includes(GITHUB))
  assert.ok(out.text.includes(`"tools":${toolsJSON}`), 'tools byte for byte')

  const open = setup({ ...all, protectEnvBlock: false, protectTools: false }).masker.maskJSON(body)
  assert.ok(open)
  assert.ok(!open.text.includes(OPENAI), 'unprotected, the env block and tool descriptions are masked')
  assert.ok(open.text.includes(`"default":"${AWS}"`), 'a tool schema is structure: only descriptions are masked')
})

test('ids, names and tool-use inputs follow magpie keepIn', () => {
  const { masker } = setup()
  const body = JSON.stringify({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { name: GITHUB, command: `echo ${AWS}` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: OPENAI, content: 'ok' }] },
    ],
  })
  const out = masker.maskJSON(body)
  assert.ok(out)
  const doc = JSON.parse(out.text) as { messages: Array<{ content: Array<Record<string, unknown>> }> }
  const use = doc.messages[0]?.content[0] as { name: string; input: { name: string; command: string } }
  assert.equal(use.name, 'bash')
  assert.match(use.input.name, PLACEHOLDER, 'a key inside tool input is the agent’s data, even under "name"')
  assert.ok(!use.input.command.includes(AWS))
  assert.equal(doc.messages[1]?.content[0]?.tool_use_id, OPENAI)
})

test('tool call arguments are masked as escaped JSON and restored escaped', () => {
  const { masker, restorer } = setup()
  const args = JSON.stringify({ command: `curl -H "Authorization: Bearer ${OPENAI}"\n${GITHUB}` })
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: args } }] }] })
  const out = masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 2, 'the key right after an escaped newline is found too')
  const sent = JSON.parse(out.text) as { messages: Array<{ tool_calls: Array<{ function: { arguments: string } }> }> }
  const sentArgs = sent.messages[0]?.tool_calls[0]?.function.arguments ?? ''
  assert.ok(JSON.parse(sentArgs), 'arguments are still JSON')
  const reply = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'bash', arguments: sentArgs } }] } }] })
  const back = JSON.parse(restorer.restoreJSON(reply)) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> }
  assert.equal(back.choices[0]?.message.tool_calls[0]?.function.arguments, args)
})

test('restore takes a placeholder back with its braces changed, dropped, spaced or in another case', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const body = p.slice(2, -2)
  for (const form of [p, `{{ ${body} }}`, `{${body}}`, `{{${body}}`, body, body.toLowerCase(), body.toUpperCase()]) {
    assert.equal(restorer.restoreText(`use ${form} now`), `use ${OPENAI} now`, form)
  }
  assert.equal(restorer.restoreText(`x${body}`), `x${body}`, 'inside a longer word')
  assert.equal(restorer.restoreText('{{API_KEY_aaaaaaaa}}'), '{{API_KEY_aaaaaaaa}}', 'unknown placeholder')
})

test('the stream restorer restores data lines split across chunks and passes the rest through', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: `key ${p} é` } }] })}\n\n`
  const sse = `: keep-alive\n\nevent: message\n${event}data: [DONE]\n\n`
  const bytes = Buffer.from(sse, 'utf8')
  const expected = sse.replace(p, OPENAI)
  // every split point, including inside the placeholder and inside é
  for (let cut = 1; cut < bytes.length; cut++) {
    const s = restorer.stream()
    const out = s.push(bytes.subarray(0, cut)) + s.push(bytes.subarray(cut)) + s.end()
    assert.equal(out, expected, `cut at ${cut}`)
  }
})

test('the value table drops its oldest half when full', () => {
  const table = new ValueTable(100)
  for (let i = 0; i < 100; i++) table.put(`{{K_${i}}}`, 'K', `v${i}`)
  table.put('{{K_new}}', 'K', 'new')
  assert.equal(table.size, 51)
  assert.equal(table.get('{{K_0}}'), undefined)
  assert.equal(table.get('{{K_99}}'), 'v99')
  assert.equal(table.get('{{K_new}}'), 'new')
})

test('a placeholder split across two SSE deltas is put back whole, at every split point', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const ev = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`
  for (let cut = 1; cut < p.length; cut++) {
    const sse = `${ev(`key ${p.slice(0, cut)}`)}: keep-alive\n\n${ev(`${p.slice(cut)} done`)}data: [DONE]\n\n`
    const s = restorer.stream()
    const out = s.push(Buffer.from(sse)) + s.end()
    const text = [...out.matchAll(/^data: (\{.*\})$/gm)].map((m) => (JSON.parse(m[1] as string) as { choices: Array<{ delta: { content: string } }> }).choices[0]?.delta.content).join('')
    assert.equal(text, `key ${OPENAI} done`, `cut at ${cut}`)
    assert.ok(out.includes(': keep-alive\n\n') && out.endsWith('data: [DONE]\n\n'))
  }
})

test('a lowercase body split across two SSE deltas is held and put back whole', () => {
  const { masker, restorer } = setup()
  const body = masker.placeholder('API_KEY', OPENAI).slice(2, -2).toLowerCase()
  const ev = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`
  for (let cut = 1; cut < body.length; cut++) {
    const sse = `${ev(`key ${body.slice(0, cut)}`)}${ev(`${body.slice(cut)} done`)}data: [DONE]\n\n`
    const s = restorer.stream()
    const out = s.push(Buffer.from(sse)) + s.end()
    const text = [...out.matchAll(/^data: (\{.*\})$/gm)].map((m) => (JSON.parse(m[1] as string) as { choices: Array<{ delta: { content: string } }> }).choices[0]?.delta.content).join('')
    assert.equal(text, `key ${OPENAI} done`, `cut at ${cut}`)
  }
})

test('a held tail goes out as it came when the next event is another text', () => {
  const { masker, restorer } = setup()
  masker.placeholder('API_KEY', OPENAI)
  const a = `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'see {{API_' } })}\n\n`
  const b = `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
  const s = restorer.stream()
  assert.equal(s.push(Buffer.from(a + b)) + s.end(), a + b)
})

test('the tally counts places restored and placeholders no value is known for', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const tally = newTally()
  restorer.restoreJSON(JSON.stringify({ content: `${p} and ${p} and {{API_KEY_aaaaaaaa}}` }), tally)
  assert.equal(tally.restored.get(p), 2)
  assert.equal(tally.unmapped, 1)
})

test('the tally tells the places put back inside a tool call’s arguments, streamed or whole', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const whole = newTally()
  restorer.restoreJSON(JSON.stringify({ content: [{ type: 'text', text: p }, { type: 'tool_use', id: 't', name: 'bash', input: { command: `curl -H ${p}` } }] }), whole)
  assert.equal(whole.restored.get(p), 2)
  assert.equal(whole.inTools, 1)
  const streamed = newTally()
  const s = restorer.stream(streamed)
  const ev = (o: unknown) => Buffer.from(`data: ${JSON.stringify(o)}\n\n`)
  let out = s.push(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: `{"command":"curl ${p}` } }))
  out += s.push(ev({ choices: [{ delta: { content: `said ${p}` } }] }))
  out += s.end()
  assert.ok(out.includes(OPENAI))
  assert.equal(streamed.restored.get(p), 2)
  assert.equal(streamed.inTools, 1)
})

test('in tool arguments a value written with JSON escapes is masked whole, and comes back as written', () => {
  const words: MaskOptions = { ...all, words: ['Blue/bird'] }
  const { masker, table, restorer } = setup(words)
  masker.maskText('note Kn0wnVal/ue99 here', false)
  masker.maskText('DB_PASSWORD=Kn0wnVal/ue99')
  const cases: Array<[args: string, value: string]> = [
    ['{"cmd":"export DB_PASSWORD=ab\\/cd1234xyz"}', 'ab/cd1234xyz'],
    ['{"cmd":"export API_TOKEN=ab\\u0026cd1234xyz"}', 'ab&cd1234xyz'],
    ['{"password":"abcd1234\\"xyz9"}', 'abcd1234"xyz9'],
    ['{"cmd":"echo Kn0wnVal\\/ue99"}', 'Kn0wnVal/ue99'],
    ['{"cmd":"deploy Blue\\/bird"}', 'Blue/bird'],
    // a quote and a backslash in the value itself, each written as an escape
    ['{"cmd":"export DB_PASSWORD=pa\\"ss9\\\\wo/rd run"}', 'pa"ss9\\wo/rd'],
  ]
  for (const [args, value] of cases) {
    const out = masker.maskText(args, true)
    assert.equal(out.n, 1, args)
    assert.ok(JSON.parse(out.text), out.text)
    const p = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/.exec(out.text)?.[0] ?? ''
    assert.equal(table.get(p), value, args)
    assert.ok(!out.text.includes('xyz') && !out.text.includes('ue99') && !out.text.includes('bird') && !out.text.includes('wo/rd'), out.text)
    assert.deepEqual(JSON.parse(restorer.restoreText(out.text, true)), JSON.parse(args))
  }
  // the quote that closes a quoted value stays outside it
  const quoted = masker.maskText('{"cmd":"PASSWORD=\\"abc12345x\\" next"}', true)
  assert.match(quoted.text, /=\\"\{\{SECRET_[a-z2-7]{8}\}\}\\" next/)
})

test('a secret used as a JSON key goes as a placeholder, and comes back in the reply', () => {
  const { masker, table, restorer } = setup({ ...all, maskKeys: true })
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { [OPENAI]: 'the key above', note: 'plain' } })
  const r = masker.maskJSON(body)
  assert.ok(r)
  assert.ok(!r.text.includes(OPENAI), r.text)
  const p = r.text.match(PLACEHOLDER)?.[0] ?? ''
  assert.ok(p !== '')
  // the key and the value are the same value: one placeholder, and the table knows it
  assert.equal(table.get(p), OPENAI)
  assert.equal(r.hits.filter((h) => h.at?.path === `metadata.${p}`).length, 1)
  // the vendor's reply names it, and the reply comes back as the agent wrote it
  assert.equal(restorer.restoreText(JSON.stringify({ said: { [p]: 'x' } })), JSON.stringify({ said: { [OPENAI]: 'x' } }))
})

test('a key of the protocol itself, a tool definition’s or a tool call’s own names are never masked', () => {
  const { masker } = setup({ ...all, maskKeys: true })
  // the ids the vendor matches against each other, and the keys a message is read by
  const ids = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x', tool_call_id: `${OPENAI}_id` }], client_metadata: { [`${OPENAI}_id`]: 1 } })
  const idsOut = masker.maskJSON(ids)
  assert.ok(idsOut)
  assert.ok(idsOut.text.includes(`"${OPENAI}_id"`), idsOut.text)
  // a tool definition and a tool call's argument names are the tool's own schema
  const tools = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { [OPENAI]: { type: 'string' } } } } }] })
  const out = masker.maskJSON(tools)
  assert.ok(out)
  // byte for byte: a tool definition the vendor reads as structure is not rewritten
  assert.equal(out.text, tools)
  const call = JSON.stringify({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { [OPENAI]: 'v' } }] }] })
  const callOut = masker.maskJSON(call)
  assert.ok(callOut)
  assert.ok(callOut.text.includes(`"${OPENAI}"`), callOut.text)
})

test('maskKeys off sends the body exactly as it came', () => {
  const { masker } = setup({ ...all, maskKeys: false })
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], metadata: { [OPENAI]: 'x' } })
  const r = masker.maskJSON(body)
  assert.ok(r)
  assert.equal(r.text, body)
  const on = setup({ ...all, maskKeys: true }).masker.maskJSON(body)
  assert.ok(on)
  assert.notEqual(on.text, body)
})

test('a body of nothing but protocol keys goes as it came, byte for byte', () => {
  const { masker } = setup({ ...all, maskKeys: true })
  const body = '{"model":"m",  "messages":[ {"role":"user",\n "content":"plain words" } ], "stream":false}'
  const r = masker.maskJSON(body)
  assert.ok(r)
  assert.equal(r.text, body)
})

test('a key sent as written is recorded by its placeholder, never by its own text', () => {
  const { masker } = setup({ ...all, maskKeys: true, context: true, actions: { API_KEY: 'warn' } })
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], [OPENAI]: 1 })
  const r = masker.maskJSON(body)
  assert.ok(r)
  // the key went as it was, and the record names it by the placeholder it would have had
  assert.ok(r.text.includes(`"${OPENAI}"`), r.text)
  const hit = r.hits[0]
  assert.ok(hit)
  assert.equal(hit.action, 'warn')
  assert.ok(hit.at?.path.startsWith('{{API_KEY_'), hit.at?.path)
  assert.ok(!JSON.stringify(r.hits).includes(OPENAI), JSON.stringify(r.hits))
})

test('personal data used as a key is masked as a value is', () => {
  const { masker, restorer } = setup({ ...all, personal: true, maskKeys: true })
  const mail = 'zhang.wei@baidu.com'
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], [mail]: 'who' })
  const r = masker.maskJSON(body)
  assert.ok(r)
  assert.ok(!r.text.includes(mail), r.text)
  const p = r.text.match(/\{\{EMAIL_[a-z2-7]{8}\}\}/)?.[0] ?? ''
  assert.ok(p !== '')
  assert.equal(restorer.restoreText(r.text), body)
})

test('a body already masked goes through again unchanged, keys and all', () => {
  const { masker } = setup({ ...all, maskKeys: true, context: true })
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `k ${OPENAI}` }], [OPENAI]: 'v' })
  const once = masker.maskJSON(body)
  assert.ok(once)
  assert.notEqual(once.text, body)
  // a placeholder is no key of its own: masking what was already sent changes nothing
  const again = masker.maskJSON(once.text)
  assert.ok(again)
  assert.equal(again.text, once.text)
  assert.equal(again.n, 0)
  assert.equal(again.hits.length, 0)
})
