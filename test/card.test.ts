import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { bars, isOverview, timeLabel, took, warnings } from '../src/client/view.ts'
import { en, zh } from '../src/client/locales.ts'
import { emptyTotals, type Stats } from '../src/records.ts'
import { clampLimit, NAMESPACE, PrivacyGatewayService, type Overview } from '../src/remote.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function overview(over: Partial<Stats> = {}): Overview {
  return { active: true, secrets: true, personal: false, record: true, values: 0, stats: { today: emptyTotals(), week: emptyTotals(), month: emptyTotals(), failStreak: 0, ...over }, recent: [] }
}

test('the service answers privacyGateway/overview with the latest records capped', async () => {
  const ctx = new Context()
  const asked: number[] = []
  const fiber = ctx.plugin(PrivacyGatewayService, {
    overview: (limit: number) => {
      asked.push(limit)
      return overview()
    },
  })
  await fiber
  const svc = ctx.get(NAMESPACE) as PrivacyGatewayService
  assert.ok(svc)
  assert.deepEqual(remoteMethods(svc), [{ method: 'overview', invocation: { kind: 'direct' } }])
  assert.equal((svc as unknown as { typertRemote: { namespace: string } }).typertRemote.namespace, 'privacyGateway')
  assert.ok(isOverview(await svc.overview({ limit: 1000 })))
  await svc.overview({})
  assert.deepEqual(asked, [200, 50])
  fiber.dispose()
  assert.equal(ctx.get(NAMESPACE), undefined)
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit('7'), 50)
})

test('the bars go largest first, the rest summed, as shares of the largest', () => {
  assert.deepEqual(bars({ A: 10, B: 5, C: 0 }), [
    { label: 'A', value: 10, pct: 100 },
    { label: 'B', value: 5, pct: 50 },
  ])
  const many = bars({ a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3, h: 2 }, 6, 'other')
  assert.equal(many.length, 7)
  assert.deepEqual(many[6], { label: 'other', value: 5, pct: 56 })
  assert.deepEqual(bars({}), [])
})

test('the warnings are the failure streak, unknown placeholders and restores in tool arguments', () => {
  const t = { ...emptyTotals(), unmapped: 2, restoredInTools: 3 }
  assert.deepEqual(warnings(overview({ failStreak: 4 }), t).map((w) => [w.key, w.n, w.tone]), [
    ['warn.streak', 4, 'error'],
    ['warn.unmapped', 2, 'warn'],
    ['warn.inTools', 3, 'warn'],
  ])
  assert.deepEqual(warnings(overview(), emptyTotals()), [])
  assert.deepEqual(took({ ...emptyTotals(), requests: 3, tookMs: { sum: 1, max: 0.6789 } }), { avg: 0.33, max: 0.68 })
})

test('a record’s time reads as a clock today and as a date before', () => {
  const now = new Date(2026, 9, 31, 16, 0, 0)
  assert.equal(timeLabel(new Date(2026, 9, 31, 9, 5, 7).toISOString(), now), '09:05:07')
  assert.equal(timeLabel(new Date(2026, 9, 30, 23, 1).toISOString(), now), '10-30 23:01')
  assert.equal(timeLabel('nonsense', now), '')
})

test('both dictionaries have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const k of Object.keys(zh) as Array<keyof typeof zh>) {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(holes(en[k]), holes(zh[k]), k)
  }
})

test('the manifest ships the client half for the web platform', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, string>
    files: string[]
    dsh: { client?: { platform?: string; inject?: string[] } }
  }
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.files.includes('lib'))
  assert.equal(pkg.dsh.client?.platform, 'web')
  assert.ok(pkg.dsh.client?.inject?.includes('@deepseek-ai/dsh-client-connection'))
  const client = readFileSync(join(root, 'src/client/index.ts'), 'utf8')
  assert.match(client, new RegExp(`PACKAGE = '${pkg.name}'`))
})
