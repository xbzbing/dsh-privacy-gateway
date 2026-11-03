import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway } from '../src/dispatcher.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { CONTEXT_CHARS } from '../src/redact/mask.ts'
import { dayOf, MAX_RECORD_PLACES, MAX_RECORD_VALUES, RecordStore, whatOf, type MaskRecord, type ValueRecord } from '../src/records.ts'

const SENTINEL = 'sk-' + 'proj-SENTINELsentinel0123456789abcd'
const chat = (content: string) => JSON.stringify({ model: 'gpt-x', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dpg-rec-'))
}

/** A fixed clock at local noon: no test depends on the day it runs on, or crosses midnight. */
const NOON = new Date(2026, 9, 31, 12)
const atNoon = () => NOON

function store(dir: string | undefined, now = atNoon, extra: Partial<ConstructorParameters<typeof RecordStore>[0]> = {}) {
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
  // the context is cut from the text as it went: the value's other place is its placeholder (docs/adr/0024)
  assert.deepEqual(r.values, [
    { placeholder: p, kind: 'API_KEY', finder: 'rule', head: 'sk-proj-SENT', tail: 'cd', len: SENTINEL.length, n: 2, before: 'key ', after: ` and again ${p}`, at: { path: 'messages.0.content', role: 'user' } },
  ])
  assert.equal(r.restored, 2)
  assert.equal(r.unmapped, 1)
  assert.ok(!JSON.stringify(r).includes(SENTINEL))
  assert.ok(!JSON.stringify(engine.records.stats()).includes(SENTINEL))
})

test('a value says where it was first sent, once a later step sends it again', () => {
  let at = { turn: 3, step: 1 }
  const engine = new PrivacyEngine(randomBytes(32), defaults, { steps: () => at })
  const body = chat(`key ${SENTINEL}`)
  const send = (session: string): void => {
    const ex = engine.maskRequest(body, { ...info, session })
    assert.ok(ex)
    ex.finish()
  }
  send('s1')
  at = { turn: 3, step: 2 }
  send('s1')
  const [second, first] = engine.records.recent()
  assert.equal(first?.turn, 3)
  assert.equal(first?.step, 1)
  // the request that sends it first needs no line of its own
  assert.equal(first?.values[0]?.first, undefined)
  assert.equal(second?.step, 2)
  assert.deepEqual(second?.values[0]?.first, { turn: 3, step: 1 })
  // every session has its own first sending
  at = { turn: 9, step: 4 }
  send('s2')
  assert.equal(engine.records.recent()[0]?.values[0]?.first, undefined)
  // a request outside a step names none at all
  const bare = engine.maskRequest(body, info)
  assert.ok(bare)
  bare.finish()
  const last = engine.records.recent()[0]
  assert.equal(last?.turn, undefined)
  assert.equal(last?.values[0]?.first, undefined)
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
    // the engine stamps the record with the real time: the file is named by that record's local day
    const [written] = engine.records.recent()
    assert.ok(written)
    assert.deepEqual(files, [`${dayOf(new Date(written.time))}.jsonl`])
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
    a.add(record(NOON, { n: 3 }))
    a.add(record(NOON, { n: 5 }))
    await a.flush()
    const b = store(dir)
    b.add(record(NOON, { n: 7 }))
    await b.loaded
    await b.flush()
    assert.equal(b.stats().today.n, 15)
    assert.deepEqual(b.recent().map((r) => r.n), [7, 5, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory keeps keepRecords records, the newest first', () => {
  const s = store(undefined, atNoon, { keepRecords: 10 })
  for (let i = 0; i < 25; i++) s.add(record(NOON, { n: i }))
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
    // the read of the directory fails too, and is told on its own
    assert.equal(warnings.filter((w) => String(w[0]).includes('could not write')).length, 1)
    const [r] = records.recent()
    assert.equal(r?.session, 'sess-9')
    assert.equal(r?.relay, true)
    // the engine stamps records with the real time: the 30 days hold them whichever day the test runs on
    assert.equal(records.stats().month.requests, 2)
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
    a.add(record(NOON, { n: 3 }))
    await a.flush()
    // a store that started with record off, then had it turned on twice
    const b = store(undefined)
    b.add(record(NOON, { n: 7 }))
    b.configure({ dir, keepDays: 30 })
    await b.loaded
    b.configure({ keepDays: 30 })
    b.configure({ dir, keepDays: 30 })
    await b.loaded
    assert.equal(b.stats().today.n, 10)
    b.add(record(NOON, { n: 11 }))
    await b.flush()
    b.configure({ keepDays: 30 })
    b.add(record(NOON, { n: 13 }))
    await b.flush()
    const lines = readFileSync(join(dir, `${dayOf(NOON)}.jsonl`), 'utf8').trim().split('\n')
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as MaskRecord).n), [3, 11])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset clears memory, the sums and every day file, and leaves other files', async () => {
  const dir = tmp()
  try {
    const a = store(dir)
    a.add(record(NOON, { n: 3 }))
    a.add(record(new Date(2026, 9, 29, 12), { n: 5 }))
    await a.flush()
    writeFileSync(join(dir, 'notes.txt'), 'keep me')
    a.add(record(NOON, { n: 7 }))
    const r = await a.reset()
    assert.ok(r.files >= 1)
    assert.equal(a.recent().length, 0)
    assert.equal(a.stats().month.n, 0)
    assert.deepEqual(readdirSync(dir), ['notes.txt'])
    // what comes after is kept and written as before
    a.add(record(NOON, { n: 11 }))
    await a.flush()
    assert.equal(a.stats().today.n, 11)
    // a store with writing off clears the directory it is given
    const off = store(undefined)
    assert.equal((await off.reset(dir)).files, 1)
    assert.deepEqual(readdirSync(dir), ['notes.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the context around a value is short, flat, and never holds a value, a warned one included', () => {
  const warn = new PrivacyEngine(randomBytes(32), { ...defaults, personal: true, actions: { EMAIL: 'warn' } })
  const long = 'x'.repeat(200)
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: `${long}\n\n  key ${SENTINEL} mail zhang.wei.private@baidu.com ${long}` }] })
  const ex = warn.maskRequest(body, info)
  assert.ok(ex)
  ex.finish()
  const r = warn.records.recent()[0] as MaskRecord
  const key = r.values.find((v) => v.kind === 'API_KEY')
  assert.ok(key)
  const before = key.before ?? ''
  const after = key.after ?? ''
  assert.ok(before.startsWith('…') && before.endsWith(' key '), before)
  assert.ok(!before.includes('\n'))
  assert.ok(after.endsWith('…'))
  assert.ok([...before].length <= CONTEXT_CHARS + 1)
  assert.deepEqual(key.at, { path: 'messages.1.content', role: 'user' })
  // the warned email went as written, but the context shows its placeholder
  assert.ok(after.includes('{{EMAIL_'), after)
  assert.ok(!JSON.stringify(r).includes('zhang.wei.private'), JSON.stringify(r.values))
  assert.ok(!JSON.stringify(r).includes(SENTINEL))
})

