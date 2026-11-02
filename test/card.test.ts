import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { afterRefresh, bars, bodyLines, elsewhereText, placeKey, placeLabel, readOverview, stepLabel, stepOf, timeLabel, took, valuesKey, warnings } from '../src/client/view.ts'
import { PACKAGE } from '../src/client/ids.ts'
import { en, zh } from '../src/client/locales.ts'
import { DESCRIPTION_MARK, panelDecision, watchShowPanel, type ConfigForms } from '../src/client/panelConfig.ts'
import { call, failureText, type ClientCtx } from '../src/client/rpc.ts'
import { createStore } from '../src/client/store.ts'
import { Config, SHOW_PANEL_DESCRIPTION } from '../src/config.ts'
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
    ['overview', 'providers', 'reset', 'sessionMasking', 'vendorView'],
  )
  assert.deepEqual(await svc.vendorView({ key: 7 }), { key: 7, body: '{}' })
  assert.equal(await svc.vendorView({ key: 8 }), null)
  assert.equal(await svc.vendorView({ key: 'x' as never }), null)
  // the provider list for the excludeProviders choice comes from the host, not the browser's own remote
  assert.deepEqual(await svc.providers(), [])
  // a source without reset refuses it rather than pretending to have cleared anything
  await assert.rejects(() => svc.reset(), /not offered/)
  await assert.rejects(() => svc.sessionMasking({ session: 's', on: false }), /not offered/)
  await assert.rejects(() => svc.sessionMasking({ session: '', on: false }), /session id/)
  assert.equal((svc as unknown as { typertRemote: { namespace: string } }).typertRemote.namespace, 'privacyGateway')
  assert.ok(readOverview(await svc.overview({ limit: 1000 })))
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
  assert.equal(PACKAGE, pkg.name)
})

test('the side-by-side view pretty-prints JSON, picks out each replaced place, and keeps the changed lines only when asked', async () => {
  const { viewLines } = await import('../src/client/view.ts')
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'key {{API_KEY_aaaabbbb}} and sk-proj-FAKEfake1234' }, { role: 'assistant', content: 'ok' }] })
  const all = viewLines(bodyLines(body), ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'], false)
  assert.ok(all.lines.length > 3)
  const only = viewLines(bodyLines(body), ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'], true)
  assert.equal(only.lines.length, 1)
  assert.deepEqual(
    only.lines[0]?.parts.filter((p) => p.id).map((p) => p.id),
    ['{{API_KEY_aaaabbbb}}', 'sk-proj-FAKEfake1234'],
  )
  assert.equal(only.lines[0]?.parts.map((p) => p.text).join('').trim(), '"content": "key {{API_KEY_aaaabbbb}} and sk-proj-FAKEfake1234"')
  assert.equal(viewLines(bodyLines(body), [], false, 2).truncated, true)
  assert.deepEqual(bodyLines('not json\nat all'), ['not json', 'at all'])
  // the view's memo key: the same placeholders give the same key, a different set another
  assert.equal(valuesKey([{ placeholder: 'a' }, { placeholder: 'b' }]), valuesKey([{ placeholder: 'a' }, { placeholder: 'b' }]))
  assert.notEqual(valuesKey([{ placeholder: 'a' }]), valuesKey([{ placeholder: 'a' }, { placeholder: 'b' }]))
})

/** What the settings wire carries: schemastery's toJSON() of the real schema, a reference table, not a nested dict. */
const WIRE = Config.toJSON() as unknown

test('showPanel’s description holds the words the client half knows it by', () => {
  assert.ok(SHOW_PANEL_DESCRIPTION.includes(DESCRIPTION_MARK))
  assert.ok(JSON.stringify(WIRE).includes(DESCRIPTION_MARK))
})

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
  const fields = schemaFields(WIRE)
  assert.ok(fields.includes('excludeProviders') && fields.includes('showPanel'), fields.join())
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
  assert.equal(findNamespace([{ ns: 'n1', schema: { dict: { showPanel: { meta: { description: `… / ${DESCRIPTION_MARK}` } } } } }]), 'n1')
  assert.equal(findNamespace([{ ns: 'n2', schema: { dict: { showPanel: { meta: { description: 'x' } } } } }]), undefined)
})

