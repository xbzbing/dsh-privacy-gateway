import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dayOf, MAX_RECORD_PLACES, MAX_RECORD_VALUES, RecordStore } from '../src/records.ts'

const NOW = new Date(2026, 9, 31, 12)
const value = () => ({ placeholder: '⟦DSH_REDACTED:API_KEY_aaaabbbb⟧', kind: 'API_KEY', finder: 'rule', head: 'sk-', len: 40, n: 1 })
const row = (key: number, extra: Record<string, unknown> = {}) => ({ key, time: NOW.toISOString(), what: 'chat' as const, tookMs: 1, host: 'h', n: 1, values: [value()], restored: 0, unmapped: 0, ...extra })
const store = (dir: string) => new RecordStore({ dir, keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, now: () => NOW })

async function read(rows: unknown[], check: (s: RecordStore) => void, older?: unknown[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dpg-record-audit-'))
  try {
    writeFileSync(join(dir, `${dayOf(NOW)}.jsonl`), rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n')
    if (older) writeFileSync(join(dir, '2026-10-30.jsonl'), older.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const s = store(dir)
    await s.loaded
    try {
      check(s)
    } finally {
      await s.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('malformed record values skip one entire row, not its good neighbours or another day', async () => {
  const bad = [null, 1, [], {}, { ...value(), n: -1 }, { ...value(), len: 1.5 }, { ...value(), placeholder: {} }, { ...value(), finder: [] }, { ...value(), finder: null }]
  await read([row(1), ...bad.map((v, i) => row(i + 2, { values: [value(), v] })), row(20, { n: 3 })], (s) => {
    assert.deepEqual(s.recent().map((r) => r.key), [20, 1, 21])
    assert.equal(s.stats().today.requests, 2)
    assert.equal(s.stats().today.n, 4)
    assert.equal(s.stats().month.n, 9)
    assert.equal(s.stats().month.finders.rule, 3)
  }, [row(21, { time: new Date(2026, 9, 30, 12).toISOString(), n: 5 })])
})

test('numeric and time corruption cannot poison totals or future record keys', async () => {
  const corrupt = [
    row(2, { n: -1 }), row(3, { n: 1.5 }), row(4, { n: Number.MAX_SAFE_INTEGER + 1 }),
    row(5, { time: 'not a date' }), row(6, { tookMs: -1 }), row(7, { restored: -1 }),
    row(8, { unmapped: 0.5 }), row(9, { warned: -1 }), row(10, { exfil: -1 }), row(12, { tookMs: Number.MAX_VALUE }),
    JSON.stringify(row(11)).replace('"key":11', '"key":1e400'),
    row(0), row(-1), row(1.5), row(Number.MAX_SAFE_INTEGER),
  ]
  await read([row(1), ...corrupt, row(20)], (s) => {
    assert.deepEqual(s.recent().map((r) => r.key), [20, 1])
    assert.equal(s.stats().today.n, 2)
    const { key: _key, ...input } = row(1)
    const first = s.add(input)
    const second = s.add(input)
    assert.ok(Number.isSafeInteger(first.key) && first.key > 0)
    assert.ok(Number.isSafeInteger(second.key) && second.key > first.key)
    assert.ok(!JSON.stringify([first, second]).includes('"key":null'))
  })
})

test('legacy records get safe keys and defaults; unknown finder names and recognized optional fields survive projection', async () => {
  const { finder: _finder, ...oldValue } = value()
  const legacy = { time: NOW.toISOString(), n: 1, values: [{ ...oldValue, by: 'word' }] }
  const future = row(1, {
    secret: 'synthetic-unwanted-field', model: {}, title: [], blocked: 'yes',
    values: [{ ...value(), finder: 'future-finder', secret: 'synthetic-unwanted-field', first: { turn: 3, step: 2, secret: 'synthetic-unwanted-field' }, at: { path: 'messages.1.content', role: 'user', secret: 'synthetic-unwanted-field' } }],
  })
  await read([legacy, future], (s) => {
    assert.equal(s.recent().length, 2)
    const [latest, old] = s.recent()
    assert.ok(old && Number.isSafeInteger(old.key) && old.key > 0)
    assert.equal(old.host, '')
    assert.equal(old.tookMs, 0)
    assert.equal(old.restored, 0)
    assert.equal(old.unmapped, 0)
    assert.equal(old.what, 'chat')
    assert.equal(old.values[0]?.finder, 'word')
    assert.equal(s.stats().today.finders.word, 1)
    assert.equal(latest?.values[0]?.finder, 'future-finder')
    assert.deepEqual(latest?.values[0]?.first, { turn: 3, step: 2 })
    assert.deepEqual(latest?.values[0]?.at, { path: 'messages.1.content', role: 'user' })
    assert.equal(latest?.model, undefined)
    assert.equal(latest?.blocked, undefined)
    assert.ok(!JSON.stringify(s.recent()).includes('synthetic-unwanted-field'))
  })
})

test('loaded values and places obey the write limits without losing omitted counts', async () => {
  const places = Array.from({ length: MAX_RECORD_PLACES + 3 }, (_, i) => ({ path: `messages.${i}.content` }))
  const values = Array.from({ length: MAX_RECORD_VALUES + 2 }, () => ({ ...value(), at: places[0], elsewhere: places.slice(1), elsewhereOmitted: 2 }))
  await read([row(1, { values, valuesOmitted: 3 })], (s) => {
    const r = s.recent()[0]
    assert.equal(r?.values.length, MAX_RECORD_VALUES)
    assert.equal(r?.valuesOmitted, 5)
    assert.equal(r?.values[0]?.elsewhere?.length, MAX_RECORD_PLACES - 1)
    assert.equal(r?.values[0]?.elsewhereOmitted, 5)
  })
})

test('prototype-named distributions are ordinary finite counts', async () => {
  await read([row(1, { host: '__proto__', model: 'constructor', values: [{ ...value(), kind: '__proto__', finder: 'constructor' }] })], (s) => {
    const t = s.stats().today
    assert.equal(Object.getOwnPropertyDescriptor(t.kinds, '__proto__')?.value, 1)
    assert.equal(t.finders.constructor, 1)
    assert.equal(t.models.constructor, 1)
    assert.equal(Object.getPrototypeOf(t.kinds), Object.prototype)
  })
})

test('legacy missing keys are assigned after all historical keys without collisions', async () => {
  const { key: _key, ...legacy } = row(1)
  await read([legacy, row(2)], (s) => {
    const keys = s.recent().map((r) => r.key)
    assert.equal(new Set(keys).size, 3)
    assert.equal(keys[0], 2)
    assert.ok((keys[1] ?? 0) > 50)
    assert.equal(keys[2], 50)
  }, [row(50, { time: new Date(2026, 9, 30, 12).toISOString() })])
})

test('raw session lookup stays private, while normal persisted ids keep their exact lookup semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpg-record-session-audit-'))
  const s = store(dir)
  const raw = 'sk-proj-' + 'sourceSessionSENTINEL0123456789abcd'
  try {
    await s.loaded
    const { key: _key, ...input } = row(1)
    s.add({ ...input, session: 'safe-audit-session' }, raw)
    s.add({ ...input, session: 'sess-1:worker', n: 2 }, 'sess-1:worker')
    assert.equal(s.recent(50, raw).length, 1)
    assert.equal(s.stats(raw).today.n, 1)
    assert.equal(s.recent(50, 'sess-1:worker')[0]?.session, 'sess-1:worker')
    await s.flush()
    assert.ok(!readFileSync(join(dir, `${dayOf(NOW)}.jsonl`), 'utf8').includes(raw))
    assert.ok(!JSON.stringify(s.recent()).includes(raw))
    const restarted = store(dir)
    await restarted.loaded
    assert.equal(restarted.recent(50, 'sess-1:worker').length, 1)
    assert.equal(restarted.stats('sess-1:worker').today.n, 2)
    // Only safe metadata persists: an abnormal sensitive id loses its private raw alias on restart.
    assert.equal(restarted.recent(50, raw).length, 0)
    assert.equal(restarted.recent(50, 'safe-audit-session').length, 1)
    await restarted.close()
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicate keys keep the first valid row read across both same-day and older-day files', async () => {
  const yesterday = new Date(2026, 9, 30, 12).toISOString()
  const { key: _key, ...legacy } = row(1)
  await read([row(7, { values: [null] }), row(7, { n: 1 }), row(7, { n: 2 }), row(8, { n: 3 }), legacy], (s) => {
    const keys = s.recent().map((r) => r.key)
    assert.equal(new Set(keys).size, 4)
    assert.equal(keys.filter((key) => key === 7).length, 1)
    assert.equal(keys.filter((key) => key === 8).length, 1)
    assert.equal(s.stats().today.requests, 3)
    assert.equal(s.stats().today.n, 5)
    assert.equal(s.stats().month.requests, 4)
    assert.equal(s.stats().month.n, 10)
    assert.equal(s.recent().find((r) => r.key === 7)?.n, 1, 'invalid rows cannot reserve keys')
    assert.equal(s.recent().find((r) => r.key === 8)?.n, 3, 'newer days are read before older days')
  }, [row(7, { time: yesterday, n: 20 }), row(8, { time: yesterday, n: 30 }), row(9, { time: yesterday, n: 5 }), row(9, { time: yesterday, n: 50 })])
})

test('duplicate disk keys never count records added while loading twice, and keyless legacy rows stay unique', async () => {
  const { RecordStore: IsolatedStore } = await import(new URL('../src/records.ts?loading-duplicates', import.meta.url).href) as typeof import('../src/records.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dpg-record-loading-duplicates-'))
  const liveKey = NOW.getTime() * 1000
  const { key: _key, ...input } = row(1)
  writeFileSync(join(dir, `${dayOf(NOW)}.jsonl`), [row(liveKey, { n: 10 }), row(liveKey, { n: 20 }), row(7), row(7, { n: 2 }), input].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const s = new IsolatedStore({ dir, keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, now: () => NOW })
  try {
    assert.equal(s.add({ ...input, n: 5 }).key, liveKey)
    await s.loaded
    assert.equal(s.stats().today.requests, 3)
    assert.equal(s.stats().today.n, 7)
    const keys = s.recent().map((r) => r.key)
    assert.equal(new Set(keys).size, 3)
    assert.equal(keys.filter((key) => key === liveKey).length, 1)
    assert.equal(keys.filter((key) => key === 7).length, 1)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the allocator never repeats or emits unsafe keys at the integer endpoint', async () => {
  // An isolated module keeps this deliberate exhaustion from changing other tests' process allocator.
  const { RecordStore: IsolatedStore } = await import(new URL('../src/records.ts?allocator-edge', import.meta.url).href) as typeof import('../src/records.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dpg-record-key-edge-'))
  writeFileSync(join(dir, `${dayOf(NOW)}.jsonl`), JSON.stringify(row(Number.MAX_SAFE_INTEGER - 2)) + '\n')
  const s = new IsolatedStore({ dir, keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, now: () => NOW })
  try {
    await s.loaded
    const { key: _key, ...input } = row(1)
    assert.equal(s.add(input).key, Number.MAX_SAFE_INTEGER - 1)
    assert.throws(() => s.add(input), /record key space exhausted/)
    assert.equal(s.recent().length, 2)
    await s.flush()
    const restarted = new IsolatedStore({ dir, keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, now: () => NOW })
    await restarted.loaded
    assert.deepEqual(restarted.recent().map((r) => r.key), [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 2])
    assert.equal(restarted.stats().today.requests, 2)
    assert.throws(() => restarted.add(input), /record key space exhausted/)
    await restarted.close()
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
