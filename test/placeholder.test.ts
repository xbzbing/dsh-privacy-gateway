import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { newTally, Restorer } from '../src/redact/restore.ts'
import { bodies, CLOSE, format, hasPlaceholder, kindOf, MAX_PLACEHOLDER, NAMESPACE, OPEN, tailLen } from '../src/redact/placeholder.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const HASH = 'yrp' + '4v35f'
const MISSING = 'a'.repeat(8)
const all: MaskOptions = { secrets: true, protectEnvBlock: true, protectTools: true }

function setup(options: MaskOptions = all) {
  const table = new ValueTable(5000)
  return { table, masker: new Masker(randomBytes(32), table, options), restorer: new Restorer(table) }
}

/** A placeholder in the shape the masker writes, for a kind and a hash that are not from the table. */
const shape = (kind: string, hash = HASH): string => `${OPEN}${NAMESPACE}:${kind}_${hash}${CLOSE}`

test('a placeholder is the namespace, the kind and the hash between two brackets (docs/adr/0037)', () => {
  assert.equal(format('API_KEY', HASH), OPEN + NAMESPACE + ':API_KEY_' + HASH + CLOSE)
  // the kind is upper case and the hash lower, whatever goes in
  assert.equal(format('api_key', 'YRP' + '4V35F'), format('API_KEY', HASH))
  assert.equal(kindOf(shape('PRIVATE_KEY')), 'PRIVATE_KEY')
  assert.equal(kindOf(shape('EMAIL').toLowerCase()), 'EMAIL')
  assert.equal(kindOf('{{SECRET_mpklbomv}}'), '', 'the old braces name no kind now')
  assert.equal(kindOf('plain words'), '')
})

test('the brackets are not a template language’s, so a config of its own is left alone (issue #2)', () => {
  // Lucky, Helm, Jinja and Vue all write {{ }}, and a value of the gateway's own
  // shape may sit in a config: it is text here, and no placeholder
  for (const s of ['{{SECRET_mpklbomv}}', '{{ .Values.token }}', '{{ item.name }}', '{{API_KEY_k3v9x2mq}}']) {
    assert.deepEqual(bodies(s), [], s)
    assert.equal(hasPlaceholder(s), false, s)
  }
  assert.equal(bodies('⟦DSH_REDACTED:API_KEY_kfs5x76z⟧').length, 1)
})

test('a placeholder read back with a bracket changed, dropped, spaced or in another case is still one', () => {
  const body = `${NAMESPACE}:API_KEY_kfs5x76z`
  for (const s of [
    `${OPEN}${body}${CLOSE}`,
    `${OPEN} ${body} ${CLOSE}`,
    `${OPEN}${body}`,
    `${body}${CLOSE}`,
    body,
    `${OPEN}${body}${CLOSE}`.toLowerCase(),
    `${OPEN}${body}${CLOSE}`.toUpperCase(),
  ]) {
    const found = bodies(s)
    assert.equal(found.length, 1, s)
    assert.equal(found[0]?.kind.toUpperCase(), 'API_KEY', s)
  }
  // no namespace, no placeholder: a bare kind and hash is a name and a word
  assert.deepEqual(bodies('API_KEY_k3v9x2mq'), [])
  // against a word it is part of a longer one that has no bracket to its name
  assert.deepEqual(bodies('x' + body), [])
})

test('the tail a stream holds is what may still become a placeholder', () => {
  const full = '⟦DSH_REDACTED:API_KEY_kfs5x76z⟧'
  // a whole one goes back now: nothing is held
  assert.equal(tailLen(`key ${full}`), 0)
  // from the bracket on, the namespace on, or a word that starts it
  for (const t of [OPEN, OPEN + 'DSH_RE', NAMESPACE, NAMESPACE + ':API_KEY_yrp4v35']) {
    assert.equal(tailLen('key ' + t), t.length, t)
  }
  // a whole body with its bracket still to come is held too
  const body = NAMESPACE + ':API_KEY_kfs5x76z'
  assert.equal(tailLen('key ' + OPEN + body), 1 + body.length)
  for (const w of ['d', 'ds', 'dsh_']) assert.equal(tailLen('key ' + w), w.length, w)
  // ordinary text is not
  for (const s of ['key ', 'key De', 'key ' + OPEN + 'other', 'a word' + CLOSE]) assert.equal(tailLen(s), 0, s)
})

test('the longest placeholder the masker writes stays under MAX_PLACEHOLDER', () => {
  const longest = format('K'.padEnd(24, 'K').slice(0, 24), HASH)
  assert.equal([...longest].length, MAX_PLACEHOLDER)
})

test('a placeholder does not mask itself, whatever case or escape it came back in (issue #2)', () => {
  const p = shape('API_KEY')
  // a table with nothing in it: a rule is the only thing that could hit
  for (const s of [p, p.toLowerCase(), p.toUpperCase(), `⟦DSH_REDACTED:PASSWORD_9w9v7e0u⟧`]) {
    const out = setup().masker.maskText(s)
    assert.equal(out.n, 0, s)
    assert.equal(out.text, s, s)
  }
  // the brackets may go as JSON escapes: the decoded text is what is read
  const escaped = '\\u27e6DSH_REDACTED:API_KEY_kfs5x76z\\u27e7'
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${escaped}` }] })
  const out = setup().masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 0)
  assert.equal(out.text, body)
})

test('a reply keeps a template’s own braces as they are, and counts no unmapped placeholder', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  const tally = newTally()
  const reply = JSON.stringify({ content: `lucky has {{SECRET_mpklbomv}} and {{ .Values.token }}; the key is ${p}` })
  const out = restorer.restoreJSON(reply, tally)
  assert.ok(out.includes('{{SECRET_mpklbomv}}'), out)
  assert.ok(out.includes('{{ .Values.token }}'), out)
  assert.ok(out.includes(OPENAI), out)
  assert.equal(tally.unmapped, 0, 'the old braces are not a placeholder this gateway made')
  assert.equal(tally.restored.get(p), 1)
})

test('a new placeholder the table has no value for is left as it is and counted', () => {
  const { masker, restorer } = setup()
  // a restorer with an empty table reads nothing: one value is known here
  masker.placeholder('EMAIL', 'someone@example.com')
  const tally = newTally()
  const unknown = shape('API_KEY', MISSING)
  assert.equal(restorer.restoreJSON(JSON.stringify({ content: unknown }), tally), JSON.stringify({ content: unknown }))
  assert.equal(tally.unmapped, 1)
  // one a model wrote back with a bracket dropped is no sign of one this gateway made
  const loose = newTally()
  restorer.restoreText(`${NAMESPACE}:API_KEY_aaaaaaaa`, false, loose)
  assert.equal(loose.unmapped, 0)
})

test('a value masked under the old braces is not put back: it is history text now', () => {
  const { masker, restorer } = setup()
  const p = masker.placeholder('API_KEY', OPENAI)
  // a value the table has, written in the format 0.2.1 used
  const old = `{{API_KEY_${p.slice(p.lastIndexOf('_') + 1, -1)}}}`
  assert.equal(restorer.restoreText(old), old)
})