test('a value’s place reads as the part of the conversation it was in', () => {
  assert.equal(placeKey({ path: 'system.0.text' }), 'place.system')
  assert.equal(placeKey({ path: 'messages.0.content', role: 'system' }), 'place.system')
  assert.equal(placeKey({ path: 'messages.3.content.0.content', role: 'user', type: 'tool_result' }), 'place.toolResult')
  assert.equal(placeKey({ path: 'messages.4.content', role: 'tool' }), 'place.toolResult')
  assert.equal(placeKey({ path: 'messages.2.tool_calls.0.function.arguments', role: 'assistant' }), 'place.toolCall')
  assert.equal(placeKey({ path: 'messages.2.content.1.input.command', role: 'assistant', type: 'tool_use' }), 'place.toolCall')
  assert.equal(placeKey({ path: 'messages.1.content', role: 'user' }), 'place.user')
  assert.equal(placeKey({ path: 'messages.2.content', role: 'assistant' }), 'place.assistant')
  assert.equal(placeKey({ path: 'prompt' }), 'place.other')
})

test('a place also reads as the message it went in, short enough for the row', () => {
  assert.equal(placeLabel('messages.3.content.0.text'), 'messages.3')
  assert.equal(placeLabel('messages.0.content'), 'messages.0')
  assert.equal(placeLabel('messages.2.tool_calls.0.function.arguments'), 'messages.2')
  assert.equal(placeLabel('system.0.text'), 'system.0')
  assert.equal(placeLabel('contents.1.parts.0.text'), 'contents.1')
  assert.equal(placeLabel('prompt'), 'prompt')
  assert.equal(placeLabel('input.0.content'), 'input.0')
  // an index deeper in is not the message's: naming it would invent one (docs/adr/0028)
  assert.equal(placeLabel('systemInstruction.parts.0.text'), 'systemInstruction')
  assert.equal(placeLabel('prompt.x.0'), 'prompt')
  assert.equal(placeLabel('messages.abc.3'), 'messages')
  assert.equal(placeLabel('messages.'), 'messages')
  assert.equal(placeLabel(''), '')
  assert.equal(placeLabel('.3'), '')
})

test('a record’s turn and step read as the trajectory numbers them, and not at all when it names none', () => {
  assert.deepEqual(stepOf({ turn: 4, step: 2 }), { turn: 4, step: 2 })
  assert.equal(stepLabel({ turn: 4, step: 2 }), '4·2')
  assert.equal(stepLabel({ turn: 12, step: 30 }), '12·30')
  for (const r of [{}, { turn: 4 }, { step: 2 }, { turn: 0, step: 2 }, { turn: 4, step: 0 }, { turn: 4.5, step: 2 }, { turn: '4', step: '2' }, { turn: 4, step: {} }, { turn: Number.NaN, step: 1 }, { turn: 4, step: Number.POSITIVE_INFINITY }]) {
    assert.equal(stepOf(r), undefined, JSON.stringify(r))
  }
})

/** A dictionary that keeps each key and its params apart, so the words tested are the ones the card picks. */
function fakeT(k: string, p?: Record<string, string | number>): string {
  if (k === 'recent.placeSep') return '、'
  return p ? `${k}(${Object.entries(p).map(([a, b]) => `${a}=${b}`).join(',')})` : k
}

test('the other places a value went read as one line, each message once, the rest only counted', () => {
  const none = elsewhereText({}, fakeT as never)
  assert.equal(none, '')
  const one = elsewhereText({ elsewhere: [{ path: 'messages.1.content' }] }, fakeT as never)
  assert.equal(one, 'recent.elsewhere(paths=messages.1)')
  // two places in the same message are one message to go back to
  const same = elsewhereText({ elsewhere: [{ path: 'messages.1.content' }, { path: 'messages.1.tool_calls.0.function.arguments' }] }, fakeT as never)
  assert.equal(same, 'recent.elsewhere(paths=messages.1)')
  const two = elsewhereText({ elsewhere: [{ path: 'messages.1.content' }, { path: 'messages.2.content' }] }, fakeT as never)
  assert.equal(two, 'recent.elsewhere(paths=messages.1、messages.2)')
  const more = elsewhereText({ elsewhere: [{ path: 'messages.1.content' }], elsewhereOmitted: 4 }, fakeT as never)
  assert.equal(more, 'recent.elsewhereMore(paths=messages.1,n=4)')
  // the count alone still says something when no place could be named
  assert.equal(elsewhereText({ elsewhereOmitted: 3 }, fakeT as never), 'recent.elsewhereOmitted(n=3)')
  assert.equal(elsewhereText({ elsewhere: [], elsewhereOmitted: 0 }, fakeT as never), '')
})

test('the tab follows the host alone when there is no settings mirror, and the mirror speeds up only "on"', () => {
  assert.equal(panelDecision(undefined, undefined), undefined)
  assert.equal(panelDecision(true, undefined), true)
  assert.equal(panelDecision(false, undefined), false)
  assert.equal(panelDecision(false, true), true)
  assert.equal(panelDecision(true, false), true)
  assert.equal(panelDecision(undefined, false), undefined)
  assert.equal(panelDecision(false, false), false)
})

