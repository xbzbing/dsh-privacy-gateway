import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_BOOK_SESSIONS, StepBook } from '../src/steps.ts'

const started = (turn: number, step: number) => ({ type: 'step/start', data: { turn, step } })

test('a step/start says where its session is; every other entry leaves it as it was', () => {
  const book = new StepBook()
  assert.equal(book.at('s1'), undefined)
  book.observe({ id: 's1' }, started(2, 1))
  assert.deepEqual(book.at('s1'), { turn: 2, step: 1 })
  for (const type of ['step/end', 'turn/start', 'turn/end', 'tool/call', 'assistant/message', 'user/message']) {
    book.observe({ id: 's1' }, { type, data: { turn: 9, step: 9 } })
    assert.deepEqual(book.at('s1'), { turn: 2, step: 1 }, type)
  }
  // a later step moves it, and the two sessions are told apart
  book.observe({ id: 's1' }, started(2, 2))
  book.observe({ id: 's2' }, started(7, 4))
  assert.deepEqual(book.at('s1'), { turn: 2, step: 2 })
  assert.deepEqual(book.at('s2'), { turn: 7, step: 4 })
})

test('a subject or entry that names no usable step is not read as one', () => {
  const book = new StepBook()
  const bad: Array<[unknown, unknown]> = [
    [undefined, started(1, 1)],
    [null, started(1, 1)],
    [{}, started(1, 1)],
    [{ id: '' }, started(1, 1)],
    [{ id: 7 }, started(1, 1)],
    [{ id: 's1' }, undefined],
    [{ id: 's1' }, {}],
    [{ id: 's1' }, { type: 'step/start' }],
    [{ id: 's1' }, { type: 'step/start', data: null }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: 0, step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: 1, step: 0 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: -1, step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: 1.5, step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: Number.NaN, step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: Number.POSITIVE_INFINITY, step: 1 } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: '1', step: '1' } }],
    [{ id: 's1' }, { type: 'step/start', data: { turn: 2 ** 53, step: 1 } }],
  ]
  for (const [session, event] of bad) {
    book.observe(session, event)
    assert.equal(book.at('s1'), undefined, JSON.stringify([session, event]))
  }
  // one good entry is enough, and one bad after it changes nothing
  book.observe({ id: 's1' }, started(1, 1))
  book.observe({ id: 's1' }, { type: 'step/start', data: { turn: 'x', step: 1 } })
  assert.deepEqual(book.at('s1'), { turn: 1, step: 1 })
})

test('the book keeps at most MAX_BOOK_SESSIONS, the one least recently spoken for going first', () => {
  const book = new StepBook()
  for (let i = 0; i < MAX_BOOK_SESSIONS; i++) book.observe({ id: `s${i}` }, started(1, 1))
  assert.equal(book.at('s0') !== undefined, true)
  // met again: s0 is now the most recent, so s1 is the one that goes
  book.observe({ id: 's0' }, started(2, 1))
  book.observe({ id: 'overflow' }, started(1, 1))
  assert.deepEqual(book.at('s0'), { turn: 2, step: 1 })
  assert.equal(book.at('s1'), undefined, 'the least recently spoken for goes')
  assert.equal(book.at('overflow') !== undefined, true)
  let kept = 0
  for (let i = 0; i < MAX_BOOK_SESSIONS + 1; i++) if (book.at(`s${i}`) !== undefined) kept++
  assert.equal(kept, MAX_BOOK_SESSIONS - 1, 'the cap holds, an evicted session aside')
  book.clear()
  assert.equal(book.at('s0'), undefined)
})
