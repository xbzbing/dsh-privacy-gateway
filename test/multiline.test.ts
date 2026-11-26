import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { Restorer } from '../src/redact/restore.ts'
import { multilineSpans } from '../src/redact/multiline.ts'
import { MAX_SECRET } from '../src/redact/rules.ts'

// Built from pieces so no fixture reads as a live credential.
const A = '7kP2' + 'q9M4' + 'v8R1' + 's6T3'
const B = '9zF4' + 'c2W8' + 'n5J1' + 'r7V6'
const VENDOR = 'sk-' + 'proj-aB3cD4eF5gH6iJ7kL8mN9pQ0'
const HEX = 'a8f3c2d1' + '5b7e9f04' + '12345678' + '9abcdef0' + '1234'
const UUID = ['a8f3c2d1', '5b7e', '4f04', '9234', '56789abcdef0'].join('-')

function setup(options: Partial<MaskOptions> = {}) {
  const table = new ValueTable(5000)
  const masker = new Masker(randomBytes(32), table, { secrets: true, protectEnvBlock: true, protectTools: true, ...options })
  return { table, masker, restorer: new Restorer(table) }
}

function values(text: string): string[] {
  const { masker, table } = setup()
  return masker.maskText(text).hits.map((h) => table.get(h.placeholder) ?? '')
}

test('issue #6: YAML screenshot block masks each of its two tokens and keeps every other byte', () => {
  const text = `volcengineApiKey: |-\n  ${A}\n  ${B}\nnext: untouched\n`
  const { masker, restorer } = setup()
  const out = masker.maskText(text)
  assert.equal(out.n, 2)
  assert.deepEqual(out.hits.map((h) => h.by), ['rule', 'rule'])
  assert.deepEqual(out.hits.map((h) => h.kind), ['SECRET', 'SECRET'])
  assert.equal(out.text, text.replace(A, out.hits[0]!.placeholder).replace(B, out.hits[1]!.placeholder))
  assert.equal(restorer.restoreText(out.text), text)
  assert.equal(masker.maskText(out.text).n, 0)
})

test('YAML literal and folded blocks accept chomping, indentation, comments and CRLF', () => {
  for (const indicator of ['|', '>', '|-', '>+', '|2', '>2-', '|-2', '>+2']) {
    for (const newline of ['\n', '\r\n']) {
      const text = ['config:', `  password: ${indicator} # keep`, '', `    ${A}  `, '    ', `    ${B}`, '  public: unchanged', ''].join(newline)
      assert.deepEqual(values(text), [A, B], indicator)
    }
  }
  for (const style of ['|', '>']) {
    for (let digit = 1; digit <= 9; digit++) {
      for (const chomping of ['', '+', '-']) {
        for (const indicator of [`${style}${digit}${chomping}`, `${style}${chomping}${digit}`]) {
          assert.deepEqual(values(`password: ${indicator}\n${' '.repeat(digit)}${A}`), [A], indicator)
        }
      }
    }
  }
  assert.deepEqual(values(`  password: |2\n    ${A}\n   ${B}\n`), [A])
  assert.deepEqual(values(`password: |\n    ${A}\n  ${B}\n`), [A])
})

test('YAML empty blocks and sibling fields do not borrow credential context', () => {
  for (const text of [
    `password: |\npublic: ${A}\n`,
    `password: >-\n\n  \npublic: ${B}\n`,
    `password: |\n  ${A}\npublic:\n  ${B}\n`,
  ]) assert.deepEqual(values(text), text.includes(`  ${A}`) ? [A] : [])
})

test('TOML basic and literal triple-quoted strings support one token per line or same-line values', () => {
  for (const quote of ['"""', "'''"]) {
    for (const text of [
      `password = ${quote}${A}${quote} # keep\npublic = '${B}'`,
      `password = ${quote}\n  ${A}\n\n  ${B}\n${quote}\npublic = '${A}'`,
      `password = ${quote}${A}\r\n${B}${quote}\r\n`,
    ]) assert.deepEqual(values(text), text.includes(`\n  ${B}`) || text.includes(`\r\n${B}`) ? [A, B] : [A])
  }
})

