import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import type { PrivacyGatewayConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { isSessionId, NAMESPACE, PrivacyGatewayService, type OverviewSource } from '../src/remote.ts'

const SENTINEL = 'sk-' + 'proj-SOURCEsource0123456789abcdef'
// found by its context only (the password in a URL): bare in a title, only the value table knows it
const PASSWORD = 'Hunter' + '2Secret9Long'
const SESSION = 'sess-source-1'
const chat = (content: string) => JSON.stringify({ model: 'gpt-x', stream: false, messages: [{ role: 'user', content }] })
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

interface Harness {
  source: OverviewSource
  logs: string[]
  /** Sends one chat request for SESSION through the gateway. */
  send(content: string): Promise<void>
  /** Disposes the plugin and waits for its records on disk. */
  close(): Promise<string>
}

async function withPlugin(config: PrivacyGatewayConfig, names: { title: string; workspace: string }, run: (h: Harness) => Promise<void>): Promise<void> {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-source-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const disposers: Array<() => void> = []
  const logs: string[] = []
  const live = { id: SESSION }
  const services: Record<string, unknown> = {
    sessions: { get: (id: string) => (id === SESSION ? live : undefined) },
    sessionTitle: { get: (s: unknown) => (s === live ? { title: names.title } : undefined) },
    workspaceRegistry: { list: () => [{ title: names.workspace, sessionIds: [SESSION] }] },
  }
  let source: OverviewSource | undefined
  const logger = { info: (...a: unknown[]) => logs.push(a.map(String).join(' ')), warn: (...a: unknown[]) => logs.push(a.map(String).join(' ')), error: () => {} }
  let closed = false
  const close = async (wait = true): Promise<string> => {
    if (!closed) for (const d of disposers) d()
    closed = true
    const dir = join(home, 'masking')
    for (let i = 0; wait && i < 200 && !(existsSync(dir) && readdirSync(dir).length > 0); i++) await new Promise((r) => setTimeout(r, 10))
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('') : ''
  }
  try {
    apply({ logger, effect: (fn) => disposers.push(fn()), get: (name) => services[name], plugin: (_cls, s) => (source = s as OverviewSource) }, config)
    for (let i = 0; i < 200 && !source; i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(source, 'the Remote source is handed to ctx.plugin')
    const send = async (content: string): Promise<void> => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': SESSION }, body: chat(content) })
      assert.equal(res.status, 200)
      await res.text()
    }
    await run({ source, logs, send, close: () => close() })
  } finally {
    await close(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    // the disposer flushes the records without waiting, so a last write may still be landing
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  }
}

test('a session title or workspace name with a masked value keeps it out of the records, the day file and the overview', async () => {
  const names = { title: `修复 ${SENTINEL} 和 ${PASSWORD} 泄漏`, workspace: `ws ${PASSWORD}` }
  await withPlugin({ record: true }, names, async (h) => {
    await h.send(`key ${SENTINEL} db postgres://app:${PASSWORD}@db.internal/x`)
    const overview = JSON.stringify(h.source.overview(50))
    const [rec] = h.source.overview(50).recent
    assert.ok(rec)
    assert.match(rec.title ?? '', /^修复 \{\{API_KEY_[a-z2-7]{8}\}\} 和 \{\{PASSWORD_[a-z2-7]{8}\}\} 泄漏$/)
    assert.match(rec.workspace ?? '', /^ws \{\{PASSWORD_[a-z2-7]{8}\}\}$/)
    for (const v of [SENTINEL, PASSWORD]) assert.ok(!overview.includes(v), `overview holds ${v.slice(0, 4)}…`)
    const disk = await h.close()
    assert.ok(disk.includes('"title"'))
    for (const v of [SENTINEL, PASSWORD]) assert.ok(!disk.includes(v), `day file holds ${v.slice(0, 4)}…`)
  })
})

test('a long title is cut by characters, never in the middle of one', async () => {
  const names = { title: 'a' + '😀'.repeat(250), workspace: '工作区' }
  await withPlugin({}, names, async (h) => {
    await h.send(`key ${SENTINEL}`)
    const [rec] = h.source.overview(50).recent
    assert.equal([...(rec?.title ?? '')].length, 200)
    assert.ok(!LONE_SURROGATE.test(rec?.title ?? ''))
    assert.equal(rec?.workspace, '工作区')
  })
})

test('vendorView turned off serves no body and drops the ones kept, before any request', async () => {
  const config: PrivacyGatewayConfig = { vendorView: true }
  await withPlugin(config, { title: 't', workspace: 'w' }, async (h) => {
    await h.send(`key ${SENTINEL}`)
    const first = h.source.overview(50)
    const key = first.views?.[0]
    assert.ok(key !== undefined)
    assert.ok(h.source.vendorView?.(key)?.body.includes('{{API_KEY_'))
    config.vendorView = false
    assert.equal(h.source.vendorView?.(key), null)
    assert.deepEqual(h.source.overview(50).views, [])
    // turned on again, nothing kept before comes back
    config.vendorView = true
    assert.equal(h.source.vendorView?.(key), null)
  })
})

test('a session id from the browser is checked, and logged quoted', async () => {
  assert.equal(isSessionId('session-c9e7429e-b7fb-4053.x:1_A'), true)
  for (const bad of ['', 'a'.repeat(129), 'a\nb', 'a b', 'a/b', '会话', 7, undefined]) assert.equal(isSessionId(bad), false, String(bad))
  const ctx = new Context()
  const asked: string[] = []
  const fiber = ctx.plugin(PrivacyGatewayService, {
    overview: () => {
      throw new Error('not asked')
    },
    setSessionMasking: (session: string) => {
      asked.push(session)
      return false
    },
  })
  await fiber
  const svc = ctx.get(NAMESPACE) as PrivacyGatewayService
  await assert.rejects(() => svc.sessionMasking({ session: 'x\ninfo forged', on: false }), /session id/)
  await assert.rejects(() => svc.sessionMasking({ session: 'a'.repeat(129), on: false }), /session id/)
  assert.deepEqual(await svc.sessionMasking({ session: 'a'.repeat(128), on: false }), { on: false })
  assert.deepEqual(asked, ['a'.repeat(128)])
  fiber.dispose()
  // the plugin's own source quotes the id in the log line
  await withPlugin({}, { title: 't', workspace: 'w' }, async (h) => {
    h.source.setSessionMasking?.('odd\nid', false)
    const line = h.logs.find((l) => l.includes('for session'))
    assert.ok(line?.includes('"odd\\nid"'), line)
    assert.ok(!line?.includes('\n'))
    h.source.setSessionMasking?.('odd\nid', true)
  })
})
