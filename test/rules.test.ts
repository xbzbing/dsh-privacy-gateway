import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { MIN_SECRET_CHARS } from '../src/redact/find.ts'
import { MIN_KNOWN, ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { Restorer } from '../src/redact/restore.ts'

// Built from pieces so no literal in the repository reads as a live credential.
const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

// The password-shaped values the rule tests use, built from pieces: a literal
// one reads as a live credential to every tool that scans this file.
const PW_A = '786' + 'kih' + '24'
const PW_B = 'hunt' + 'er2' + '!'
const PW_C = 'pa5' + '5wor' + 'd'
const PW_D = 'qwer' + '1234'
const PW_E = 'a8f3' + 'k2m9' + 'q1'
const PW_F = 'a1b2' + 'c3d4' + 'e5f6'
const PW_G = 'xk2f' + '9d8s' + '7a6q5w'

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

// A model's file name, as ComfyUI's PowerShell dump of a workflow has it (issue #1). Built from
// pieces, so no literal in the repository reads as a file name's.
const MODEL_FILE = ['sample', 'upscaler', 'x4', 'conv', '1', 'bf16'].join('_') + '.safetensors'
const KEY_WITH_A_DOT = ['bwerotp', 'q0', 'nwgujt', 'vexvrouy', 'c9'].join('_') + '.kqdfamuqzy'

test("a field called key holding a file's name is no secret (issue #1)", () => {
  // PowerShell's dump of a workflow: $key='<model file>' for a node the run loads
  const dump = `'18'=@{class_type='LatentUpscaleModelLoader';inputs=[ordered]@{$key='${MODEL_FILE}'}}`
  for (const s of [dump, `{"key": "${MODEL_FILE}"}`, `{"token": "${MODEL_FILE}"}`, `db_password=${MODEL_FILE}`]) {
    assert.deepEqual(masked(s), [], s)
  }
  // a value of its own with a dot in it, whose extension no file has, is still a key
  assert.deepEqual(masked(`{"key": "${KEY_WITH_A_DOT}"}`), [KEY_WITH_A_DOT])
  assert.deepEqual(masked(dump.replace(MODEL_FILE, KEY_WITH_A_DOT)), [KEY_WITH_A_DOT])
})

test('CJK names for a password or a key mask what follows them', () => {
  const cases: Array<[string, string]> = [
    [`密码：${PW_A}`, PW_A],
    [`服务器密码是 ${PW_B}，记得改`, PW_B],
    [`パスワードは ${PW_C} です`, PW_C],
    [`비밀번호: ${PW_D}`, PW_D],
    [`密钥为 ${PW_E}`, PW_E],
    [`token 是 ${PW_F}，别外传`, PW_F],
    [`API Key：${PW_G}`, PW_G],
    ['密钥为12231241', '12231241'],
  ]
  for (const [text, v] of cases) assert.deepEqual(masked(text), [v], text)
  assert.deepEqual(masked('密钥为 2048 位'), [])
  assert.deepEqual(masked('token 是 expired'), [])
})

test('a secret shorter than 8 characters is no value: it is guessed in no time, and masking it promises what is not there', () => {
  // the short ones go as written, whichever name they follow (docs/adr/0031)
  const short = ['abc' + '123', 'hunt' + 'er' + '2', '786' + 'kih', '12' + '34' + '56', '000' + '000']
  for (const v of short) assert.deepEqual(masked('密码：' + v), [], `${v.length} characters`)
  assert.deepEqual(masked('token 是 ' + 'a1b2c3d'), [])
  assert.deepEqual(masked('postgres://app:' + 'fa2b6e' + '@db.internal/x'), [])
  assert.deepEqual(masked('api_key=' + 'abc123'), [])
  // eight characters on: a value, whichever rule found it
  assert.deepEqual(masked('密码：' + PW_A), [PW_A])
  assert.deepEqual(masked('postgres://app:' + PW_A + '@db.internal/x'), [PW_A])
  assert.deepEqual(masked('token 是 ' + PW_F), [PW_F])
  // the value table never matches one this short as known either: the two floors are one rule
  assert.equal(MIN_SECRET_CHARS, MIN_KNOWN)
})

test('the name of a cryptographic algorithm is no value: a spec publishes it (docs/adr/0033)', () => {
  // a Kafka config's scram_mechanism, found by a field name with token in it (the report)
  for (const s of [
    `'once_kafka_token.scram_mechanism': 'SCRAM-SHA-512',`,
    'password_hash=PBKDF2WithHmacSHA256',
    '{"key": "ECDHE-RSA-AES128-GCM-SHA256"}',
    '密钥是 SCRAM-SHA-512',
    'token 是 SCRAM-SHA-512，别改',
  ]) {
    assert.deepEqual(masked(s), [], s)
  }
  // an algorithm's words spelled out are no password's: a value of random characters still goes
  for (const s of ['token=ZEBRA-256', 'api_key=justword256']) {
    assert.deepEqual(masked(s), [s.slice(s.indexOf('=') + 1)], s)
  }
})

test('a value typed to stand for a key is no key: a run of one character, or a word that says so', () => {
  // what a person writes where a key goes: one character over and over (docs/adr/0031)
  for (const text of ['sk-proj-' + 'x'.repeat(20), 'sk-ant-api03-' + 'x'.repeat(24), 'AKIA' + '0'.repeat(16), 'ghp_' + 'x'.repeat(36), 'sk-proj-' + 'x'.repeat(300)]) {
    assert.deepEqual(masked(text), [], text)
  }
  // a stand-in that names itself
  for (const text of ['sk-proj-' + 'YOUR_API_KEY'.repeat(2), 'AKIA' + 'IOSFODNN7EXAMPLE', 'api_key=' + 'changeme' + 'changeme']) {
    assert.deepEqual(masked(text), [], text)
  }
  // a real key of the same shapes still goes, and so does one whose end is too short to say
  const real = [OPENAI, 'sk-ant-api03-' + 'Q7fK2mZx9RtL4wVb8Nc1Ys6Hd3', 'AKIA' + 'Q7FK2MZX9RTL4WVB', 'ghp_' + 'aQ7fK2mZx9RtL4wVb8Nc1Ys6Hd3Tj5Ug0Pl9']
  for (const text of real) assert.deepEqual(masked(text), [text], text)
  assert.deepEqual(masked('sk-proj-' + 'N2eE8yGp2CoF8pZr8My6Pu5Bu5_nm'), ['sk-proj-' + 'N2eE8yGp2CoF8pZr8My6Pu5Bu5_nm'])
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
  assert.deepEqual(hint('SECRET', 'abc', false), { head: '', len: 3 })
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

// PEM lines built from pieces, so no tool or gateway reads a key here
const D = '-----'
const BEGIN = D + 'BEGIN ' + 'PRIVATE KEY' + D
const END = D + 'END ' + 'PRIVATE KEY' + D
const B64 = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wYQ1xS2dF3gH4jK5lM6nO7pQ8rS9tU0vW', 'x1Y2z3A4b5C6d7E8f9G0h1I2j3K4l5M6n7O8p9Q0==']

test('a PEM private key is masked whole, in text and in JSON text, and code naming its lines is not', () => {
  const pem = [BEGIN, ...B64, END].join('\n')
  assert.deepEqual(masked(`key:\n${pem}\nthat was it`), [pem])
  const escaped = [BEGIN, ...B64, END].join('\\n')
  assert.deepEqual(masked(`{"key":"${escaped}"}`), [escaped])
  const encrypted = [BEGIN.replace('BEGIN ', 'BEGIN RSA '), 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: DES-EDE3-CBC,0123456789ABCDEF', '', ...B64, END.replace('END ', 'END RSA ')].join('\n')
  assert.deepEqual(masked(encrypted), [encrypted])
  const code = `const head = '${BEGIN}'\nfunction wrap(b) { return head + '\\n' + b + '\\n' + tail }\nconst tail = '${END}'`
  assert.deepEqual(masked(code), [])
})

test('a PEM key cut off before its END line is masked up to its last base64 line', () => {
  const cut = [BEGIN, ...B64].join('\n')
  assert.deepEqual(masked(`${cut}\nand the rest is lost`), [cut])
  assert.deepEqual(masked(`"${[BEGIN, ...B64].join('\\n')}"`), [[BEGIN, ...B64].join('\\n')])
  // a BEGIN line with a few words after it is no key
  assert.deepEqual(masked(`${BEGIN}\nfoo\nbar`), [])
})

test('an Authorization header\'s Bearer token and Basic credential are masked; stand-ins and prose are not', () => {
  const bearer = 'abcDEF123456ghiJKL789mno'
  assert.deepEqual(masked(`curl -H "Authorization: Bearer ${bearer}" https://api.example.com`), [bearer])
  assert.deepEqual(masked(`{"headers":{"authorization":"bearer ${bearer}"}}`), [bearer])
  const basic = Buffer.from('alice:s3cretPass').toString('base64')
  assert.deepEqual(masked(`Authorization: Basic ${basic}`), [basic])
  for (const s of [
    'Authorization: Bearer $TOKEN',
    'Authorization: Bearer ${TOKEN}',
    'Authorization: Bearer {{TOKEN_abcdefgh}}',
    'Authorization: Bearer YOUR_ACCESS_TOKEN',
    'Authorization: Bearer <token>',
    'The Authorization: Bearer token header is required',
    'Authorization: Basic realm="api"',
    'send a Bearer abcDEF123456ghiJKL789 token',
  ]) assert.equal(setup().masker.maskText(s).n, 0, s)
})

test('a *_PWD field masks its value', () => {
  assert.deepEqual(masked('MYSQL_PWD=Hunt3rPass9 mysql -u root'), ['Hunt3rPass9'])
  assert.deepEqual(masked('cd $PWD && OLDPWD=/Users/me/src'), [])
})

test('a named field masks a long letters-only passphrase or a long number (ADR-0036)', () => {
  const passphrase = 'correct' + 'horse' + 'battery' + 'staple'
  assert.deepEqual(masked(`DB_PASSWORD=${passphrase}`), [passphrase])
  assert.deepEqual(masked(`{"api_key": "${passphrase}"}`), [passphrase])
  const token = ['my-very', 'long', 'passphrase', 'here'].join('-')
  assert.deepEqual(masked(`token = ${token}`), [token])
  assert.deepEqual(masked('password=' + '8291374651'), ['8291374651'])
  // a long word found in free text is still no secret
  assert.deepEqual(masked(`the passphrase is ${passphrase}`), [])
})