test('recordContext off keeps no context', () => {
  const engine = new PrivacyEngine(randomBytes(32), { ...defaults, recordContext: false })
  const messages = [
    { role: 'user', content: `key ${SENTINEL}` },
    { role: 'assistant', content: `saw ${SENTINEL}` },
  ]
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages }), info)
  assert.ok(ex)
  ex.finish()
  const v = (engine.records.recent()[0] as MaskRecord).values[0]
  assert.equal(v?.before, undefined)
  assert.equal(v?.at, undefined)
  // the places hang off the same switch: nothing of them is kept either (docs/adr/0028)
  assert.equal(v?.elsewhere, undefined)
  assert.equal(v?.elsewhereOmitted, undefined)
})

test('a secret used as a JSON key is masked in the body and never named in the record', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const messages = [{ role: 'user', content: `key ${SENTINEL}` }]
  const body = JSON.stringify({ model: 'm', messages, metadata: { [SENTINEL]: { note: `again ${SENTINEL}` } } })
  const ex = engine.maskRequest(body, info)
  assert.ok(ex)
  // the key went as a placeholder, and the value inside it names the placeholder in its path
  assert.ok(!ex.text.includes(SENTINEL), ex.text)
  ex.finish()
  const r = engine.records.recent()[0] as MaskRecord
  const json = JSON.stringify(r)
  assert.ok(!json.includes(SENTINEL), json)
  // the key was a place too: messages.0.content, metadata.<placeholder> and its note
  assert.equal(r.n, 3)
  const v = r.values[0] as ValueRecord
  assert.equal(v.n, 3)
  const places = [v.at, ...(v.elsewhere ?? [])].map((p) => p?.path ?? '')
  assert.deepEqual(places.filter((p) => p.startsWith('metadata.')).length, 2)
  assert.ok(!places.some((p) => p.includes('sk-')), places.join(' '))
})

