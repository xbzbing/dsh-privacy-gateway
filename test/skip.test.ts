import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher } from 'undici'

import { apply, type PluginContext } from '../src/index.ts'
import { makeSkip, routeStream } from '../src/providers.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'

type Listener = (options: { provider?: unknown; sessionId?: unknown }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>

test('requests through the plugin’s own llm/stream listener are masked unless their provider is excluded', async () => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-skip-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void> = []
  let listener: Listener | undefined
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => disposers.push(fn()),
    // the plugin listens to session/event too, which this test does not feed
    on: (name: string, l: unknown) => {
      if (name === 'llm/stream') listener = l as Listener
    },
  }
  try {
    apply(ctx, { excludeProviders: ['', ' ', 'deepseek'] })
    assert.ok(listener, 'the plugin listens to llm/stream')
    const run = async (provider: unknown, sessionId: unknown): Promise<string> => {
      const n = bodies.length
      async function* adapter() {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }) })
        yield await res.text()
      }
      for await (const _ of (listener as Listener)({ provider, sessionId }, adapter)) void _
      return bodies[n] ?? ''
    }
    for (const provider of ['', undefined, 'openai']) {
      for (const sessionId of [undefined, '', 'sess-1']) {
        const sent = await run(provider, sessionId)
        assert.ok(sent !== '' && !sent.includes(OPENAI), `provider ${String(provider)}, session ${String(sessionId)}: ${sent}`)
      }
    }
    for (const sessionId of [undefined, 'sess-1']) assert.ok((await run('DeepSeek', sessionId)).includes(OPENAI), 'an excluded provider goes as it is')
  } finally {
    for (const d of disposers) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.equal(getGlobalDispatcher(), before)
})

test('an excluded provider’s request goes out unmasked, and the log says so once for that provider', async () => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-skip-warn-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void> = []
  const warnings: unknown[][] = []
  // the one warn the gateway writes for a provider excludeProviders lets by
  const reported = (): unknown[][] => warnings.filter((w) => String(w[0]).includes('excludeProviders'))
  let listener: Listener | undefined
  const ctx: PluginContext = {
    logger: { info() {}, warn: (...a: unknown[]) => warnings.push(a), error() {} },
    effect: (fn) => disposers.push(fn()),
    on: (name: string, l: unknown) => {
      if (name === 'llm/stream') listener = l as Listener
    },
  }
  try {
    apply(ctx, { excludeProviders: ['deepseek'] })
    const call = async (provider: unknown, sessionId?: unknown, method = 'POST'): Promise<string> => {
      const n = bodies.length
      async function* adapter() {
        const res = await fetch(url, method === 'GET' ? { method } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }) })
        yield await res.text()
      }
      for await (const _ of (listener as Listener)({ provider, sessionId }, adapter)) void _
      return bodies[n] ?? ''
    }
    // a provider that is masked is no risk: nothing is said about it
    assert.ok(!(await call('openai', 'sess-1')).includes(OPENAI))
    assert.equal(reported().length, 0, 'no warn for a provider that is masked')
    // an excluded provider's request goes out as it is, and the log says so, naming the provider
    assert.ok((await call('DeepSeek', 'sess-1')).includes(OPENAI))
    assert.equal(reported().length, 1)
    assert.match(String(reported()[0]?.[0]), /"DeepSeek"/, 'the warn names the provider as the host did')
    // a further request of it is not reported again, and one that would not be masked anyway is no risk
    assert.ok((await call('deepseek')).includes(OPENAI))
    await call('deepseek', undefined, 'GET')
    assert.equal(reported().length, 1, 'one warn per provider, however many requests')
    assert.ok(!JSON.stringify(warnings).includes(OPENAI), 'no value in a warn')
  } finally {
    for (const d of disposers) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.equal(getGlobalDispatcher(), before)
})

test('through the plugin’s own listener, a plugin’s WebSocket is let through and a call’s is refused', async () => {
  let upgrades = 0
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    upgrades++
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/inbound`
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-ws-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void> = []
  const warnings: unknown[][] = []
  let listener: Listener | undefined
  const ctx: PluginContext = {
    logger: { info() {}, warn: (...a: unknown[]) => warnings.push(a), error() {} },
    effect: (fn) => disposers.push(fn()),
    on: (name: string, l: unknown) => {
      if (name === 'llm/stream') listener = l as Listener
    },
  }
  try {
    apply(ctx, {})
    assert.ok(listener, 'the plugin listens to llm/stream')
    const socket = () =>
      new Promise<'open' | 'error'>((resolve) => {
        const ws = new WebSocket(url)
        ws.addEventListener('open', () => {
          ws.close()
          resolve('open')
        })
        ws.addEventListener('error', () => resolve('error'))
      })
    // a plugin opening its inbound outside any model call: the whole chain lets it through
    assert.equal(await socket(), 'open')
    assert.equal(upgrades, 1)
    assert.equal(warnings.length, 1, 'one warn that its messages are not masked')
    assert.match(String(warnings[0]?.[0]), /was let through: its messages are not masked/)
    // the same socket opened from inside a model call is the provider's transport: refused
    async function* adapter(): AsyncGenerator<'open' | 'error'> {
      yield await socket()
    }
    let outcome: 'open' | 'error' | undefined
    for await (const r of (listener as Listener)({ provider: 'openai' }, adapter) as AsyncIterable<'open' | 'error'>) outcome = r
    assert.equal(outcome, 'error')
    assert.equal(upgrades, 1, 'refused before any byte went out')
    assert.match(String(warnings[1]?.[0]), /was refused: its messages cannot be masked/)
  } finally {
    for (const d of disposers) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.equal(getGlobalDispatcher(), before)
})

test('makeSkip skips only for masking off, an excluded provider’s stream, or a session turned off', async () => {
  let enabled = true
  const skip = makeSkip({ enabled: () => enabled, sessionOff: (s) => s === 'off' })
  const probe = (provider: unknown, excluded: string[], session?: string) => {
    async function* one() {
      yield skip()
    }
    return (async () => {
      for await (const v of routeStream(provider, excluded, one, session)) return v
      return undefined
    })()
  }
  assert.equal(skip(), false)
  assert.equal(await probe('', [''], 'sess-1'), false)
  assert.equal(await probe(undefined, ['x'], 'sess-1'), false)
  assert.equal(await probe('openai', ['deepseek'], ''), false)
  assert.equal(await probe('deepseek', ['deepseek']), true)
  assert.equal(await probe('openai', [], 'off'), true)
  enabled = false
  assert.equal(skip(), true)
})
