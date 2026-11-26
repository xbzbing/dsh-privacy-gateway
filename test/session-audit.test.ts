import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply } from '../src/index.ts'
import type { OverviewSource } from '../src/remote.ts'

test('a session toggle applies live rules and never logs the raw sensitive identifier', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dpg-session-audit-'))
  const previous = process.env.DSH_PRIVACY_GATEWAY_HOME
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const disposers: Array<() => void | Promise<void>> = []
  const logs: string[] = []
  let source: OverviewSource | undefined
  const config = { record: false, words: [] as string[], allow: [] as string[] }
  const word = 'AuditPrivateName'
  const session = `prefix${word}suffix`
  try {
    apply({
      logger: { info: (...args) => logs.push(args.map(String).join(' ')), warn: () => {}, error: () => {} },
      effect: (fn) => disposers.push(fn()),
      plugin: (_plugin, cfg) => { source = cfg as OverviewSource },
    }, config)
    for (let i = 0; !source && i < 100; i++) await new Promise((r) => setImmediate(r))
    assert.ok(source)
    config.words = [word]
    config.allow = [word]
    assert.equal(source.setSessionMasking?.(session, false), false)
    assert.equal(source.setSessionMasking?.(session, true), true)
    const toggles = logs.filter((line) => line.includes('from its Privacy tab'))
    assert.equal(toggles.length, 2)
    assert.ok(toggles.every((line) => !line.includes(word)))
    assert.ok(toggles.every((line) => line.includes('⟦DSH_REDACTED:TERM_')))
    assert.equal(source.overview(10, session).sessionMasking, true)
    assert.ok(!JSON.stringify(source.overview(10, session)).includes(word))
  } finally {
    for (const dispose of disposers) await dispose()
    if (previous === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = previous
    assert.ok(home.startsWith(join(tmpdir(), 'dpg-session-audit-')))
    rmSync(home, { recursive: true, force: true })
  }
})

test('new rules clean an existing safe session label before it is used in a new log or query label', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dpg-session-label-'))
  const previous = process.env.DSH_PRIVACY_GATEWAY_HOME
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const disposers: Array<() => void | Promise<void>> = []
  const logs: string[] = []
  let source: OverviewSource | undefined
  const config = { record: false, words: [] as string[] }
  const word = 'private-launch-project-codename'
  const session = `sess-${word}`
  const key = 'sk-' + 'proj-LABELlabel0123456789abcdef'
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    apply({
      logger: { info: (...args) => logs.push(args.map(String).join(' ')), warn: () => {}, error: () => {} },
      effect: (fn) => disposers.push(fn()),
      plugin: (_plugin, cfg) => { source = cfg as OverviewSource },
    }, config)
    for (let i = 0; !source && i < 100; i++) await new Promise((r) => setImmediate(r))
    assert.ok(source)
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': session },
      body: JSON.stringify({ messages: [{ role: 'user', content: key }] }),
    })
    await res.text()
    assert.equal(source.overview(10, session).recent.length, 1)
    assert.equal(source.overview(10, session).recent[0]?.session, session)
    config.words = [word]
    assert.equal(source.setSessionMasking?.(session, false), false)
    const toggle = logs.find((line) => line.includes('from its Privacy tab'))
    assert.ok(toggle && !toggle.includes(word))
    const overview = source.overview(10, session)
    assert.ok(overview.session && !overview.session.includes(word))
    assert.equal(overview.recent.length, 1, 'raw lookup remains independent of the displayed label')
    assert.equal(overview.recent[0]?.session, session, 'historical request records are not rewritten by a label read')
  } finally {
    for (const dispose of disposers) await dispose()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    if (previous === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = previous
    assert.ok(home.startsWith(join(tmpdir(), 'dpg-session-label-')))
    rmSync(home, { recursive: true, force: true })
  }
})
