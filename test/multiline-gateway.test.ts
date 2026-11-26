import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults, resolveConfig } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine, RequestBlocked } from '../src/engine.ts'
import { RecordStore } from '../src/records.ts'

// These fixtures have no vendor prefix and are not live credentials.
const VALUES = ['Q7fK2m' + 'Zx9RtL4wVb', 'Nc1Ys6' + 'Hd3Tj5Ug0Pl']
const YAML = ['volcengineApiKey: |-', ...VALUES.map((v) => `  ${v}`), 'fetchSource: dsh'].join('\n')
const TOML = ['api_key = """', ...VALUES, '"""', 'fetchSource = "dsh"'].join('\n')
const chat = (content: string) => JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content }] })
const info = { host: 'api.fixture.invalid', path: '/v1/chat/completions', session: 'fixture-session' }

function assertSafe(value: unknown): void {
  const text = JSON.stringify(value)
  for (const v of VALUES) assert.ok(!text.includes(v), 'metadata must not contain a complete value')
}

test('multiline mask, warn and block keep records and statistics free of values', () => {
  for (const content of [YAML, TOML]) {
    for (const action of ['mask', 'warn', 'block']) {
      const actions = action === 'mask' ? {} : { SECRET: action }
      const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, actions: actions as never }))
      if (action === 'block') {
        assert.throws(() => engine.maskRequest(chat(content), info), (err: unknown) => {
          assert.ok(err instanceof RequestBlocked)
          assertSafe({ message: err.message, hits: err.hits })
          return true
        })
      } else {
        const exchange = engine.maskRequest(chat(content), info)
        assert.ok(exchange)
        for (const v of VALUES) assert.equal(exchange.text.includes(v), action === 'warn')
        exchange.finish()
      }
      const records = engine.records.recent()
      assert.equal(records.length, 1)
      assert.equal(records[0]?.values.length, 2)
      assert.ok(records[0]?.values.every((v) => v.finder === 'rule' && v.kind === 'SECRET'))
      assert.equal(records[0]?.blocked === true, action === 'block')
      if (action === 'warn') assert.equal(records[0]?.warned, 2)
      if (action === 'mask') assert.equal(records[0]?.n, 2)
      assertSafe(records)
      assertSafe(engine.records.stats())
    }
  }
})

test('multiline records persist only safe metadata in private day files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpg-multiline-record-'))
  const records = new RecordStore({ dir, keepDays: 30, keepBytes: 1 << 20, keepRecords: 50, flushDelayMs: 0 })
  try {
    for (const action of ['mask', 'warn', 'block']) {
      const actions = action === 'mask' ? {} : { SECRET: action }
      const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, actions: actions as never }), { records })
      if (action === 'block') assert.throws(() => engine.maskRequest(chat(TOML), info), RequestBlocked)
      else {
        const exchange = engine.maskRequest(chat(YAML), info)
        assert.ok(exchange)
        exchange.finish()
      }
    }
    await records.flush()
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    assert.equal(files.length, 1)
    const path = join(dir, files[0] as string)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.length, 3)
    assertSafe(rows)
    assertSafe(records.recent())
    assertSafe(records.stats())
  } finally {
    await records.close()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '/') && dir.includes('dpg-multiline-record-'))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native fetch sends multiline tokens masked and only restores the reply when enabled', async () => {
  const seen: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push(body)
      const content = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages[0]?.content
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const previous = getGlobalDispatcher()
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const gateway = installGateway(engine, { checkIntervalMs: 0 })
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    for (const restoreLog of [false, true]) {
      engine.reconfigure(resolveConfig({ ...defaults, restoreLog }))
      for (const content of [YAML, TOML]) {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(content) })
        assert.equal(response.status, 200)
        const reply = await response.json() as { choices: Array<{ message: { content: string } }> }
        const sent = seen[seen.length - 1] as string
        for (const v of VALUES) assert.ok(!sent.includes(v), 'origin must see no fixture value')
        const written = (JSON.parse(sent) as { messages: Array<{ content: string }> }).messages[0]?.content
        assert.ok(written)
        assert.equal(reply.choices[0]?.message.content, restoreLog ? content : written)
        assert.equal(written.replace(/⟦DSH_REDACTED:SECRET_[a-z2-7]{8}⟧/g, 'TOKEN'), content.replace(VALUES[0] as string, 'TOKEN').replace(VALUES[1] as string, 'TOKEN'))
      }
    }
    assert.equal(seen.length, 4)
    assertSafe(engine.records.recent())
  } finally {
    gateway.dispose()
    setGlobalDispatcher(previous)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