test('multiline credentials reuse container, hex UUID and cursor exclusions from single-line values', () => {
  const slug = ['x', 'dsh', 'auth', 'gateway', 'header'].join('-')
  for (const value of [HEX, UUID, 'a8f3c2d1' + '5b7e9f04']) {
    assert.deepEqual(values(`password: |\n  ${value}\n`), [value])
    assert.deepEqual(values(`next_page_token: |\n  ${value}\n`), [])
    assert.deepEqual(values(`secret_id = """\n${value}\n"""`), [])
  }
  assert.deepEqual(values(`GATEWAY_CREDENTIAL_HEADER: |\n  ${slug}\n`), [])
  assert.deepEqual(values(`password: |\n  ${slug}\n`), [slug])
  assert.deepEqual(values(`element_token: |\n  s0000002a\n`), [])
  assert.deepEqual(values(`api_key: |\n  ${HEX}`), [HEX])
})

test('a complex scalar is not partially tokenized, and an unsupported header does not claim following lines', () => {
  const complex = [`${A} ${B}`, `${A}\\n${B}`, `${A}\\\n${B}`, `${A}\n${B} words`, `${A}\n\"${B}\"`]
  for (const body of complex) {
    assert.deepEqual(multilineSpans(`password = \"\"\"${body}\"\"\"`), [], body)
    assert.deepEqual(multilineSpans(`password: |\n  ${body.replaceAll('\n', '\n  ')}\n`), [], body)
  }
  for (const indicator of ['|0', '>0', '|10', '|++', '>--', '|2-+', '|#comment', '>2garbage']) {
    assert.deepEqual(values(`password: ${indicator}\n  ${A}\n`), [], indicator)
  }
  // Splitting below the minimum length does not reconstruct one larger credential.
  assert.deepEqual(values(`password: |\n  ${A.slice(0, 4)}\n  ${A.slice(4, 8)}\n`), [])
  assert.deepEqual(multilineSpans(`password = \"\"\"${A}\npublic = '${B}'`), [])
  assert.deepEqual(values(`password: |\n  ${A}`), [A])
})

test('TOML closing delimiter identity, basic escaped quotes and literal backslashes preserve scalar scope', () => {
  for (const quote of ['\"\"\"', "'''"]) {
    for (const extra of [1, 2]) {
      assert.deepEqual(values(`password = ${quote}${A}${quote}${quote[0]!.repeat(extra)}\n`), [])
    }
    const other = quote === '\"\"\"' ? "'''" : '\"\"\"'
    assert.deepEqual(values(`password = ${quote}${A}${other}`), [])
  }
  const basic = '\"\"\"'
  for (const slashes of [1, 2, 3, 4]) {
    const prefix = `password = ${basic}\n${A}${'\\'.repeat(slashes)}${basic}\n`
    const close = slashes % 2 === 1 ? `${B}\n${basic}\n` : ''
    assert.deepEqual(values(`${prefix}${close}password2 = ${basic}${B}${basic}\n`), [B])
  }
  assert.deepEqual(values(`password = '''${A}\\'''\npassword2 = '''${B}'''\n`), [B])
  assert.deepEqual(values(`password = ${basic}${A}#${B}${basic}`), [A + '#' + B])
  assert.deepEqual(values(`password = ${basic}${A}${basic}#comment`), [A])
  assert.deepEqual(values(`password = '''${A}'''#comment`), [A])
})

