import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getGlobalDispatcher, request, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { walkJSON } from '../src/redact/json.ts'
import { ValueTable } from '../src/redact/known.ts'
import { Masker } from '../src/redact/mask.ts'

const KEY = 'sk-' + 'proj-Boundaryabcdefgh0123456789ABCD'
const options = { secrets: true, protectTools: true, protectEnvBlock: true, maskKeys: true, context: true }
const masking = (words: string[] = [], protectTools = true) => new Masker(randomBytes(32), new ValueTable(5000), { ...options, words, protectTools })
const DUPLICATES = [
  `{"messages":[{"role":"user","content":"<env>${KEY}</env>"}],"messages":[{"role":"system","content":"plain"}]}`,
  `{"messages":[{"role":"system","content":"<env>${KEY}</env>"}],"messages":[{"role":"user","content":"plain"}]}`,
  `{"messages":[{"role":"user","role":"system","content":"<env>${KEY}</env>"}]}`,
  `{"messages":[{"role":"system","content":"<env>${KEY}</env>","content":"plain"}]}`,
  `{"messages":[{"role":"user","content":"${KEY}"}],"mess\\u0061ges":null}`,
  `{"messages":[{"role":"user","content":"plain"}],"metadata":{"${KEY}":1,"${KEY}":2}}`,
]

for (let i = 0; i < DUPLICATES.length; i++) {
  test(`duplicate decoded request members fail closed before masking (${i + 1})`, () => {
    const table = new ValueTable(5000)
    const m = new Masker(randomBytes(32), table, options)
    assert.throws(() => m.maskJSON(DUPLICATES[i] as string), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /duplicate/i)
      assert.ok(!err.message.includes(KEY))
      return true
    })
    assert.equal(table.size, 0, 'an ambiguous request must not seed the value table')
  })
}

test('same member names in separate objects remain valid, and reply walker defaults preserve duplicates', () => {
  const body = `{"messages":[{"role":"system","content":"<env>${KEY}</env>"},{"role":"user","content":"${KEY}"}],"metadata":{"one":{"note":"plain"},"two":{"note":"plain"}}}`
  const out = masking().maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 1)
  assert.ok(out.text.includes(`<env>${KEY}</env>`))
  const reply = '{"content":"first","content":"second"}'
  assert.equal(walkJSON(reply, (_path, _shown, _key, value) => value), reply)
  assert.equal(masking().maskJSON('{"metadata":{"note":1,"note":2}}'), null, 'a non-model JSON remains outside the request policy')
})

for (const name of ['tools', 'functions']) {
  test(`protected ${name} root key and subtree keep every original byte`, () => {
    const body = `{"messages":[{"role":"user","content":"plain"}],"${name}":[{"description":"caf\\u00e9 ${KEY}","parameters":{}}]}`
    const out = masking([name]).maskJSON(body)
    assert.ok(out)
    assert.equal(out.text, body)
    assert.equal(out.n, 0)
  })
}

for (const name of ['messages', 'input', 'contents', 'prompt', 'system', 'instructions', 'systemInstruction', 'response_format']) {
  test(`protocol ${name} root is preserved without exempting business keys of the same name`, () => {
    const value = name === 'prompt' || name === 'input' ? 'plain' : []
    const doc = { messages: [{ role: 'user', content: 'plain' }], [name]: value, metadata: { [name]: 'plain' } }
    const out = masking([name]).maskJSON(JSON.stringify(doc))
    assert.ok(out)
    const wire = JSON.parse(out.text)
    assert.ok(Object.hasOwn(wire, name), 'the vendor must still see the protocol root')
    assert.ok(!Object.hasOwn(wire.metadata, name), 'a same-named business key must still be masked')
    assert.equal(out.n, 1)
  })
}

test('tool argument and definition container keys are protected at their child locations', () => {
  const body = JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', input: { value: 'plain' } }] }], tools: [{ description: 'plain' }], metadata: { tools: 'plain', input: 'plain' } })
  const out = masking(['tools', 'input'], false).maskJSON(body)
  assert.ok(out)
  const wire = JSON.parse(out.text)
  assert.ok(Object.hasOwn(wire, 'tools'))
  assert.ok(Object.hasOwn(wire.messages[0].content[0], 'input'))
  assert.ok(!Object.hasOwn(wire.metadata, 'tools'))
  assert.ok(!Object.hasOwn(wire.metadata, 'input'))
})

test('ambiguous duplicate requests never reach a real gateway origin with fetch or undici.request', async () => {
  let seen = 0
  const bodies: string[] = []
  const server = createServer((req, res) => {
    seen++
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => { bodies.push(body); res.end('{}') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const before = getGlobalDispatcher()
  const warnings: unknown[][] = []
  const e = new PrivacyEngine(randomBytes(32), defaults)
  const gateway = installGateway(e, { checkIntervalMs: 0, logger: { warn: (...args: unknown[]) => warnings.push(args) } })
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    for (const body of DUPLICATES) {
      await assert.rejects(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), (err: unknown) => {
        assert.ok(err instanceof Error && err.cause instanceof Error && 'code' in err.cause)
        assert.equal(err.cause.code, 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
        return true
      })
      await assert.rejects(request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), (err: unknown) => {
        assert.ok(err instanceof Error && 'code' in err)
        assert.equal(err.code, 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
        return true
      })
    }
    assert.equal(seen, 0)
    assert.equal(e.values, 0)
    assert.ok(!JSON.stringify(warnings).includes(KEY))
    assert.ok(!JSON.stringify(e.records.recent()).includes(KEY))
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: KEY }] }) })
    await response.text()
    assert.equal(seen, 1)
    assert.ok(!bodies[0]?.includes(KEY))
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