/** A client context whose host half answers `overview` with showPanel as `on()` says. */
function hostCtx(on: () => boolean): ClientCtx {
  const rpc = { call: async () => ({ ok: true, value: { ...overview(), showPanel: on() } }) }
  return { get: (k: string) => (k === 'connection' ? { rpc } : undefined) } as unknown as ClientCtx
}

const settle = () => new Promise((r) => setImmediate(r))

test('without a settings mirror, the host turning showPanel off takes the tab away', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let on = true
    const seen: boolean[] = []
    const stop = watchShowPanel(hostCtx(() => on), (v) => seen.push(v), createStore<ConfigForms | undefined>(undefined))
    await settle()
    assert.deepEqual(seen, [true])
    on = false
    mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(seen, [true, false])
    stop()
  } finally {
    mock.timers.reset()
  }
})

test('with a settings mirror, off needs the host and the mirror both', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let host = true
    let mirrorOn = true
    const listeners = new Set<() => void>()
    const view = () => ({ namespaces: [{ ns: 'dsh-privacy-gateway', schema: WIRE, value: { showPanel: mirrorOn } }] })
    const mirror = { getSnapshot: () => ({ view: view() }), subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), ensure: async () => {} }
    const forms = createStore<ConfigForms | undefined>(undefined)
    const seen: boolean[] = []
    const stop = watchShowPanel(hostCtx(() => host), (v) => seen.push(v), forms)
    // the settings service arrives after the watch began
    forms.set({ describe: () => mirror, get: () => { throw new Error('unused') } } as unknown as ConfigForms)
    await settle()
    assert.deepEqual(seen, [true])
    mirrorOn = false
    for (const l of listeners) l()
    assert.deepEqual(seen, [true], 'the mirror alone does not take the tab away')
    host = false
    mock.timers.tick(60_000)
    await settle()
    assert.deepEqual(seen, [true, false])
    stop()
    assert.equal(listeners.size, 0)
  } finally {
    mock.timers.reset()
  }
})

test('a refresh that fails keeps what was shown, marked stale; with nothing shown it is an error', () => {
  const o = overview()
  const ready = afterRefresh({ status: 'loading' }, { ok: true, value: o })
  assert.deepEqual(ready, { status: 'ready', data: o })
  assert.deepEqual(afterRefresh(ready, { ok: false, failure: { code: 'noConnection' } }), { status: 'ready', data: o, stale: { code: 'noConnection' } })
  assert.deepEqual(afterRefresh({ status: 'loading' }, { ok: false, failure: { code: 'malformed' } }), { status: 'error', failure: { code: 'malformed' } })
  assert.deepEqual(afterRefresh(afterRefresh(ready, { ok: false, failure: { code: 'malformed' } }), { ok: true, value: o }), { status: 'ready', data: o })
})

