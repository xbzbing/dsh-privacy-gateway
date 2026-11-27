import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QueryEngine, type QueryReply } from '../src/query.ts'
import { dayOf, RecordStore, type MaskRecord } from '../src/records.ts'

const DAY = dayOf(new Date())
const TO = dayOf(new Date(Date.now() + 24 * 3600 * 1000))

function store(dir: string, keepRecords = 2): RecordStore {
  return new RecordStore({ dir, keepDays: 30, keepBytes: 1024 * 1024, keepRecords })
}

/** One record as the engine would write it; `over` carries what a test cares about. */
function row(over: Partial<Omit<MaskRecord, 'key'>> = {}): Omit<MaskRecord, 'key'> {
  return {
    time: new Date().toISOString(),
    tookMs: 1,
    what: 'chat',
    host: 'api.example.com',
    n: 1,
    values: [],
    restored: 0,
    unmapped: 0,
    ...over,
  }
}

function engine(s: RecordStore, over: Partial<ConstructorParameters<typeof QueryEngine>[0]> = {}): QueryEngine {
  return new QueryEngine({ store: s, sliceMs: 1000, ttlMs: 60_000, ...over })
}

/** Asks for the next slice until the scan is done. */
async function drain(q: QueryEngine, reply: QueryReply): Promise<QueryReply> {
  let guard = 0
  while (reply.status === 'paused' && reply.canResume && guard++ < 500) {
    reply = await run(q, { mode: 'resume', queryId: reply.queryId })
  }
  return reply
}

/** The last answer, whatever it was. */
async function run(q: QueryEngine, mode: Record<string, unknown>): Promise<QueryReply> {
  return q.run(mode as never)
}

test('a query reaches a record the memory no longer holds, and counts its unknown placeholders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    const s = store(dir, 1)
    s.add(row({ unmapped: 2 }))
    s.add(row())
    s.add(row())
    await s.flush()
    const q = engine(s)
    const reply = await run(q, { mode: 'start', from: DAY, to: TO, event: 'unmapped' })
    assert.ok(reply.status === 'ready' || reply.status === 'partial', JSON.stringify(reply))
    if (reply.status === 'ready' || reply.status === 'partial') {
      assert.equal(reply.page.matchedRequests, 1)
      assert.equal(reply.page.unmappedOccurrences, 2)
      assert.equal(reply.page.coverage.scan, 'ready')
      assert.equal(reply.page.items[0]?.unmapped, 2)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a query answers a page at a time and a cursor does not skip a row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    const s = store(dir, 10)
    for (let i = 0; i < 5; i++) s.add(row({ title: `t${i}` }))
    await s.flush()
    const q = engine(s)
    const first = await run(q, { mode: 'start', from: DAY, to: TO, event: 'all', limit: 2 })
    assert.ok(first.status === 'ready' || first.status === 'partial')
    if (first.status !== 'ready' && first.status !== 'partial') return
    assert.equal(first.page.items.length, 2)
    const cursor = first.page.nextCursor
    assert.ok(cursor)
    const second = await run(q, { mode: 'page', cursor })
    assert.ok(second.status === 'ready' || second.status === 'partial')
    if (second.status !== 'ready' && second.status !== 'partial') return
    assert.equal(second.page.items.length, 2)
    const refs = new Set([...first.page.items, ...second.page.items].map((r) => r.ref))
    assert.equal(refs.size, 4, 'the two pages must not repeat a row')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scan that runs out of its slice keeps its place and goes on when asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    const s = store(dir, 50)
    for (let i = 0; i < 30; i++) s.add(row({ title: `t${i}` }))
    await s.flush()
    // a slice of no time at all: every line is a slice of its own
    const q = engine(s, { sliceMs: 0 })
    const started = await run(q, { mode: 'start', from: DAY, to: TO, event: 'all' })
    assert.equal(started.status, 'paused', 'a slice of no time leaves the scan for the reader')
    const reply = await drain(q, started)
    assert.ok(reply.status === 'ready' || reply.status === 'partial', JSON.stringify(reply))
    if (reply.status !== 'ready' && reply.status !== 'partial') return
    assert.equal(reply.page.matchedRequests, 30, 'resuming must not count a row twice')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a published page is frozen while the scan goes on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    const s = store(dir, 50)
    for (let i = 0; i < 20; i++) s.add(row({ title: `t${i}` }))
    await s.flush()
    const q = engine(s, { sliceMs: 0 })
    const asked = await run(q, { mode: 'start', from: DAY, to: TO, event: 'all', limit: 5 })
    assert.ok(asked.status === 'paused', JSON.stringify(asked))
    if (asked.status !== 'paused') return
    const part = await run(q, { mode: 'partial', queryId: asked.queryId })
    assert.ok(part.status === 'partial')
    if (part.status !== 'partial') return
    const held = part.page.snapshotId
    const count = part.page.items.length
    // the build goes on, but the page already handed out keeps its rows
    const reply = await drain(q, asked)
    assert.ok(reply.status === 'ready' || reply.status === 'partial')
    if (reply.status !== 'ready' && reply.status !== 'partial') return
    assert.notEqual(reply.page.snapshotId, held, 'a finished scan is a new snapshot')
    const again = await run(q, { mode: 'page', cursor: '' })
    assert.ok(again.status === 'error', 'an empty cursor is refused')
    const kept = await q.detail(part.page.items[0]?.ref ?? '')
    assert.ok('row' in kept, 'the frozen page still answers for its rows')
    assert.ok(count > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rewritten line answers SNAPSHOT_INVALIDATED rather than another row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    // nothing kept in memory: the row is only on disk, so a rewrite is the
    // only thing that can answer for it
    const s = store(dir, 0)
    s.add(row({ title: 'first' }))
    await s.flush()
    const q = engine(s)
    const reply = await run(q, { mode: 'start', from: DAY, to: TO, event: 'all' })
    assert.ok(reply.status === 'ready' || reply.status === 'partial')
    if (reply.status !== 'ready' && reply.status !== 'partial') return
    const ref = reply.page.items[0]?.ref ?? ''
    const file = join(dir, `${DAY}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
    // the same length, another row: a byte-level check would not notice
    writeFileSync(file, lines.map((l) => l.replace('first', 'secon')).join('\n') + '\n')
    const found = await q.detail(ref)
    assert.ok('code' in found, 'a changed line must not answer for the old row')
    assert.equal(found.code, 'SNAPSHOT_INVALIDATED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mode that names the wrong fields is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgw-query-'))
  try {
    const q = engine(store(dir))
    for (const mode of [
      { mode: 'start', from: '2026-13-01', to: TO, event: 'all' },
      { mode: 'start', from: DAY, to: TO, event: 'everything' },
      { mode: 'start', from: TO, to: DAY, event: 'all' },
      { mode: 'page', cursor: '' },
      { mode: 'resume' },
      { mode: 'nonsense' },
    ]) {
      const reply = await run(q, mode)
      assert.equal(reply.status, 'error', JSON.stringify(mode))
    }
    const missing = await run(q, { mode: 'poll', queryId: 'nope' })
    assert.equal(missing.status, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})