test('a value in more than one message keeps every place, the first still the one its context came from', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: `key ${SENTINEL}` },
    { role: 'assistant', content: `saw ${SENTINEL}` },
  ]
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages }), info)
  assert.ok(ex)
  ex.finish()
  const v = (engine.records.recent()[0] as MaskRecord).values[0] as ValueRecord
  assert.equal(v.n, 2)
  assert.deepEqual(v.at, { path: 'messages.1.content', role: 'user' })
  assert.deepEqual(v.elsewhere, [{ path: 'messages.2.content', role: 'assistant' }])
  assert.equal(v.elsewhereOmitted, undefined)
  // a value met in one place only is recorded as it was before the field existed (docs/adr/0028)
  const single = new PrivacyEngine(randomBytes(32), defaults)
  const one = single.maskRequest(chat(`key ${SENTINEL}`), info)
  assert.ok(one)
  one.finish()
  assert.equal('elsewhere' in ((single.records.recent()[0] as MaskRecord).values[0] as ValueRecord), false)
  assert.ok(!JSON.stringify(v).includes(SENTINEL))
})

test('the places one value keeps are capped, the ones past it counted once each', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `key ${SENTINEL}` }))
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages }), info)
  assert.ok(ex)
  ex.finish()
  const r = engine.records.recent()[0] as MaskRecord
  const v = r.values[0] as ValueRecord
  assert.equal(v.n, 12)
  assert.equal((v.elsewhere ?? []).length, MAX_RECORD_PLACES - 1)
  assert.equal(v.elsewhereOmitted, 12 - MAX_RECORD_PLACES)
  assert.equal(v.elsewhere?.[0]?.path, 'messages.1.content')
  assert.ok(!JSON.stringify(r).includes(SENTINEL))
})

test('a place left out is counted once, however often the value is met there', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  // the last message is past the cap and holds the value three times: one place, not three
  const messages = Array.from({ length: MAX_RECORD_PLACES }, (_, i) => ({ role: 'user', content: `key ${SENTINEL}` }))
  messages.push({ role: 'user', content: `key ${SENTINEL} and ${SENTINEL} and ${SENTINEL}` })
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages }), info)
  assert.ok(ex)
  ex.finish()
  const v = (engine.records.recent()[0] as MaskRecord).values[0] as ValueRecord
  assert.equal(v.n, MAX_RECORD_PLACES + 3)
  assert.equal((v.elsewhere ?? []).length, MAX_RECORD_PLACES - 1)
  assert.equal(v.elsewhereOmitted, 1)
})

test('the same place met twice is kept once and is no place left out', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const messages = [
    { role: 'user', content: `key ${SENTINEL}` },
    { role: 'assistant', content: `again ${SENTINEL} and ${SENTINEL}` },
  ]
  const ex = engine.maskRequest(JSON.stringify({ model: 'm', messages }), info)
  assert.ok(ex)
  ex.finish()
  const v = (engine.records.recent()[0] as MaskRecord).values[0] as ValueRecord
  assert.equal(v.n, 3)
  assert.deepEqual(v.elsewhere, [{ path: 'messages.1.content', role: 'assistant' }])
  assert.equal(v.elsewhereOmitted, undefined)
})

/** The records in a day file, in the order written. */
function linesOf(file: string): MaskRecord[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as MaskRecord)
}

test('a session’s sums go by the local day, as the day sums do', () => {
  const saved = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    // 03:00 in Shanghai is still the day before in UTC
    const now = new Date(2026, 9, 31, 3)
    assert.equal(now.toISOString().slice(0, 10), '2026-10-30')
    const s = store(undefined, () => now)
    s.add(record(now, { session: 's1', n: 2 }))
    assert.equal(s.stats('s1').today.n, 2)
    assert.equal(s.stats().today.n, 2)
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
})