test('an overview from another host version is filled in, not trusted as it is', () => {
  assert.equal(readOverview(null), undefined)
  assert.equal(readOverview({ active: true, stats: {}, recent: [] }), undefined)
  const odd = readOverview({ active: true, stats: { today: {}, week: { requests: 'x' }, month: { requests: 3, kinds: { a: 1, b: 'x' } } }, recent: [{ key: 1, time: 't', values: [] }, { nope: true }] })
  assert.ok(odd)
  assert.equal(odd.stats.today.restoredInTools, 0)
  assert.deepEqual(odd.stats.today.tookMs, { sum: 0, max: 0 })
  assert.equal(odd.stats.week.requests, 0)
  assert.deepEqual(odd.stats.month.kinds, { a: 1 })
  assert.equal(odd.stats.failStreak, 0)
  assert.equal(odd.recent.length, 1)
  assert.equal(odd.recent[0]?.n, 0)
  assert.equal('valuesOmitted' in (odd.recent[0] ?? {}), false)
  const capped = readOverview({ active: true, stats: { today: {}, week: {}, month: {} }, recent: [{ key: 1, time: 't', values: [], valuesOmitted: 12 }, { key: 2, time: 't', values: [], valuesOmitted: 'x' }] })
  assert.equal(capped?.recent[0]?.valuesOmitted, 12)
  assert.equal(capped?.recent[1]?.valuesOmitted, undefined)
  // the places of a value are checked the same way: a path is what the card names them by (docs/adr/0028)
  const places = readOverview({
    active: true,
    stats: { today: {}, week: {}, month: {} },
    recent: [
      {
        key: 1,
        time: 't',
        values: [
          { placeholder: '{{A}}', at: { path: 'messages.3.content', role: 'user' }, elsewhere: [{ path: 'messages.7.content', role: 'user' }, { role: 'user' }, 'x'], elsewhereOmitted: 2 },
          { placeholder: '{{B}}', at: { role: 'user' }, elsewhere: 'x', elsewhereOmitted: 'y' },
          { placeholder: '{{C}}', at: 'x', elsewhere: [], elsewhereOmitted: 0 },
        ],
      },
    ],
  })
  // a value is drawn field by field, so one of another version cannot reach the table as an object
  const val = (placeholder: string, extra: Record<string, unknown> = {}) => ({ placeholder, kind: '', finder: 'rule', head: '', len: 0, n: 0, ...extra })
  assert.deepEqual(places?.recent[0]?.values[0], val('{{A}}', { at: { path: 'messages.3.content', role: 'user' }, elsewhere: [{ path: 'messages.7.content', role: 'user' }], elsewhereOmitted: 2 }))
  assert.deepEqual(places?.recent[0]?.values[1], val('{{B}}'))
  assert.deepEqual(places?.recent[0]?.values[2], val('{{C}}'))
  // a value the table cannot name at all is left out
  assert.equal(readOverview({ active: true, stats: { today: {}, week: {}, month: {} }, recent: [{ key: 1, time: 't', values: [{ kind: 'API_KEY' }, {}, { placeholder: 7 }] }] })?.recent[0]?.values.length, 0)
  // more places than the card names are counted, and a path it was given twice is one place
  const many = readOverview({
    active: true,
    stats: { today: {}, week: {}, month: {} },
    recent: [{ key: 1, time: 't', values: [{ placeholder: '{{D}}', elsewhere: [...Array.from({ length: 40 }, (_, i) => ({ path: `messages.${i}.content` })), { path: 'messages.0.content' }], elsewhereOmitted: 2 }] }],
  })
  const d = many?.recent[0]?.values[0]
  assert.equal(d?.elsewhere?.length, 7)
  // 40 distinct paths were given, 7 shown, and the 2 the host had already counted
  assert.equal(d?.elsewhereOmitted, 35)
  assert.equal(new Set(d?.elsewhere?.map((x) => x.path)).size, 7)
  // the turn and step are drawn only when both are steps the trajectory counts (docs/adr/0030)
  const stepped = (turn: unknown, step: unknown) =>
    readOverview({ active: true, stats: { today: {}, week: {}, month: {} }, recent: [{ key: 1, time: 't', values: [], turn, step }] })?.recent[0]
  const ok = stepped(4, 2)
  assert.equal(ok?.turn, 4)
  assert.equal(ok?.step, 2)
  for (const [turn, step] of [[undefined, 2], [4, undefined], [0, 2], [4, 0], [4.5, 2], ['4', '2'], [4, {}], [{}, 2], [Number.NaN, 1], [4, Number.POSITIVE_INFINITY]] as const) {
    const r = stepped(turn, step)
    assert.equal(r?.turn, undefined, JSON.stringify([turn, step]))
    // the two go together: neither is left behind as an object the row would draw
    assert.equal(Object.hasOwn(r ?? {}, 'turn'), false, JSON.stringify([turn, step]))
    assert.equal(Object.hasOwn(r ?? {}, 'step'), false, JSON.stringify([turn, step]))
  }
})

test('a call fails with a code the page words itself, or the host’s own message', async () => {
  const t = (k: string, p?: Record<string, string | number>) => `${k}${p ? JSON.stringify(p) : ''}`
  const none = { get: () => undefined } as unknown as ClientCtx
  const r1 = await call(none, 'overview', {}, (v) => v)
  assert.deepEqual(r1, { ok: false, failure: { code: 'noConnection' } })
  const reply = (r: unknown) => ({ get: () => ({ rpc: { call: async () => r } }) }) as unknown as ClientCtx
  assert.deepEqual(await call(reply(null), 'x', undefined, (v) => v), { ok: false, failure: { code: 'malformed' } })
  assert.deepEqual(await call(reply({ ok: false, error: { message: 'boom' } }), 'x', undefined, (v) => v), { ok: false, failure: { code: 'remote', message: 'boom' } })
  assert.deepEqual(await call(reply({ ok: true, value: 1 }), 'x', undefined, () => undefined), { ok: false, failure: { code: 'malformed' } })
  assert.deepEqual(await call(reply({ ok: true, value: 1 }), 'x', undefined, (v) => v), { ok: true, value: 1 })
  assert.equal(failureText({ code: 'noConnection' }, t as never), 'err.noConnection')
  assert.equal(failureText({ code: 'remote', message: 'boom' }, t as never), 'err.remote{"message":"boom"}')
})
