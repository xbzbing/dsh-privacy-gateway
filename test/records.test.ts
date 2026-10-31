import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { dayOf, RecordStore, whatOf, type MaskRecord } from '../src/records.ts'

const SENTINEL = 'sk-' + 'proj-SENTINELsentinel0123456789abcd'
const chat = (content: string) => JSON.stringify({ model: 'gpt-x', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dpg-rec-'))
}

function store(dir: string | undefined, now = () => new Date(), extra: Partial<ConstructorParameters<typeof RecordStore>[0]> = {}) {
  return new RecordStore({ ...(dir ? { dir } : {}), keepDays: 30, keepBytes: 100 << 20, keepRecords: 500, flushDelayMs: 0, now, ...extra })
}

function record(time: Date, over: Partial<MaskRecord> = {}): Omit<MaskRecord, 'key'> {
  return { time: time.toISOString(), tookMs: 1, what: 'chat', host: 'h', n: 1, values: [{ placeholder: '{{API_KEY_aaaabbbb}}', kind: 'API_KEY', finder: 'rule', head: 'sk-', len: 40, n: 1 }], restored: 0, unmapped: 0, ...over }
}

test('one request makes one record: its values, the places restored and the placeholders unmapped, never the value', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const ex = engine.maskRequest(chat(`key ${SENTINEL} and again ${SENTINEL}`), { ...info, session: 's1' })
  assert.ok(ex)
  const p = /\{\{API_KEY_[a-z2-7]{8}\}\}/.exec(ex.text)?.[0] ?? ''
  const reply = JSON.stringify({ choices: [{ message: { content: `${p} ${p} {{API_KEY_zzzzzzzz}}` } }] })
  assert.ok(ex.restoreBody(reply).includes(SENTINEL))
  ex.finish()
  ex.finish()
  const recs = engine.records.recent()
  assert.equal(recs.length, 1)
  const r = recs[0] as MaskRecord
  assert.equal(r.n, 2)
  assert.equal(r.model, 'gpt-x')
  assert.equal(r.session, 's1')
  assert.equal(r.host, 'api.example.com')
  assert.equal(r.what, 'chat')
  // the hint keeps the prefix and the 4 characters after it, and the last 2 (docs/adr/0019)
  assert.deepEqual(r.values, [{ placeholder: p, kind: 'API_KEY', finder: 'rule', head: 'sk-proj-SENT', tail: 'cd', len: SENTINEL.length, n: 2 }])
  assert.equal(r.restored, 2)
  assert.equal(r.unmapped, 1)
  assert.ok(!JSON.stringify(r).includes(SENTINEL))
  assert.ok(!JSON.stringify(engine.records.stats()).includes(SENTINEL))
})

test('a request that is no model request, or goes while masking is off, makes no record', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  assert.equal(engine.maskRequest('{"hello":1}', info), null)
  engine.active = false
  assert.equal(engine.maskRequest(chat(SENTINEL), info), null)
  assert.equal(engine.records.recent().length, 0)
})

test('a model request with nothing masked and nothing put back makes no record; one whose reply puts a value back does', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const first = engine.maskRequest(chat(`key ${SENTINEL}`), info)
  assert.ok(first)
  const p = /\{\{API_KEY_[a-z2-7]{8}\}\}/.exec(first.text)?.[0] ?? ''
  first.finish()
  const plain = engine.maskRequest(chat('hello'), info)
  assert.ok(plain)
  plain.restoreBody(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
  plain.finish()
  assert.equal(engine.records.recent().length, 1)
  const echo = engine.maskRequest(chat('again'), info)
  assert.ok(echo)
  echo.restoreBody(JSON.stringify({ choices: [{ message: { content: p } }] }))
  echo.finish()
  const recs = engine.records.recent()
  assert.equal(recs.length, 2)
  assert.equal(recs[0]?.n, 0)
  assert.equal(recs[0]?.restored, 1)
})

test('what a request is goes by its path', () => {
  assert.equal(whatOf('/v1/chat/completions'), 'chat')
  assert.equal(whatOf('/v1/messages/count_tokens'), 'count')
  assert.equal(whatOf('/v1beta/models/gemini:countTokens'), 'count')
  assert.equal(whatOf('/v1/embeddings'), 'embeddings')
  assert.equal(whatOf('/v1/search'), 'search')
})

