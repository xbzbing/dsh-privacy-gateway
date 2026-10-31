import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, defaults, LIVE_FIELDS } from '../src/config.ts'
import { addEntry, choiceValue, countValue, FIELDS, GROUPS, groupSummary, listValue, parseCount, pickedSummary, removeEntry, switchValue } from '../src/client/fields.ts'
import { en, zh } from '../src/client/locales.ts'

test('the page’s defaults are the host’s', () => {
  for (const f of FIELDS) assert.deepEqual(f.default, defaults[f.key], f.key)
})

test('every field the page edits is volatile, so the settings service lets it be written', () => {
  const root = Config.toJSON() as unknown as { uid: number; refs: Record<number, { dict?: Record<string, number> }> }
  const dict = root.refs[root.uid]?.dict ?? {}
  for (const f of FIELDS) {
    const node = root.refs[dict[f.key] as number] as { meta?: { volatile?: boolean } } | undefined
    assert.equal(node?.meta?.volatile, true, f.key)
  }
})

test('the gateway rebuilds from every volatile field the page edits but the two read where they are used', () => {
  const page = FIELDS.map((f) => f.key).filter((k) => k !== 'showPanel' && k !== 'excludeProviders')
  assert.deepEqual([...page].sort(), [...LIVE_FIELDS].sort())
})

test('every field, choice and group has its words in both languages', () => {
  const keys: string[] = GROUPS.map((g) => `cfg.g.${g}`)
  for (const f of FIELDS) {
    keys.push(`cfg.f.${f.key}`, `cfg.f.${f.key}.hint`)
    if (f.kind === 'list') keys.push(`cfg.f.${f.key}.placeholder`)
    if (f.kind === 'choice') for (const c of f.choices) keys.push(`cfg.f.${f.key}.${c}`)
  }
  for (const k of keys) {
    assert.equal(typeof (zh as Record<string, string>)[k], 'string', `zh ${k}`)
    assert.equal(typeof (en as Record<string, string>)[k], 'string', `en ${k}`)
  }
  for (const g of GROUPS) assert.ok(FIELDS.some((f) => f.group === g), g)
})

test('a form value falls back to the default when unset or of the wrong kind', () => {
  assert.equal(switchValue(undefined, true), true)
  assert.equal(switchValue(false, true), false)
  assert.equal(choiceValue('warn', ['off', 'warn'], 'off'), 'warn')
  assert.equal(choiceValue('nope', ['off', 'warn'], 'off'), 'off')
  assert.deepEqual(listValue(undefined, ['a']), ['a'])
  assert.deepEqual(listValue(['x', 1, 'y'], []), ['x', 'y'])
  assert.equal(countValue(7.9, 1, 30), 7)
  assert.equal(countValue(0, 1, 30), 30)
})

test('a list entry is trimmed, and a duplicate or an empty one is not added', () => {
  assert.deepEqual(addEntry(['Acme'], '  Zeta ', false), ['Acme', 'Zeta'])
  assert.equal(addEntry(['Acme'], '   ', false), undefined)
  assert.equal(addEntry(['Acme'], 'Acme', false), undefined)
  // words match as written; allow in any case
  assert.deepEqual(addEntry(['Acme'], 'acme', false), ['Acme', 'acme'])
  assert.equal(addEntry(['Acme'], 'ACME', true), undefined)
  assert.deepEqual(removeEntry(['a', 'b', 'c'], 'b'), ['a', 'c'])
})

test('a count is a whole number at least the minimum', () => {
  assert.equal(parseCount('14', 1), 14)
  assert.equal(parseCount(' 3 ', 1), 3)
  assert.equal(parseCount('0', 1), undefined)
  assert.equal(parseCount('1.5', 1), undefined)
  assert.equal(parseCount('', 1), undefined)
  assert.equal(parseCount('-2', 1), undefined)
})

test('the provider button names up to two, then the count', () => {
  assert.deepEqual(pickedSummary([], '、'), { kind: 'none' })
  assert.deepEqual(pickedSummary(['A', 'B'], '、'), { kind: 'some', names: 'A、B' })
  assert.deepEqual(pickedSummary(['A', 'B', 'C'], ', '), { kind: 'many', names: 'A, B', n: 3 })
})

test('a folded group says its state in words both languages have', () => {
  const all = [
    {},
    { enabled: false },
    { secrets: false, personal: false, shape: true, toolGuard: 'block' },
    { personal: true, toolGuard: 'warn', words: ['a', 'b'], allow: ['c'] },
    { record: false, vendorView: true, showPanel: true, excludeProviders: ['x', 'y'] },
  ]
  for (const value of all)
    for (const g of GROUPS)
      for (const p of groupSummary(g, value)) {
        assert.equal(typeof (zh as Record<string, string>)[p.key], 'string', `zh ${p.key}`)
        assert.equal(typeof (en as Record<string, string>)[p.key], 'string', `en ${p.key}`)
      }
})

test('a folded group’s summary follows the settings, falling back to the defaults', () => {
  const keys = (g: Parameters<typeof groupSummary>[0], v: Record<string, unknown>) => groupSummary(g, v).map((p) => p.key)
  assert.deepEqual(keys('mask', {}), ['cfg.s.secrets', 'cfg.s.toolGuard.off'])
  assert.deepEqual(groupSummary('mask', { enabled: false }), [{ key: 'cfg.s.maskOff', off: true }])
  assert.deepEqual(keys('mask', { secrets: false }), ['cfg.s.maskNothing', 'cfg.s.toolGuard.off'])
  assert.deepEqual(keys('mask', { personal: true, shape: true, toolGuard: 'warn' }), ['cfg.s.secrets', 'cfg.s.personal', 'cfg.s.shape', 'cfg.s.toolGuard.warn'])
  assert.deepEqual(groupSummary('lists', { words: ['a', 'b'] }), [
    { key: 'cfg.s.words', params: { n: 2 } },
    { key: 'cfg.s.allow', params: { n: 0 } },
  ])
  assert.deepEqual(groupSummary('record', { keepDays: 7 }), [{ key: 'cfg.s.record', params: { n: 7 } }])
  assert.deepEqual(keys('record', { record: false, vendorView: true }), ['cfg.s.recordOff', 'cfg.s.vendorView'])
  assert.deepEqual(keys('view', {}), ['cfg.s.panelOff', 'cfg.s.providersAll'])
  assert.deepEqual(groupSummary('view', { showPanel: true, excludeProviders: ['x'] }), [{ key: 'cfg.s.panel' }, { key: 'cfg.s.providersSome', params: { n: 1 } }])
})

test('two-column fields pair up, so no group leaves a half row empty', () => {
  for (const g of GROUPS) {
    let run = 0
    for (const f of FIELDS.filter((x) => x.group === g)) {
      if (f.half) run++
      else {
        assert.equal(run % 2, 0, `${g} before ${f.key}`)
        run = 0
      }
    }
    assert.equal(run % 2, 0, g)
  }
})
