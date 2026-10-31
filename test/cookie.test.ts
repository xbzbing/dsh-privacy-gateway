import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { ValueTable } from '../src/redact/known.ts'
import { Masker, type MaskOptions } from '../src/redact/mask.ts'
import { Restorer } from '../src/redact/restore.ts'

const BDUSS = 'VZlZ2FrR0RqT1dVc' + 'G9yUk1hT3B-dGtXT2s'
const STOKEN = '8f3c2a1b9d7e' + '6f5a4b3c2d1e0f9a8b7c'
const SID = 's%3AqJ9xK2' + 'mP4nR8tV.abc'
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

const base: MaskOptions = { secrets: true, protectEnvBlock: true, protectTools: true }

function setup(options: Partial<MaskOptions> = {}) {
  const table = new ValueTable(5000)
  return { table, masker: new Masker(randomBytes(32), table, { ...base, ...options }), restorer: new Restorer(table) }
}

const PH = /\{\{COOKIE_[a-z2-7]{8}\}\}/g

function check(text: string, values: string[], options: Partial<MaskOptions> = {}) {
  const { masker, restorer } = setup(options)
  const out = masker.maskText(text)
  for (const v of values) assert.ok(!out.text.includes(v), `${v} left in ${out.text}`)
  assert.equal(out.text.match(PH)?.length ?? 0, values.length, out.text)
  assert.equal(restorer.restoreText(out.text), text, 'restored byte for byte')
  return out
}

test('a Cookie: header masks each value and keeps each name', () => {
  const out = check(`Cookie: BDUSS=${BDUSS}; lang=zh-CN; STOKEN=${STOKEN}`, [BDUSS, STOKEN])
  assert.match(out.text, /^Cookie: BDUSS=\{\{COOKIE_[a-z2-7]{8}\}\}; lang=zh-CN; STOKEN=\{\{COOKIE_/)
  assert.deepEqual(out.hits.map((h) => h.head), ['BDUSS', 'STOKEN'])
  check(`curl -H 'cookie: a_session=${STOKEN}' https://x.cn`, [STOKEN])
})

test('Set-Cookie masks its first pair only', () => {
  const out = check(`Set-Cookie: sid=${STOKEN}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; SameSite=Lax`, [STOKEN])
  assert.ok(out.text.includes('Path=/; Expires=Wed'))
})

test('curl -b masks pairs; a cookie file’s name is left', () => {
  check(`curl -b 'uid=${STOKEN}; theme=darkmode1' https://x.cn`, [STOKEN])
  check(`curl --cookie "sess=${STOKEN}" https://x.cn`, [STOKEN])
  check('curl -b cookies.txt https://x.cn', [])
})

test('cookies.txt masks the seventh column', () => {
  const txt = `# Netscape HTTP Cookie File\n.baidu.com\tTRUE\t/\tFALSE\t1924905600\tBDUSS\t${BDUSS}\n.x.cn\tTRUE\t/\tTRUE\t0\tlang\tzh-CN-long\n`
  const out = check(txt, [BDUSS])
  assert.ok(out.text.includes('\t1924905600\tBDUSS\t{{COOKIE_'))
})

test('a storageState cookie object masks its value; domain, path and expires stay', () => {
  const state = JSON.stringify({ cookies: [{ name: 'connect.sid', value: SID, domain: '.x.cn', path: '/', expires: 1924905600, httpOnly: true }] }, null, 2)
  const out = check(state, [SID])
  assert.ok(out.text.includes('"domain": ".x.cn"') && out.text.includes('"expires": 1924905600'))
  // a HAR header object is a Cookie: line
  check(JSON.stringify({ name: 'Cookie', value: `BDUSS=${BDUSS}; lang=zh` }), [BDUSS])
})

test('code and config naming a cookie are split pair by pair', () => {
  check(`headers = {"Cookie": "BDUSS=${BDUSS}; STOKEN=${STOKEN}"}`, [BDUSS, STOKEN])
  check(`cookies={"BDUSS": "${BDUSS}", "lang": "zh-CN"}`, [BDUSS])
  check(`document.cookie = "token_x=${STOKEN}"`, [STOKEN])
  check(`BAIDU_COOKIE=BDUSS=${BDUSS}`, [BDUSS])
})

test('a listed cookie is masked anywhere, a short value or a kept name never', () => {
  check(`https://x.cn/cb?BDUSS=${BDUSS}&from=web`, [BDUSS])
  check(`__Secure-next-auth.session-token=${STOKEN}`, [STOKEN])
  check('Cookie: lang=zh; _gat=1; theme=dark-mode-long', [])
  check(`Cookie: mine=${STOKEN}`, [], { cookies: { keep: ['mine'] } })
  check(`MY_SSO=${STOKEN}`, [STOKEN], { cookies: { names: ['MY_SSO'] } })
})

test('a JWT cookie value is one COOKIE placeholder, not a TOKEN inside it', () => {
  const { masker } = setup()
  const out = masker.maskText(`Cookie: auth=${JWT}`)
  assert.equal(out.n, 1)
  assert.match(out.text, /^Cookie: auth=\{\{COOKIE_[a-z2-7]{8}\}\}$/)
})

test('a masked cookie value becomes known', () => {
  const { masker } = setup()
  masker.maskText(`Cookie: BDUSS=${BDUSS}`)
  const out = masker.maskText(`log line ${BDUSS} seen`)
  assert.equal(out.n, 1)
  assert.equal(out.hits[0]?.by, 'known')
})

test('secrets off masks no cookie', () => {
  check(`Cookie: BDUSS=${BDUSS}`, [], { secrets: false })
})