test('records go to a 0600 file a day in a 0700 directory, one JSON line each, with no value in them', async () => {
  const root = tmp()
  const dir = join(root, 'masking')
  try {
    const engine = new PrivacyEngine(randomBytes(32), defaults, { records: store(dir) })
    engine.maskRequest(chat(`key ${SENTINEL}`), info)?.finish()
    engine.maskRequest(chat('nothing here'), info)?.finish()
    await engine.records.flush()
    const files = readdirSync(dir)
    assert.deepEqual(files, [`${dayOf(new Date())}.jsonl`])
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    const file = join(dir, files[0] as string)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes(SENTINEL))
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as MaskRecord)
    assert.deepEqual(lines.map((l) => l.n), [1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new day goes to a new file, and the sums tell today, 7 days and 30 days apart', async () => {
  const dir = tmp()
  let now = new Date(2026, 9, 1, 12)
  try {
    const s = store(dir, () => now)
    s.add(record(new Date(2026, 8, 10, 12), { n: 4 })) // 21 days before
    s.add(record(new Date(2026, 8, 28, 12), { n: 2 })) // 3 days before
    s.add(record(now, { n: 1 }))
    now = new Date(2026, 9, 2, 9)
    s.add(record(now, { n: 1, failed: true }))
    await s.flush()
    assert.deepEqual(readdirSync(dir).sort(), ['2026-09-10.jsonl', '2026-09-28.jsonl', '2026-10-01.jsonl', '2026-10-02.jsonl'])
    const st = s.stats()
    assert.equal(st.today.requests, 1)
    assert.equal(st.today.failed, 1)
    assert.equal(st.week.n, 4)
    assert.equal(st.month.n, 8)
    assert.equal(st.month.kinds.API_KEY, 4)
    assert.equal(st.month.finders.rule, 4)
    assert.equal(st.failStreak, 1)
    s.add(record(now))
    assert.equal(s.stats().failStreak, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning drops days past keepDays, then the oldest past keepBytes, never today', async () => {
  const dir = tmp()
  const now = new Date(2026, 9, 31, 12)
  try {
    writeFileSync(join(dir, '2026-08-01.jsonl'), 'x\n')
    writeFileSync(join(dir, '2026-10-20.jsonl'), 'x'.repeat(600))
    writeFileSync(join(dir, '2026-10-25.jsonl'), 'x'.repeat(600))
    writeFileSync(join(dir, '2026-10-31.jsonl'), 'x'.repeat(600))
    writeFileSync(join(dir, 'notes.txt'), 'kept')
    const s = store(dir, () => now, { keepBytes: 1000 })
    await s.loaded
    await s.prune()
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-31.jsonl', 'notes.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a store reads back the days on disk into its sums and its latest records, without counting twice', async () => {
  const dir = tmp()
  try {
    const a = store(dir)
    a.add(record(new Date(), { n: 3 }))
    a.add(record(new Date(), { n: 5 }))
    await a.flush()
    const b = store(dir)
    b.add(record(new Date(), { n: 7 }))
    await b.loaded
    await b.flush()
    assert.equal(b.stats().today.n, 15)
    assert.deepEqual(b.recent().map((r) => r.n), [7, 5, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory keeps keepRecords records, the newest first', () => {
  const s = store(undefined, () => new Date(), { keepRecords: 10 })
  for (let i = 0; i < 25; i++) s.add(record(new Date(), { n: i }))
  const recent = s.recent()
  assert.equal(recent.length, 10)
  assert.equal(recent[0]?.n, 24)
  assert.equal(s.stats().today.requests, 25)
})

test('a write that fails is told once and the request still gets its reply (best-effort)', async () => {
  const root = tmp()
  const blocker = join(root, 'file')
  writeFileSync(blocker, '')
  const warnings: unknown[][] = []
  const records = store(join(blocker, 'masking'), () => new Date(), { logger: { warn: (...a: unknown[]) => warnings.push(a) } })
  const engine = new PrivacyEngine(randomBytes(32), defaults, { records })
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const before = getGlobalDispatcher()
  const gateway = installGateway(engine, { checkIntervalMs: 0 })
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    for (let i = 0; i < 2; i++) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': 'sess-9' }, body: chat(`key ${SENTINEL}`) })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), '{"choices":[{"message":{"content":"ok"}}]}')
      await records.flush()
    }
    assert.equal(warnings.length, 1)
    const [r] = records.recent()
    assert.equal(r?.session, 'sess-9')
    assert.equal(r?.relay, true)
    assert.equal(records.stats().today.requests, 2)
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('record turned on writes from then on and reads the days on disk once; turned off writes nothing more', async () => {
  const dir = tmp()
  try {
    const a = store(dir)
    a.add(record(new Date(), { n: 3 }))
    await a.flush()
    // a store that started with record off, then had it turned on twice
    const b = store(undefined)
    b.add(record(new Date(), { n: 7 }))
    b.configure({ dir, keepDays: 30 })
    await b.loaded
    b.configure({ keepDays: 30 })
    b.configure({ dir, keepDays: 30 })
    await b.loaded
    assert.equal(b.stats().today.n, 10)
    b.add(record(new Date(), { n: 11 }))
    await b.flush()
    b.configure({ keepDays: 30 })
    b.add(record(new Date(), { n: 13 }))
    await b.flush()
    const lines = readFileSync(join(dir, `${dayOf(new Date())}.jsonl`), 'utf8').trim().split('\n')
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as MaskRecord).n), [3, 11])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
