import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { Restorer } from '../src/redact/restore.ts'

// Built from pieces so no literal in the repository reads as a live credential.
const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

const all: MaskOptions = { secrets: true, personal: true, protectEnvBlock: true, protectTools: true }

function setup(options: Partial<MaskOptions> = {}) {
  const table = new ValueTable(5000)
  const masker = new Masker(randomBytes(32), table, { ...all, ...options })
  return { table, masker, restorer: new Restorer(table) }
}

/** The values masked in text, in order, by restoring each placeholder alone. */
function masked(text: string, options: Partial<MaskOptions> = {}): string[] {
  const { masker, table } = setup(options)
  const out = masker.maskText(text)
  return [...out.text.matchAll(/\{\{[A-Z_]+_[a-z2-7]{8}\}\}/g)].map((m) => table.get(m[0]) ?? '?')
}

test('the key prefixes of §5.1 are masked as API_KEY', () => {
  const keys = [
    'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv',
    'xox' + 'b-1234567890-abcdefghij',
    'sk_' + 'live_' + 'a1b2c3d4e5f6g7h8i9j0',
    'rk_' + 'test_' + 'a1b2c3d4e5f6g7h8',
    'wh' + 'sec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    'LT' + 'AI5tN8yP2qR7sK3m',
    'AK' + 'IDz8krbsJ5yKBZQpn74WFkmLPx3gnPhESA01',
    'hf_' + 'abcdefghijklmnopqrstuvwxyz012345',
    'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
    'oc_' + 'sk_' + 'abc123def456ghi789jkl',
  ]
  for (const k of keys) assert.deepEqual(masked(`use ${k} here`), [k], k)
})

test('a private key block is one value', () => {
  const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----'
  assert.deepEqual(masked(`key:\n${block}\nend`), [block])
})

test('a JWT is a TOKEN', () => {
  const { masker } = setup()
  assert.match(masker.maskText(`Authorization: Bearer ${JWT}`).text, /Bearer \{\{TOKEN_[a-z2-7]{8}\}\}$/)
})

test('a URL password is masked, unless it is the URL’s user name or host too', () => {
  assert.deepEqual(masked('postgres://app:hunter2pass@db.acme.cn:5432/x'), ['hunter2pass'])
  assert.deepEqual(masked('redis://:s3cretpw@127.0.0.1:6379'), ['s3cretpw'])
  assert.deepEqual(masked('postgresql://geo:geo@127.0.0.1:55432/geo'), [])
  assert.deepEqual(masked('mysql://root:${DB_PASS}@db/x'), [])
})

test('a field named for a secret masks its value; code, paths and versions are left', () => {
  assert.deepEqual(masked('DB_PASSWORD=hunter2pass9'), ['hunter2pass9'])
  assert.deepEqual(masked('{"api_key": "AbC123dEf456GhI789"}'), ['AbC123dEf456GhI789'])
  assert.deepEqual(masked('AccessKeySecret=wJalrXUtnFEMIK7MDENGbPxRfiCY'), ['wJalrXUtnFEMIK7MDENGbPxRfiCY'])
  for (const s of [
    'see internal/auth/token.go:L643-669.',
    'PRIVATE_KEY_PATH=~/.ssh/id_ed25519',
    'access_token = get_access_token_v2(user)',
    '"js-tokens": "^4.0.0-beta.1"',
    'secretKey: Uint8Array;',
    'max_tokens=4096',
  ]) {
    assert.deepEqual(masked(s), [], s)
  }
})

test('CJK names for a password or a key mask what follows them', () => {
  const cases: Array<[string, string]> = [
    ['密码：786kih', '786kih'],
    ['服务器密码是 hunter2，记得改', 'hunter2'],
    ['パスワードは pa55word です', 'pa55word'],
    ['비밀번호: qwer1234', 'qwer1234'],
    ['密钥为 a8f3k2m9q1', 'a8f3k2m9q1'],
    ['token 是 a1b2c3d4e5f6，别外传', 'a1b2c3d4e5f6'],
    ['API Key：xk2f9d8s7a6q5w', 'xk2f9d8s7a6q5w'],
    ['密钥为12231241', '12231241'],
  ]
  for (const [text, v] of cases) assert.deepEqual(masked(text), [v], text)
  assert.deepEqual(masked('密钥为 2048 位'), [])
  assert.deepEqual(masked('token 是 expired'), [])
})

test('personal data is off unless asked for, and checks its form', () => {
  const text = '联系 jo@quill.dev 或手机 13800138000，身份证 11010519491231002X，卡号 4111 1111 1111 1111'
  assert.deepEqual(masked(text, { personal: false }), [])
  assert.deepEqual(masked(text), ['jo@quill.dev', '13800138000', '11010519491231002X', '4111 1111 1111 1111'])
  for (const s of ['git@github.com:o/r.git', 'icon@2x.png', 'x@pytest.fixture', 'a@example.com', 'read @AGENTS.md']) {
    assert.deepEqual(masked(s), [], s)
  }
})

test('a phone-shaped id, a decimal and a bare JSON number are no phone', () => {
  assert.deepEqual(masked('订单号 13912345678 已发货'), [])
  assert.deepEqual(masked('"order_id": "13800138000"'), [])
  assert.deepEqual(masked('{"timestamp": 17929036837}'), [])
  assert.deepEqual(masked('lat 5.13800138000'), [])
  assert.deepEqual(masked('"phone": "13800138000"'), ['13800138000'])
})

