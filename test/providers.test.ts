import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults, liveStrings, resolveConfig } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { bypassedProvider, bypassing, currentSession, isExcluded, routeStream } from '../src/providers.ts'
import { excludeChoices, toggleExcluded } from '../src/client/providerChoice.ts'
import { Config } from '../src/index.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const PLACEHOLDER = /\{\{API_KEY_[a-z2-7]{8}\}\}/

test('isExcluded matches a provider id in any case, and nothing else', () => {
  assert.equal(isExcluded('DeepSeek', ['deepseek']), true)
  assert.equal(isExcluded('deepseek', ['openai']), false)
  assert.equal(isExcluded('deepseek', []), false)
  assert.equal(isExcluded(undefined, ['deepseek']), false)
  assert.equal(isExcluded('', ['']), false)
})

test('excludeProviders defaults to none and parses through the volatile reference', () => {
  assert.deepEqual(liveStrings(Config({}).excludeProviders), [])
  assert.deepEqual(liveStrings(Config({ excludeProviders: ['deepseek'] }).excludeProviders), ['deepseek'])
  assert.deepEqual(resolveConfig(Config({ excludeProviders: ['a', 'b'] })).excludeProviders, ['a', 'b'])
})

test('bypassing names the provider in every step of the stream, and only there', async () => {
  async function* stream() {
    yield bypassedProvider()
    await new Promise((r) => setTimeout(r, 1))
    yield bypassedProvider()
  }
  const seen: unknown[] = []
  for await (const v of bypassing('deepseek', stream)) seen.push(v, bypassedProvider())
  assert.deepEqual(seen, ['deepseek', undefined, 'deepseek', undefined])
})

test('a nested call to a masked provider leaves the bypass; one to an excluded provider keeps it', async () => {
  async function* probe() {
    yield bypassedProvider()
  }
  const collect = async (s: AsyncIterable<unknown>) => {
    const out: unknown[] = []
    for await (const v of s) out.push(v)
    return out
  }
  async function* outer() {
    yield* await collect(routeStream('openai', ['deepseek'], probe))
    yield* await collect(routeStream('DeepSeek', ['deepseek'], probe))
  }
  assert.deepEqual(await collect(routeStream('deepseek', ['deepseek'], outer)), [undefined, 'DeepSeek'])
  assert.deepEqual(await collect(routeStream('openai', ['deepseek'], probe)), [undefined])
})

test('a request made inside an excluded provider goes out unmasked and its reply is not restored', async () => {
  const bodies: string[] = []
  let answer = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const before = getGlobalDispatcher()
  const gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, skip: () => bypassedProvider() !== undefined, logger: { warn: () => {} } })
  const call = async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }) })
    return ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content
  }
  try {
    // masked: the origin gets a placeholder, which the reply has restored
    answer = 'ok'
    await call()
    const placeholder = bodies[0]?.match(PLACEHOLDER)?.[0]
    assert.ok(placeholder, bodies[0])
    assert.ok(!bodies[0]?.includes(OPENAI))
    answer = `echo ${placeholder}`
    assert.equal(await call(), `echo ${OPENAI}`)
    // excluded: the value goes as it is, and the placeholder comes back as it is
    async function* adapter() {
      yield await call()
    }
    const got: unknown[] = []
    for await (const c of bypassing('deepseek', adapter)) got.push(c)
    assert.ok(bodies[2]?.includes(OPENAI), bodies[2])
    assert.deepEqual(got, [`echo ${placeholder}`])
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('the detail page lists every provider, then excluded ids without an adapter', () => {
  const rows = excludeChoices([{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }], ['DEEPSEEK', 'gone'])
  assert.deepEqual(
    rows.map((r) => [r.id, r.excluded, r.registered]),
    [
      ['deepseek', true, true],
      ['openai', false, true],
      ['gone', true, false],
    ],
  )
  assert.deepEqual(toggleExcluded(['DeepSeek'], 'deepseek'), [])
  assert.deepEqual(toggleExcluded(['a'], 'b'), ['a', 'b'])
})

test('the stream carries the session the host named, so a record can say which one it was', async () => {
  async function* probe() {
    yield currentSession()
  }
  const collect = async (s: AsyncIterable<unknown>) => {
    const out: unknown[] = []
    for await (const v of s) out.push(v)
    return out
  }
  assert.deepEqual(await collect(routeStream('deepseek', [], probe, 'sess-1')), ['sess-1'])
  // a nested call names its own session
  async function* outer() {
    yield* await collect(routeStream('openai', [], probe, 'sess-2'))
  }
  assert.deepEqual(await collect(routeStream('deepseek', [], outer, 'sess-1')), ['sess-2'])
  // outside any stream there is none
  assert.equal(currentSession(), undefined)
})

test('a record says which workspace and session a call came from, by name', async () => {
  const { RecordStore } = await import('../src/records.ts')
  const records = new RecordStore({ keepDays: 30, keepBytes: 64 * 1024 * 1024, keepRecords: 10 })
  const engine = new PrivacyEngine(randomBytes(32), defaults, {
    records,
    names: (session) => (session === 'sess-7' ? { title: '修一下网关', workspace: 'dsh-privacy-gateway' } : {}),
  })
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }), { host: 'h', path: '/v1/chat/completions', session: 'sess-7' })
  ex?.finish()
  const [r] = records.recent()
  assert.equal(r?.session, 'sess-7')
  assert.equal(r?.title, '修一下网关')
  assert.equal(r?.workspace, 'dsh-privacy-gateway')
  // a call with no session has neither name
  const ex2 = engine.maskRequest(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }), { host: 'h', path: '/v1/chat/completions' })
  ex2?.finish()
  const [none] = records.recent()
  assert.equal(none?.session, undefined)
  assert.equal(none?.title, undefined)
})

test('the sums and the latest records can be narrowed to one session', async () => {
  const { RecordStore } = await import('../src/records.ts')
  const records = new RecordStore({ keepDays: 30, keepBytes: 64 * 1024 * 1024, keepRecords: 50 })
  const engine = new PrivacyEngine(randomBytes(32), defaults, { records })
  const call = (session?: string) => {
    const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }), { host: 'h', path: '/v1/chat/completions', ...(session ? { session } : {}) })
    ex?.finish()
  }
  call('sess-a')
  call('sess-b')
  call('sess-a')
  assert.equal(records.recent().length, 3)
  assert.equal(records.recent(10, 'sess-a').length, 2)
  assert.equal(records.recent(10, 'sess-b').length, 1)
  assert.equal(records.recent(10, 'sess-none').length, 0)
  assert.equal(records.stats().today.requests, 3)
  assert.equal(records.stats('sess-a').today.requests, 2)
  assert.equal(records.stats('sess-a').today.masked, 2)
  assert.equal(records.stats('sess-none').today.requests, 0)
})
