/**
 * The rules that find secrets and personal data in a text, by magpie's
 * (internal/redact/redact.go `rules`) semantics, with the prefixes the
 * host's display mask knows added (design §5.1). A rule's value is its
 * pattern's group 1 when it has one, else all of what it matches.
 */
import { ALNUM, TOKEN_CH, fieldAt, keyAt, notASlug, notAVariable, secretValue } from './checks.ts'
import { chineseID, emailAt, hiddenInURL, luhn, phoneAt, realEmail } from './personal.ts'

export { ALNUM, TOKEN_CH, notASlug }

export interface Rule {
  kind: string
  /** Global regex; with the `d` flag where the value is group 1. */
  re: RegExp
  /** One of these is in any text the pattern can match: a cheap skip. */
  markers?: readonly string[]
  /**
   * Markers looked for in the text's ASCII lower case. With `anchor`, the
   * pattern (sticky) is tried only where one of them is, from the place
   * `anchor` gives (-1: not there), so a pattern that would backtrack over a
   * long text reads only what can match. JavaScript's regex engine is not
   * linear the way Go's RE2, which magpie's patterns were written for, is.
   */
  fold?: readonly string[]
  anchor?: (s: string, at: number) => number
  /** Characters that may not touch the value on either side: a key inside a longer word is no key. */
  bound?: string
  /** Checks the value further. */
  ok?: (value: string) => boolean
  /** Checks the value s[a:b] by what is around it. */
  at?: (s: string, a: number, b: number) => boolean
  /** What turns the rule on: the secrets, or personal data (off by default). */
  cat: 'secret' | 'personal'
}

const s = (r: Omit<Rule, 'cat'>): Rule => ({ ...r, cat: 'secret' })
const p = (r: Omit<Rule, 'cat'>): Rule => ({ ...r, cat: 'personal' })