test('nonsensitive scalars, quoted names and list items keep context local to the header', () => {
  assert.deepEqual(values(`description = \"\"\"\npassword: |\n  ${A}\n\"\"\"\napiKey: |\n  ${B}\n`), [B])
  assert.deepEqual(values(`description: |\n  password: |\n    ${A}\napiKey: |\n  ${B}\n`), [B])
  assert.deepEqual(values(`\"volcengineApiKey\": >-\n  ${A}\n`), [A])
  assert.deepEqual(values(`'DB_PASSWORD' = '''${A}'''`), [A])
  assert.deepEqual(values(`- password: |2\n    ${A}\n- public: ${B}\n`), [A])
  assert.deepEqual(values(`-   password: |2\n      ${A}\n    public: |\n      ${B}\n`), [A])
  assert.deepEqual(values(`\"public value\" = \"\"\"\npassword: |\n  ${A}\n\"\"\"\n`), [])
  assert.deepEqual(values(`'public value': |\n  password: |\n    ${A}\n`), [])
  assert.deepEqual(values(`${'p'.repeat(248)}password: |\n  ${A}`), [A])
  assert.deepEqual(values(`${'p'.repeat(249)}password: |\n  ${A}`), [])
})

test('short values, templates, paths, names and algorithm names keep existing semantic exclusions', () => {
  for (const value of ['abc123', 'your_api_key', 'x'.repeat(20), '********', '${PASSWORD}', 'SCRAM-SHA-512', '/home/user/secret.pem', 'process.env.PASSWORD', '4.0.0-beta.1', 'model-v2.safetensors']) {
    assert.deepEqual(values(`password: |\n  ${value}\n`), [], value)
    assert.deepEqual(values(`password = \"\"\"${value}\"\"\"`), [], value)
  }
  assert.deepEqual(values(`password: |\n  correcthorsebatterystaple\n  847392516084\n`), ['correcthorsebatterystaple', '847392516084'])
  const long = 'aB3'.repeat(Math.ceil((MAX_SECRET + 1) / 3))
  assert.deepEqual(values(`password: |\n  ${long}\n`), [])
})

test('legacy vendor-specific kinds win and multiline values use the existing known, preview and allow paths', () => {
  const text = `password: |\n  ${VENDOR}\n  ${A}\n`
  const { masker, table } = setup()
  const preview = masker.preview(text)
  assert.equal(table.size, 0)
  assert.deepEqual(preview.hits.map((h) => h.kind), ['API_KEY', 'SECRET'])
  const out = masker.maskText(text)
  assert.equal(out.text, preview.text)
  assert.deepEqual(out.hits.map((h) => h.by), ['rule', 'rule'])
  assert.equal(masker.maskText(`again ${A}`).hits[0]?.by, 'known')
  assert.deepEqual(setup({ secrets: false }).masker.maskText(text), { text, n: 0, hits: [] })
  const allowed = setup({ allow: [A.toLowerCase()] }).masker.maskText(text)
  assert.equal(allowed.n, 1)
  assert.ok(allowed.text.includes(A))
  for (const h of out.hits) assert.ok(!('field' in h))
})

test('shape preserves token forms, scalar punctuation and restores every byte', () => {
  for (const text of [`password: |-\r\n  ${A}\r\n  ${B}\r\nnext: intact`, `password = \"\"\"${A}\r\n${B}\"\"\" # keep\r\n`]) {
    const { masker, restorer } = setup({ shape: true })
    const out = masker.maskText(text)
    assert.equal(out.n, 2)
    assert.equal(out.text.length, text.length)
    assert.ok(!out.text.includes(A) && !out.text.includes(B))
    assert.equal(restorer.restoreText(out.text), text)
    assert.equal(masker.maskText(out.text).n, 0)
  }
})

test('escaped JSON arguments map multiline token offsets without changing unrelated bytes', () => {
  for (const text of [`password: |2\r\n  ${A}\r\n  ${B}\r\n`, `password: |\n  ${A}`, `password = \"\"\"${A}\n${B}\"\"\" # keep`]) {
    const raw = JSON.stringify({ config: text, public: '\"quoted\" café' }).replace('café', 'caf\\u00e9').replace(A, A.slice(0, 4) + '\\u0071' + A.slice(5))
    const { masker, restorer } = setup()
    const out = masker.maskText(raw, true)
    assert.equal(out.n, text.includes(B) ? 2 : 1)
    const decoded = JSON.parse(out.text) as { config: string; public: string }
    const expected = text.replace(A, out.hits[0]!.placeholder)
    assert.equal(decoded.config, text.includes(B) ? expected.replace(B, out.hits[1]!.placeholder) : expected)
    assert.equal(decoded.public, '\"quoted\" café')
    assert.ok(out.text.includes('caf\\u00e9'))
    assert.equal(JSON.parse(restorer.restoreText(out.text, true)).config, text)
  }
})