test('a piece of a UUID or a commit is no value', () => {
  assert.deepEqual(masked('request 1f0e3dad-9990-4b5c-8a1b-13800138000a'), [])
  assert.deepEqual(masked('"next_page_token": "9f8e7d6c5b4a39281706f5e4d3c2b1a0"'), [])
})

test('the user’s words are masked as TERM; allowed values go as written', () => {
  assert.deepEqual(masked('Project Bluebird ships Friday', { words: ['Bluebird'] }), ['Bluebird'])
  assert.deepEqual(masked(`key ${OPENAI}`, { allow: [OPENAI.toUpperCase()] }), [])
})

test('a value masked once is masked as known wherever it shows up again', () => {
  const { masker, table } = setup()
  masker.maskText('DB_PASSWORD=Hunt3rPass9')
  const out = masker.maskText('the password is Hunt3rPass9, keep it safe')
  assert.equal(out.n, 1)
  assert.equal(out.hits[0]?.by, 'known')
  assert.equal(table.get(out.hits[0]?.placeholder ?? ''), 'Hunt3rPass9')
  assert.equal(masker.maskText('xHunt3rPass9').n, 0, 'a piece of a longer word')
})

test('a text sent before to a host goes again as it went (prompt cache)', () => {
  const { masker } = setup()
  const history = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'note Hunt3rPass9 here' }] })
  const first = masker.maskJSON(history, 'api.example')
  assert.equal(first?.text, history)
  masker.maskText('DB_PASSWORD=Hunt3rPass9')
  assert.equal(masker.maskJSON(history, 'api.example')?.text, history, 'same host: as before')
  assert.notEqual(masker.maskJSON(history, 'other.example')?.text, history, 'another host: masked afresh')
})

test('hits keep the kind, the finder, a hint and never the value', () => {
  const { masker } = setup()
  const out = masker.maskText(`key ${OPENAI}`)
  assert.deepEqual(out.hits.map(({ kind, by, head, len }) => ({ kind, by, head, len })), [{ kind: 'API_KEY', by: 'rule', head: 'sk-proj-abcd', len: OPENAI.length }])
  assert.ok(!JSON.stringify(out.hits).includes(OPENAI.slice(8)))
})

test('preview gives the placeholders and remembers nothing', () => {
  const { masker, table } = setup()
  const out = masker.preview(`key ${OPENAI}`)
  assert.equal(out.n, 1)
  assert.equal(table.size, 0)
})

test('a long text with markers everywhere is masked in linear time', () => {
  const { masker } = setup()
  const text = ('token key password secret @ :// ' + 'A'.repeat(200) + ' ').repeat(2000)
  const t = performance.now()
  masker.maskText(text)
  assert.ok(performance.now() - t < 2000, `took ${performance.now() - t} ms`)
})

test('a hint keeps a key\'s prefix and its next characters, plus a couple at the end: a human can tell which value it was', async () => {
  const { hint } = await import('../src/redact/find.ts')
  // 25 characters: prefix + 4, and the last 2
  assert.deepEqual(hint('API_KEY', 'sk-' + 'ab12cd34ef56gh78ij90kl', false), { head: 'sk-ab12', tail: 'kl', len: 25 })
  assert.deepEqual(hint('API_KEY', 'sk-' + 'ant-api03-XyZw1234567890abcdef', false), { head: 'sk-ant-api03-XyZw', tail: 'ef', len: 33 })
  // short ones keep fewer, and no tail until the head and the tail cannot meet
  assert.deepEqual(hint('API_KEY', 'sk-' + 'ab12cd34ef56gh78', false), { head: 'sk-ab12', tail: '78', len: 19 })
  assert.deepEqual(hint('API_KEY', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', false), { head: 'ghp_A1b2', tail: 'r8', len: 40 })
  // no prefix: the first characters themselves, so a bare secret is recognizable too
  assert.deepEqual(hint('SECRET', '3f9a1b2c4d5e6f708192a3b4c5d6e7f8', false), { head: '3f9a', tail: 'f8', len: 32 })
  assert.deepEqual(hint('SECRET', 'n4k9x2b7q', false), { head: 'n4', len: 9 })
  assert.deepEqual(hint('SECRET', 'abc', false), { head: 'a', len: 3 })
  // personal data and the user's words: one character, they are not a key to recognize
  assert.deepEqual(hint('EMAIL', 'someone@example.com', true), { head: 's', len: 19 })
  assert.deepEqual(hint('TERM', 'project-x', false), { head: 'p', len: 9 })
})

test('reconfigure: new words mask from the next request, and a value masked before is still restored', async () => {
  const { randomBytes } = await import('node:crypto')
  const { PrivacyEngine } = await import('../src/engine.ts')
  const { defaults: base } = await import('../src/config.ts')
  const info = { host: 'api.example.com', path: '/v1/chat/completions' }
  const chat = (content: string) => JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }] })
  const key = 'sk-' + 'proj-RECONFIGsentinel0123456789abcd'
  const e = new PrivacyEngine(randomBytes(32), base)
  const first = e.maskRequest(chat(`key ${key} for Bluebird`), info)
  assert.ok(first && first.text.includes('Bluebird') && !first.text.includes(key))
  e.reconfigure({ ...base, words: ['Bluebird'], secrets: false })
  const second = e.maskRequest(chat('Bluebird again'), info)
  assert.ok(second && !second.text.includes('Bluebird'))
  // the reply to the first request still has its key put back
  const placeholder = /\{\{API_KEY_[^}]+\}\}/.exec(first.text)?.[0] ?? ''
  assert.ok(placeholder)
  const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content: `use ${placeholder}` } }] })
  assert.ok(first.restoreBody(reply).includes(key))
})
