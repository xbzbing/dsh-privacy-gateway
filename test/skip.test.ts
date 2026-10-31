import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher } from 'undici'

import { apply, type PluginContext } from '../src/index.ts'
import { makeSkip, routeStream } from '../src/providers.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'

type Listener = Parameters<NonNullable<PluginContext['on']>>[1]

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
    on: (_name, l) => {
      listener = l
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
