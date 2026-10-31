import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { makeSkip, routeStream } from '../src/providers.ts'
import { MAX_SESSIONS, SessionSwitches } from '../src/sessions.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'

test('every session is masked until it is turned off, and the choice survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-sessions-'))
  const file = join(dir, 'sessions.json')
  try {
    const a = new SessionSwitches({ file })
    assert.equal(a.isOff('s1'), false)
    assert.equal(a.isOff(undefined), false)
    assert.equal(a.set('s1', true), false, 'already on')
    assert.equal(a.set('s1', false), true)
    assert.equal(a.set('', false), false)
    assert.equal(a.isOff('s1'), true)
    assert.equal(a.isOff('s2'), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { off: ['s1'] })
    const b = new SessionSwitches({ file })
    assert.equal(b.isOff('s1'), true)
    b.set('s1', true)
    assert.equal(new SessionSwitches({ file }).isOff('s1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable file masks every session; the oldest choices go past the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-sessions-'))
  const file = join(dir, 'sessions.json')
  const warned: unknown[] = []
  try {
    writeFileSync(file, '{not json')
    const s = new SessionSwitches({ file, logger: { warn: (...a: unknown[]) => warned.push(a) } })
    assert.equal(s.size, 0)
    assert.equal(warned.length, 1)
    for (let i = 0; i <= MAX_SESSIONS; i++) s.set(`s${i}`, false)
    assert.equal(s.size, MAX_SESSIONS)
    assert.equal(s.isOff('s0'), false)
    assert.equal(s.isOff(`s${MAX_SESSIONS}`), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session turned off goes out unmasked; another session stays masked', async () => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
  const switches = new SessionSwitches()
  switches.set('off-session', false)
  const before = getGlobalDispatcher()
  const gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), {
    checkIntervalMs: 0,
    skip: makeSkip({ enabled: () => true, sessionOff: (session) => switches.isOff(session) }),
    logger: { warn: () => {} },
  })
  async function* adapter() {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${OPENAI}` }] }) })
    yield await res.text()
  }
  const drain = async (it: AsyncIterable<unknown>) => {
    for await (const _ of it) void _
  }
  try {
    await drain(routeStream('openai', [], adapter, 'off-session'))
    assert.ok(bodies[0]?.includes(OPENAI), bodies[0])
    await drain(routeStream('openai', [], adapter, 'other-session'))
    assert.ok(!bodies[1]?.includes(OPENAI), bodies[1])
    // turned back on, the next request is masked again
    switches.set('off-session', true)
    await drain(routeStream('openai', [], adapter, 'off-session'))
    assert.ok(!bodies[2]?.includes(OPENAI), bodies[2])
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('two processes saving the list keep each other’s choices; a session turned back on stays on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-sessions-'))
  const file = join(dir, 'sessions.json')
  try {
    const a = new SessionSwitches({ file })
    const b = new SessionSwitches({ file })
    a.set('s1', false)
    b.set('s2', false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { off: ['s1', 's2'] })
    // a turns s1 back on; b, which still has s1 off in memory, saves another change
    a.set('s1', true)
    b.set('s3', false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { off: ['s2', 's3'] })
    assert.equal(b.isOff('s1'), false, 'b takes the merged list as its own')
    assert.equal(new SessionSwitches({ file }).isOff('s1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the list is saved 0600 in a 0700 directory, and no temporary file is left, even when the rename fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-sessions-'))
  const state = join(dir, 'state')
  const file = join(state, 'sessions.json')
  try {
    const s = new SessionSwitches({ file })
    s.set('s1', false)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(state).mode & 0o777, 0o700)
    assert.deepEqual(readdirSync(state), ['sessions.json'])
    // a directory where the file goes: the rename fails
    const blocked = join(dir, 'blocked')
    mkdirSync(join(blocked, 'sessions.json'), { recursive: true })
    writeFileSync(join(blocked, 'sessions.json', 'x'), '')
    const warned: unknown[] = []
    const t = new SessionSwitches({ file: join(blocked, 'sessions.json'), logger: { warn: (...a: unknown[]) => warned.push(a) } })
    assert.equal(t.set('s1', false), true)
    assert.equal(t.isOff('s1'), true, 'the choice holds for this run')
    assert.ok(warned.length >= 1)
    assert.deepEqual(readdirSync(blocked), ['sessions.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
