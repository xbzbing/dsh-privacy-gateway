import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { runPrivacyCommand } from '../src/command.ts'
import { defaults, resolveConfig } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine, RequestBlocked } from '../src/engine.ts'

const KEY = 'sk-' + 'proj-ACTIONSactions0123456789abcd'
const MAIL = 'rina.k@kowalczyk.pl'
const chat = (content: string) => JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

function engine(actions: Record<string, string>, over: Record<string, unknown> = {}) {
  return new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, personal: true, ...over, actions: actions as never }))
}

test('actions are read by kind in any case; anything but warn and block is mask', () => {
  assert.deepEqual(resolveConfig({ actions: { api_key: 'block', EMAIL: 'warn', TOKEN: 'mask', PHONE: 'drop' } as never }).actions, { API_KEY: 'block', EMAIL: 'warn' })
  assert.deepEqual(resolveConfig({ actions: ['x'] as never }).actions, {})
})

test('warn sends the value as written and records it apart from what was masked', () => {
  const e = engine({ EMAIL: 'warn' })
  const ex = e.maskRequest(chat(`mail ${MAIL} key ${KEY}`), info)
  assert.ok(ex)
  assert.ok(ex.text.includes(MAIL))
  assert.ok(!ex.text.includes(KEY))
  ex.finish()
  const [r] = e.records.recent()
  assert.equal(r?.n, 1)
  assert.equal(r?.warned, 1)
  assert.deepEqual(r?.values.map((v) => [v.kind, v.action]), [['EMAIL', 'warn'], ['API_KEY', undefined]])
  assert.ok(!JSON.stringify(r).includes(MAIL))
  const t = e.records.stats().today
  assert.equal(t.warned, 1)
  assert.equal(t.kinds.EMAIL, undefined)
  assert.equal(t.kinds.API_KEY, 1)
})

test('a request with only warned values is recorded, and its value is never put in the table', () => {
  const e = engine({ EMAIL: 'warn' })
  const ex = e.maskRequest(chat(`mail ${MAIL}`), info)
  assert.ok(ex)
  assert.equal(ex.text, chat(`mail ${MAIL}`))
  ex.finish()
  assert.equal(e.values, 0)
  assert.equal(e.records.recent().length, 1)
})

test('block stops the request with the kind, head and length, never the value, and records it', () => {
  const e = engine({ API_KEY: 'block' })
  assert.throws(
    () => e.maskRequest(chat(`key ${KEY} and ${MAIL}`), info),
    (err: unknown) => err instanceof RequestBlocked && /API_KEY \(sk-proj-ACTI…, 36 characters\)/.test(err.message) && !err.message.includes(KEY),
  )
  const [r] = e.records.recent()
  assert.equal(r?.blocked, true)
  assert.equal(r?.failed, undefined)
  assert.equal(e.records.stats().today.blocked, 1)
  assert.equal(e.records.stats().failStreak, 0)
})

test('a value on the allow list is sent whatever its kind does', () => {
  const e = engine({ API_KEY: 'block' }, { allow: [KEY] })
  const ex = e.maskRequest(chat(`key ${KEY}`), info)
  assert.ok(ex)
  assert.ok(ex.text.includes(KEY))
})

test('/privacy test shows a warned or blocked value as its placeholder, with what would be done', () => {
  const e = engine({ EMAIL: 'warn', API_KEY: 'block' })
  const face = { get active() { return e.active }, set active(v: boolean) { e.active = v }, secrets: true, personal: true, values: 0, stats: () => e.records.stats(), preview: (t: string) => e.preview(t) }
  const r = runPrivacyCommand(face, `test ${MAIL} ${KEY}`, 'en')
  assert.ok(!r.text.includes(MAIL) && !r.text.includes(KEY), r.text)
  assert.match(r.text, /EMAIL .*\(warn: goes as written/)
  assert.match(r.text, /API_KEY .*\(block: the request would not be sent\)/)
  assert.equal(e.values, 0)
})

test('the gateway fails a blocked request with its own code, and the origin never sees it', async () => {
  let seen = 0
  const server = createServer((req, res) => {
    seen++
    req.resume()
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const before = getGlobalDispatcher()
  const warnings: unknown[][] = []
  const gateway = installGateway(engine({ API_KEY: 'block' }), { checkIntervalMs: 0, logger: { warn: (...a: unknown[]) => warnings.push(a) } })
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    const err = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(`key ${KEY}`) }).then(
      () => assert.fail('request was sent'),
      (e: unknown) => e as Error & { cause?: { code?: string; message?: string } },
    )
    assert.equal(err.cause?.code, 'DSH_PRIVACY_GATEWAY_BLOCKED')
    assert.match(err.cause?.message ?? '', /request blocked: it has API_KEY/)
    assert.equal(seen, 0)
    assert.equal(warnings.length, 1)
    assert.ok(!JSON.stringify(warnings).includes(KEY))
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