test('a line a crash cut short does not swallow the next record', async () => {
  const dir = tmp()
  try {
    const file = join(dir, `${dayOf(NOON)}.jsonl`)
    const whole = JSON.stringify({ key: 1, ...record(NOON, { n: 2 }) })
    writeFileSync(file, `${whole}\n\n${whole.slice(0, 40)}`)
    const a = store(dir)
    await a.loaded
    a.add(record(NOON, { n: 5 }))
    await a.flush()
    // the half line is ended, and the next run reads the record after it
    assert.ok(readFileSync(file, 'utf8').includes(`${whole.slice(0, 40)}\n{`))
    const b = store(dir)
    await b.loaded
    assert.deepEqual(b.recent().map((r) => r.n), [5, 2])
    assert.equal(b.stats().today.n, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record added while a reset runs is in memory exactly when it is on disk', async () => {
  const dir = tmp()
  try {
    const s = store(dir)
    for (let i = 0; i < 5; i++) s.add(record(NOON))
    await s.flush()
    // a write still going when the reset starts, and records added all through it
    s.add(record(NOON))
    void s.flush()
    let done = false
    const resetting = s.reset().then((r) => {
      done = true
      return r
    })
    for (let i = 0; !done && i < 1000; i++) {
      s.add(record(NOON))
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal((await resetting).files, 1)
    s.add(record(NOON))
    await s.flush()
    const inMemory = s.recent().map((r) => r.key).reverse()
    assert.deepEqual(linesOf(join(dir, `${dayOf(NOON)}.jsonl`)).map((r) => r.key), inMemory)
    assert.equal(s.stats().today.requests, inMemory.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record keeps at most MAX_RECORD_VALUES values and counts the ones left out', () => {
  const values: ValueRecord[] = Array.from({ length: MAX_RECORD_VALUES + 50 }, (_, i) => ({ placeholder: `{{API_KEY_${String(i).padStart(8, 'a')}}}`, kind: 'API_KEY', finder: 'rule', head: 'sk-', len: 40, n: 1 }))
  const r = store(undefined).add(record(NOON, { n: values.length, values }))
  assert.equal(r.values.length, MAX_RECORD_VALUES)
  assert.equal(r.valuesOmitted, 50)
  assert.equal(r.n, MAX_RECORD_VALUES + 50)
})

test('a day file stops at keepBytes, today’s too, told once; memory still counts every record', async () => {
  const dir = tmp()
  const warnings: unknown[][] = []
  try {
    const s = store(dir, atNoon, { keepBytes: 2000, logger: { warn: (...a: unknown[]) => warnings.push(a) } })
    for (let i = 0; i < 20; i++) {
      s.add(record(NOON))
      if (i % 5 === 4) await s.flush()
    }
    await s.flush()
    const file = join(dir, `${dayOf(NOON)}.jsonl`)
    assert.ok(statSync(file).size <= 2000)
    assert.ok(linesOf(file).length > 0)
    assert.equal(warnings.filter((w) => String(w[0]).includes('keepMegabytes')).length, 1)
    assert.equal(s.stats().today.requests, 20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a prune that fails is told as such and the records are still written', async () => {
  const dir = tmp()
  const warnings: unknown[][] = []
  try {
    // a directory where an old day file would be cannot be unlinked
    mkdirSync(join(dir, '2020-01-01.jsonl'))
    const s = store(dir, atNoon, { logger: { warn: (...a: unknown[]) => warnings.push(a) } })
    s.add(record(NOON, { n: 3 }))
    await s.flush()
    assert.deepEqual(linesOf(join(dir, `${dayOf(NOON)}.jsonl`)).map((r) => r.n), [3])
    assert.deepEqual(warnings.map((w) => String(w[0])), ['dsh-privacy-gateway: could not delete old record files; records are still written'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records written under a clock ahead of this one are read back, and the keys after go past them', async () => {
  const dir = tmp()
  try {
    // a previous run whose clock was a year ahead
    const key = (Date.now() + 365 * 86400_000) * 1000
    writeFileSync(join(dir, `${dayOf(NOON)}.jsonl`), JSON.stringify({ key, ...record(NOON, { n: 3 }) }) + '\n')
    const s = store(dir)
    await s.loaded
    assert.equal(s.stats().today.n, 3)
    const r = s.add(record(NOON, { n: 1 }))
    assert.ok(r.key > key)
    assert.deepEqual(s.recent().map((x) => x.n), [1, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning to fewer days drops them from the sums and the latest records, as a restart would', async () => {
  const dir = tmp()
  try {
    const s = store(dir, atNoon, { keepDays: 3 })
    s.add(record(new Date(2026, 9, 20, 12), { n: 4 }))
    s.add(record(NOON, { n: 1 }))
    await s.flush()
    assert.deepEqual(readdirSync(dir), [`${dayOf(NOON)}.jsonl`])
    assert.equal(s.stats().month.n, 1)
    assert.deepEqual(s.recent().map((r) => r.n), [1])
    const b = store(dir, atNoon, { keepDays: 3 })
    await b.loaded
    assert.equal(b.stats().month.n, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record keeps its turn and step, and one read back keeps only a pair the trajectory could name', async () => {
  const dir = tmp()
  try {
    const day = dayOf(NOON)
    const write = (line: Record<string, unknown>): string => JSON.stringify({ ...record(NOON), ...line })
    writeFileSync(
      join(dir, `${day}.jsonl`),
      [
        write({ turn: 4, step: 2 }),
        write({ turn: 4 }),
        write({ step: 2 }),
        write({ turn: 0, step: 2 }),
        write({ turn: 4.5, step: 2 }),
        write({ turn: '4', step: '2' }),
        write({ turn: 4, step: 2 ** 53 }),
      ].join('\n') + '\n',
    )
    const s = store(dir)
    await s.loaded
    const kept = s.recent().map((r) => [r.turn, r.step])
    assert.deepEqual(kept, [
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [4, 2],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
