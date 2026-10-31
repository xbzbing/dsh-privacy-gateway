import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { defaults, resolveConfig } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { hideWarned, ViewStore } from '../src/views.ts'

const KEY = 'sk-' + 'proj-VIEWSviews0123456789abcdefgh'
const MAIL = 'rina.k@kowalczyk.pl'
const chat = (content: string) => JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

test('the view store keeps at most so many bodies and so much in all, the oldest dropped first, and no body too large', () => {
  const s = new ViewStore({ maxViews: 3, maxBody: 10, maxTotal: 20 })
  assert.equal(s.put(1, 'a'.repeat(11)), false)
  for (let k = 1; k <= 4; k++) s.put(k, 'x'.repeat(5))
  assert.deepEqual(s.keys(), [2, 3, 4])
  s.put(5, 'y'.repeat(10))
  assert.deepEqual(s.keys(), [3, 4, 5])
  s.put(6, 'z'.repeat(10))
  assert.deepEqual(s.keys(), [5, 6])
})

test('hideWarned swaps every form of a warned value, the longest first', () => {
  assert.equal(hideWarned('a b ab', [['a', 'P'], ['ab', 'Q']]), 'P b Q')
})

test('a recorded request keeps the body as it went, with a warned value as its placeholder', () => {
  const views = new ViewStore()
  const e = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, personal: true, actions: { EMAIL: 'warn' } }), { views })
  const ex = e.maskRequest(chat(`key ${KEY} mail ${MAIL}`), info)
  assert.ok(ex)
  assert.ok(ex.text.includes(MAIL))
  ex.finish()
  const [r] = e.records.recent()
  assert.ok(r)
  const body = views.get(r.key)
  assert.ok(body)
  assert.ok(!body.includes(KEY) && !body.includes(MAIL))
  const mailTag = r.values.find((v) => v.kind === 'EMAIL')?.placeholder ?? ''
  assert.ok(mailTag && body.includes(mailTag))
  assert.ok(body.includes(r.values.find((v) => v.kind === 'API_KEY')?.placeholder ?? '?'))
})

test('a request not recorded, or blocked, keeps no body', () => {
  const views = new ViewStore()
  const e = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, actions: { API_KEY: 'block' } }), { views })
  e.maskRequest(chat('hello'), info)?.finish()
  assert.throws(() => e.maskRequest(chat(`key ${KEY}`), info))
  assert.equal(views.size, 0)
})
