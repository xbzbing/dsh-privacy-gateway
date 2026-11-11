import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { versionValue } from '../src/redact/checks.ts'
import { ValueTable } from '../src/redact/known.ts'
import { Masker } from '../src/redact/mask.ts'
import { Restorer } from '../src/redact/restore.ts'

const BEGIN = '-----' + 'BEGIN ' + 'PRIVATE KEY' + '-----'

function ms(f: () => unknown): number {
  const t = performance.now()
  f()
  return performance.now() - t
}

function setup() {
  const table = new ValueTable(5000)
  const masker = new Masker(randomBytes(32), table, { secrets: true, personal: true, protectEnvBlock: true, protectTools: true })
  masker.maskText('key sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst')
  return { masker, restorer: new Restorer(table, 'block') }
}

test('a version check of a long digit run with no match takes no time', () => {
  assert.equal(versionValue('1.0' + '1'.repeat(24) + 'x'), false)
  const t = ms(() => versionValue('1.0' + '1'.repeat(40) + 'x'))
  assert.ok(t < 50, `took ${t} ms`)
  for (const v of ['1.2.3-beta1', '^4.0.0-beta.1', '9.2.0-beta1', '1.2.3rc1', '1.0.0b2', '1.2.3-12', '1.2.312']) assert.ok(versionValue(v), v)
})

test('long runs that once made a pattern read the rest of the text from every place are masked in linear time', () => {
  const { masker } = setup()
  const texts = [
    'a'.repeat(80000) + ' cookie',
    'eyJ'.repeat(40000),
    'token='.repeat(8000),
    'cookie='.repeat(8000),
    'cookie: x '.repeat(8000),
    'BDUSS='.repeat(8000),
    BEGIN.repeat(2000),
    (BEGIN + '\n' + 'A'.repeat(64)).repeat(600),
    BEGIN + '\n' + 'A'.repeat(60000),
    BEGIN + ('A'.repeat(63) + '\n').repeat(1000),
    'Proc-Type: '.repeat(5000),
    'Authorization: Bearer '.repeat(3000),
    'Authorization: Basic ' + 'QUJD'.repeat(10000),
    'MYSQL_PWD='.repeat(5000),
  ]
  for (const s of texts) {
    const t = ms(() => masker.maskText(s)) + ms(() => masker.maskText(s, true))
    assert.ok(t < 500, `${s.slice(0, 12)}…: took ${t} ms`)
  }
})

test('a long word before an underscore is restored in linear time', () => {
  const { restorer } = setup()
  const t = ms(() => restorer.restoreText('a'.repeat(40000) + ' _'))
  assert.ok(t < 100, `took ${t} ms`)
})

test('a full table fills and matches in linear time, even when every value shares a prefix', () => {
  const table = new ValueTable(4999)
  const values = Array.from({ length: 4999 }, (_, i) => `sk-proj-${i.toString(36).padStart(5, '0')}${'aB3xY9'.repeat(4)}`)
  const fill = ms(() => {
    for (let i = 0; i < values.length; i++) table.put(`{{API_KEY_${i.toString(16).padStart(8, '0')}}}`, 'API_KEY', values[i] as string)
  })
  assert.equal(table.size, 4999)
  assert.ok(fill < 200, `fill took ${fill} ms`)
  const text = values.join(' ').slice(0, 32768)
  const match = ms(() => table.knownSpans(text, () => true))
  assert.ok(match < 200, `match took ${match} ms`)
})