/** A field's or a value's quote, if it has one: " or ', or \" in JSON written inside a string. */
const QUOTE = `(?:\\\\?["'])?`
/** The characters of a secret's value. */
const SECRET_CH = `[A-Za-z0-9_\\-./+=~!@#%^&*]`
/** What a field holding a secret has in its name: DB_PASSWORD, apiKey, x-api-key, client_secret. */
const SECRET_NAMES = ['password', 'passwd', 'secret', 'token', 'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'credential']

const CJK_PASSWORD_NAMES = ['密码', '密碼', '口令', 'PIN码', 'PIN碼', 'PIN 码', '安全码', '安全碼', 'パスワード', '暗証番号', '비밀번호', '암호', '비번']
const CJK_KEY_NAMES = [
  '密钥', '密鑰', '秘钥', '秘鑰', '私钥', '私鑰', '金钥', '金鑰', '令牌', '权杖', '權杖', '授权码', '授權碼',
  '秘密鍵', 'トークン', 'シークレット', 'APIキー', 'アクセスキー', '토큰', '비밀키', 'API 키', 'API키',
]

/** A value after one of names: after ：, :, =, 为, 為, 是, は or 는, quoted or not, or after nothing but a space. */
function cjkNamed(names: readonly string[]): RegExp {
  return new RegExp(
    `(?:${names.join('|')})[ \\t]*(?:[:：=][ \\t]*|[为為是][ \\t]*[:：]?[ \\t]*|は[ \\t]*|는[ \\t]*)?(?:\\\\?["'“「])?(${SECRET_CH}{3,63}[A-Za-z0-9_\\-/+=~!@#%^&*])`,
    'yid',
  )
}

const lower = (xs: readonly string[]): string[] => xs.map((x) => x.toLowerCase())

const NAME_CH = /[A-Za-z0-9_.-]/
const at = (_s: string, i: number): number => i
/** key alone: before its quote, if it has one, the text starts or a character no name has. */
const bareKey = (s: string, i: number): number => {
  let k = i
  if (s[k - 1] === '"' || s[k - 1] === "'") k--
  if (s[k - 1] === '\\') k--
  return k === 0 || !NAME_CH.test(s[k - 1] as string) ? k : -1
}
/** The scheme before :// (a letter, then letters, digits, +, . and -), where the URL starts. */
const scheme = (s: string, i: number): number => {
  let k = i
  while (k > 0 && i - k < 32 && /[A-Za-z0-9+.-]/.test(s[k - 1] as string)) k--
  while (k < i && !/[A-Za-z]/.test(s[k] as string)) k++
  return k < i ? k : -1
}
/** An address's local part, back from its @. */
const localPart = (s: string, i: number): number => {
  let k = i
  while (k > 0 && i - k <= 64 && /[A-Za-z0-9._%+-]/.test(s[k - 1] as string)) k--
  return k < i ? k : -1
}
const SECRET_STARTS = ['pass', 'secret', 'token', 'api', 'access', 'private', 'credential']

export const rules: readonly Rule[] = [
  s({ kind: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, markers: ['PRIVATE KEY'] }),
  s({ kind: 'API_KEY', re: /sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, markers: ['sk-'], bound: TOKEN_CH, ok: notASlug }),
  // a gateway's or a relay's own: oc_sk_…, or_sk_…
  s({ kind: 'API_KEY', re: /[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/g, markers: ['_sk_'], bound: TOKEN_CH, ok: secretValue }),
  s({ kind: 'API_KEY', re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/g, markers: ['gh', 'github_pat_', 'glpat-'], bound: TOKEN_CH }),
  s({ kind: 'API_KEY', re: /AIza[0-9A-Za-z_-]{35}/g, markers: ['AIza'], bound: TOKEN_CH }),
  s({ kind: 'API_KEY', re: /xox[abposr]-[0-9A-Za-z-]{10,}/g, markers: ['xox'], bound: TOKEN_CH }),
  s({ kind: 'API_KEY', re: /(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, markers: ['_live_', '_test_'], bound: TOKEN_CH }),
  s({ kind: 'API_KEY', re: /whsec_[A-Za-z0-9+/=]{24,}/g, markers: ['whsec_'], bound: TOKEN_CH }),
  s({ kind: 'API_KEY', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, markers: ['AKIA', 'ASIA'], bound: ALNUM }),
  // Alibaba Cloud's AccessKey ID and Tencent Cloud's SecretId: no word character after them
  s({ kind: 'API_KEY', re: /LTAI[0-9A-Za-z]{12,20}/g, markers: ['LTAI'], bound: ALNUM + '_' }),
  s({ kind: 'API_KEY', re: /AKID[0-9A-Za-z]{28,36}/g, markers: ['AKID'], bound: ALNUM + '_' }),
  s({
    kind: 'API_KEY',
    re: /(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g,
    markers: ['hf_', 'gsk_', 'xai-', 'npm_', 'pypi-', 'dop_v1_', 'SG.'],
    bound: TOKEN_CH,
  }),
  s({ kind: 'TOKEN', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, markers: ['eyJ'], bound: TOKEN_CH }),
  // the password of user:password@host, or of :password@host as a Redis URL has it with no user
  s({ kind: 'PASSWORD', re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:([^\s@/?#"'<>]{3,})@/dy, fold: ['://'], anchor: scheme, ok: notAVariable, at: hiddenInURL }),
  // password = …, API_KEY: "…", as .env files and configs have them
  s({
    kind: 'SECRET',
    re: new RegExp(`(?:${SECRET_NAMES.join('|')})[A-Za-z0-9_.-]{0,64}${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{8,})`, 'yid'),
    fold: SECRET_STARTS,
    anchor: at,
    ok: secretValue,
    at: fieldAt,
  }),
  // a field called key and nothing more ("key": "oc_sk_…"): only a long value of letters and digits both
  s({
    kind: 'SECRET',
    re: new RegExp(`${QUOTE}key${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{16,})`, 'yid'),
    fold: ['key'],
    anchor: bareKey,
    ok: secretValue,
    at: fieldAt,
  }),
  // a password after its name in Chinese, Japanese or Korean: 密码：786kih, 密碼是 hunter2
  s({ kind: 'PASSWORD', re: cjkNamed(CJK_PASSWORD_NAMES), fold: lower(CJK_PASSWORD_NAMES), anchor: at, ok: notAVariable }),
  // a key, a secret or a token after its name the same way: 密钥为 …, 令牌是 …
  s({ kind: 'SECRET', re: cjkNamed(CJK_KEY_NAMES), fold: lower(CJK_KEY_NAMES), anchor: at, at: keyAt }),
  // an English name before 为, 為, 是 or ：, as a Chinese message has it: apikey 为 …, token 是 …
  s({
    kind: 'SECRET',
    re: new RegExp(
      `(?:${SECRET_NAMES.join('|')}|pwd|api[ ]key|access[ ]key|secret[ ]key|key|\\bpin(?:[ ]?code)?)${QUOTE}[ \\t]*(?:[为為是][ \\t]*[:：]?|：)[ \\t]*(?:\\\\?["'“「])?(${SECRET_CH}{3,}[A-Za-z0-9_\\-/+=~!@#%^&*])`,
      'yid',
    ),
    markers: ['为', '為', '是', '：'],
    fold: [...SECRET_STARTS, 'pwd', 'key', 'pin'],
    anchor: at,
    at: keyAt,
  }),

  p({ kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y, fold: ['@'], anchor: localPart, bound: ALNUM + '_%+-', ok: realEmail, at: emailAt }),
  p({ kind: 'ID_CARD', re: /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, bound: ALNUM, ok: chineseID }),
  p({ kind: 'PHONE', re: /(?:\+?86[- ]?)?1[3-9]\d{9}/g, bound: ALNUM, at: phoneAt }),
  p({ kind: 'BANK_CARD', re: /[3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?/g, bound: ALNUM, ok: luhn }),
]

/** The secret rules alone: the three P0 key forms and the rest (kept for callers that want only them). */
export const secretRules: readonly Rule[] = rules.filter((r) => r.cat === 'secret')
