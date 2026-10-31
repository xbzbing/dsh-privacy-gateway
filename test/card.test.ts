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
    vendorView: (key: number) => (key === 7 ? { key, body: '{}' } : null),
  })
  await fiber
  const svc = ctx.get(NAMESPACE) as PrivacyGatewayService
  assert.ok(svc)
  assert.deepEqual(
    remoteMethods(svc).map((m) => m.method).sort(),
    ['overview', 'vendorView'],
  )
  assert.deepEqual(await svc.vendorView({ key: 7 }), { key: 7, body: '{}' })
  assert.equal(await svc.vendorView({ key: 8 }), null)
  assert.equal(await svc.vendorView({ key: 'x' as never }), null)
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

test('the side-by-side view pretty-prints JSON, picks out each replaced place, and keeps the changed lines only when asked', async () => {
  const { viewLines } = await import('../src/client/view.ts')
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'key {{API_KEY_aaaabbbb}} and sk-proj-FAKEfake1234' }, { role: 'assistant', content: 'ok' }] })
  const all = viewLines(body, ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'], false)
  assert.ok(all.lines.length > 3)
  const only = viewLines(body, ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'], true)
  assert.equal(only.lines.length, 1)
  assert.deepEqual(
    only.lines[0]?.parts.filter((p) => p.id).map((p) => p.id),
    ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'],
  )
  assert.equal(only.lines[0]?.parts.map((p) => p.text).join('').trim(), '"content": "key {{API_KEY_aaaabbbb}} and sk-proj-FAKEfake1234"')
  assert.equal(viewLines(body, [], false, 2).truncated, true)
})

/** What the settings wire carries: schemastery's toJSON(), a reference table, not a nested dict. */
const WIRE = {
  uid: 4,
  refs: {
    '1': { type: 'boolean', meta: { default: false, description: '在会话右侧栏显示「隐私保护」面板 / Show the Privacy panel in the right sidebar' } },
    '2': { type: 'array', meta: { default: [] }, inner: 3 },
    '3': { type: 'string', meta: {} },
    '4': { type: 'object', meta: { default: {} }, dict: { excludeProviders: 2, showPanel: 1 } },
  },
}

test('showPanel is read from the namespace that is ours', async () => {
  const { showPanelOf } = await import('../src/client/panelConfig.ts')
  assert.equal(showPanelOf([{ ns: 'other', schema: { dict: { showPanel: { meta: { description: 'x' } } } }, value: { showPanel: true } }]), undefined)
  assert.equal(showPanelOf([{ ns: 'dsh-privacy-gateway', schema: WIRE, value: { showPanel: true } }]), true)
  assert.equal(showPanelOf([{ ns: 'dsh-privacy-gateway', schema: WIRE, value: {} }]), false)
})

test('the records go a page at a time, the page held within the pages there are', async () => {
  const { pageOf } = await import('../src/client/view.ts')
  const items = Array.from({ length: 23 }, (_, i) => i)
  assert.deepEqual(pageOf(items, 0, 10), { items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], page: 0, pages: 3 })
  assert.deepEqual(pageOf(items, 2, 10).items, [20, 21, 22])
  assert.equal(pageOf(items, 9, 10).page, 2)
  assert.deepEqual(pageOf([], 3, 10), { items: [], page: 0, pages: 1 })
})

test("a namespace's fields are read from schemastery's reference table, and from a nested dict", async () => {
  const { schemaFields } = await import('../src/client/panelConfig.ts')
  assert.deepEqual(schemaFields(WIRE), ['excludeProviders', 'showPanel'])
  assert.deepEqual(schemaFields({ dict: { showPanel: {} } }), ['showPanel'])
  assert.deepEqual(schemaFields({ uid: 9, refs: {} }), [])
  assert.deepEqual(schemaFields(undefined), [])
})

test('the settings namespace is ours by its name, its other field, or showPanel description', async () => {
  const { findNamespace } = await import('../src/client/panelConfig.ts')
  assert.equal(findNamespace([{ ns: 'other', schema: {} }]), undefined)
  assert.equal(findNamespace([{ ns: 'other', schema: { dict: { showPanel: {} } } }]), undefined)
  assert.equal(findNamespace([{ ns: 'include:dsh-privacy-gateway', schema: WIRE }]), 'include:dsh-privacy-gateway')
  assert.equal(findNamespace([{ ns: 'n0', schema: WIRE }]), 'n0')
  assert.equal(findNamespace([{ ns: 'n1', schema: { dict: { showPanel: { meta: { description: '… / Show the Privacy panel in the right sidebar' } } } } }]), 'n1')
  assert.equal(findNamespace([{ ns: 'n2', schema: { dict: { showPanel: { meta: { description: 'x' } } } } }]), undefined)
})