test('valid JSON scopes are independent, including unescaped literal strings, arrays and top-level text', () => {
  const config = `password = '''${A}'''`
  for (const raw of [JSON.stringify({ nested: [{ config }] }), JSON.stringify([config]), JSON.stringify(config)]) {
    const { masker } = setup()
    assert.equal(raw.includes('\\'), false)
    assert.equal(masker.maskText(raw, true).n, 1)
  }
  for (const raw of [
    JSON.stringify({ first: `password = \"\"\"\n${A}`, second: `${B}\n\"\"\"` }),
    JSON.stringify({ first: 'password: |', second: `  ${A}` }),
    JSON.stringify({ [config]: 'public' }),
  ]) assert.equal(setup().masker.maskText(raw, true).n, 0)
  assert.equal(setup().masker.maskText(`password: |\n  ${A}`, true).n, 1)
})

test('a full model tool call masks nested argument string values while preserving parameter keys and bytes', () => {
  const config = `password: |\n  ${A}\n  ${B}`
  const named = `password = '''${A}'''`
  const args = JSON.stringify({ [named]: 'public', nested: [{ config }], public: 'caf\\u00e9' })
  const body = JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: args } }] }] })
  const { masker, restorer } = setup()
  const out = masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 2)
  const sentArgs = JSON.parse(out.text).messages[0].tool_calls[0].function.arguments as string
  const sent = JSON.parse(sentArgs)
  assert.equal(sent[named], 'public')
  assert.equal(sent.nested[0].config, config.replace(A, out.hits[0]!.placeholder).replace(B, out.hits[1]!.placeholder))
  assert.equal(sent.public, 'caf\\u00e9')
  assert.equal(JSON.parse(restorer.restoreText(sentArgs, true)).nested[0].config, config)
})

test('model JSON respects protected host env and tools while context contains no complete token', () => {
  const config = `password: |\n  ${A}\n  ${B}\n`
  const env = `<env>\n${config}</env>`
  const body = JSON.stringify({ messages: [{ role: 'system', content: env }, { role: 'user', content: config }], tools: [{ type: 'function', function: { name: 'read', description: config, parameters: {} } }] })
  const { masker } = setup({ context: true })
  const out = masker.maskJSON(body)
  assert.ok(out)
  assert.equal(out.n, 2)
  assert.ok(out.text.includes(JSON.stringify(env).slice(1, -1)))
  assert.ok(out.text.includes(`\"description\":${JSON.stringify(config)}`))
  const hits = JSON.stringify(out.hits)
  assert.ok(!hits.includes(A) && !hits.includes(B))
})

test('long valid and malformed multiline inputs are scanned without quadratic rescans', () => {
  const cases = [
    `password = \"\"\"${'\\\"\"\"aB3'.repeat(10000)}`,
    `password: |\n${'  aB3cD4eF5gH6iJ7k\n'.repeat(4000)}`,
    `password: |\n  ${'aB3'.repeat(40000)}`,
    `${' '.repeat(80000)}password: |\n  ${A}\n`,
    `${'a'.repeat(80000)}password: |\n${`  ${A}\n`.repeat(4000)}`,
    `description = \"\"\"${'public text\n'.repeat(8000)}\"\"\"\npassword: |\n  ${A}`,
  ]
  for (const text of cases) {
    const start = performance.now()
    multilineSpans(text)
    assert.ok(performance.now() - start < 500, 'scanner exceeded 500 ms budget')
  }
})
