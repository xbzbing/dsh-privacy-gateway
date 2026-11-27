import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { defaults } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { RecordStore } from '../src/records.ts'

const chat = (content: string) => JSON.stringify({ model: 'gpt-x', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

/** A store and an engine over it, with the config a test asks for. */
function setup(over: Partial<typeof defaults> = {}): { engine: PrivacyEngine; records: RecordStore } {
  const records = new RecordStore({ keepDays: 30, keepBytes: 1024 * 1024, keepRecords: 10 })
  const engine = new PrivacyEngine(randomBytes(32), { ...defaults, ...over }, { records })
  return { engine, records }
}

/** The one record a request left, after its reply was read. */
function only(records: RecordStore): Record<string, unknown> {
  const rows = records.recent(1)
  assert.equal(rows.length, 1, 'one request, one record')
  return rows[0] as unknown as Record<string, unknown>
}

test('an unknown marker is recorded by an anonymous number, never by its text', () => {
  // the value is a word the gateway masks, so it is in the table; the model
  // then writes a marker that names it inside a legal-looking shell
  const { engine, records } = setup({ words: ['abcdefgh'] })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:SECRET_abcdefgh⟧' }))
  exchange.finish()
  const row = only(records)
  const notes = row.unknown as Array<{ id: string; kind: string; n: number }>
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.id, 'unknown-1')
  // the kind is one of ours, so it is kept; the hash the model wrote is the
  // value, and it is not
  assert.equal(notes[0]?.kind, 'SECRET')
  assert.equal(notes[0]?.n, 1)
  assert.ok(!JSON.stringify(row).includes('abcdefgh'), 'the marker text must not reach the record')
  // the count is unchanged by the note: the note is evidence, not a new rule
  assert.equal(row.unmapped, 1)
})

test('a kind the gateway does not know is recorded as custom', () => {
  const { engine, records } = setup({ words: ['abcdefgh'] })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:PLANET_kfs5x76z⟧' }))
  exchange.finish()
  const notes = only(records).unknown as Array<{ kind: string }>
  assert.equal(notes[0]?.kind, 'custom')
})

test('a marker under a kind of ours keeps the kind, and repeats are counted once', () => {
  const { engine, records } = setup({ words: ['abcdefgh'] })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:API_KEY_kfs5x76z⟧ and ⟦DSH_REDACTED:API_KEY_kfs5x76z⟧' }))
  exchange.finish()
  const notes = only(records).unknown as Array<{ kind: string; n: number }>
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.kind, 'API_KEY')
  assert.equal(notes[0]?.n, 2)
})

test('a setting on is not proof the path ran: an empty table leaves it skipped', () => {
  // only a warned value: nothing enters the table, so no reply is read
  const { engine, records } = setup({ words: ['abcdefgh'], actions: { TERM: 'warn' }, restoreLog: true })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:SECRET_abcdefgh⟧' }))
  exchange.finish()
  const row = only(records)
  const detection = row.detection as { settings: { restoreLog: boolean }; unknown: { state: string; reasons?: string[] } }
  assert.equal(detection.settings.restoreLog, true)
  assert.equal(detection.unknown.state, 'skipped')
  assert.deepEqual(detection.unknown.reasons, ['no-value-table'])
  assert.equal(row.unmapped, 0, 'nothing was read, so nothing was counted')
})

test('the log restore switch off leaves the reply path skipped, not clean', () => {
  const { engine, records } = setup({ restoreLog: false, words: ['abcdefgh'] })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:SECRET_abcdefgh⟧' }))
  exchange.finish()
  const detection = only(records).detection as { unknown: { state: string; reasons?: string[] } }
  assert.equal(detection.unknown.state, 'skipped')
  assert.deepEqual(detection.unknown.reasons, ['restore-disabled'])
})

test('a reply that was read says so, and a cut-off one says partial', () => {
  const { engine, records } = setup({ words: ['abcdefgh'], restoreLog: true })
  const exchange = engine.maskRequest(chat('the word is abcdefgh'), info)
  assert.ok(exchange)
  exchange.restoreBody(JSON.stringify({ content: '⟦DSH_REDACTED:SECRET_abcdefgh⟧' }))
  exchange.finish(true)
  const detection = only(records).detection as { unknown: { state: string; reasons?: string[] } }
  assert.equal(detection.unknown.state, 'partial')
  assert.deepEqual(detection.unknown.reasons, ['incomplete-reply'])
})