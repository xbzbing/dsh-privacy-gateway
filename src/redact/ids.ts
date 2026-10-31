/**
 * What is found but not masked by where it sits (magpie ids.go, redact.go
 * `noNumbers`): an id a backend made, and a number that is a piece of a
 * decimal or a bare JSON number.
 */
import { DIGITS, fieldWords, isWordChar } from './checks.ts'

export interface Found {
  start: number
  end: number
  kind: string
  /** Which finder found it: rule, word, known, cookie. */
  by: Finder
  /** What the record keeps of it in place of its first character (a cookie's name). */
  head?: string
  /** A whole bare value of JSON text, whose placeholder goes in quoted. */
  bare?: boolean
}

export type Finder = 'rule' | 'word' | 'known' | 'cookie'

/** The kinds of personal data (Options.personal); any other is a secret's. */
export const PERSONAL_KINDS = new Set(['EMAIL', 'PHONE', 'ID_CARD', 'BANK_CARD'])

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const hexOrHyphen = (c: string | undefined): boolean => c !== undefined && /[-0-9a-fA-F]/.test(c)

/** A hash's hex digits short of 32: 16 to 31 in one case, letters and digits both (5d41402abc4b2a76). */
function digestShaped(v: string): boolean {
  if (v.length < 16 || v.length >= 32) return false
  let lower = 0
  let upper = 0
  let digits = 0
  for (const c of v) {
    if (c >= '0' && c <= '9') digits++
    else if (c >= 'a' && c <= 'f') lower++
    else if (c >= 'A' && c <= 'F') upper++
    else return false
  }
  const min = Math.max(3, Math.floor(v.length / 8))
  return (lower === 0 || upper === 0) && lower + upper >= min && digits >= min
}

function idShaped(v: string): boolean {
  return UUID.test(v) || (v.length >= 32 && !v.includes('-')) || digestShaped(v)
}

function elementField(words: string[]): boolean {
  return words.length === 2 && words[0] === 'element' && words[1] === 'token'
}

/** cua-driver's element token (s0000002a:14), or its snapshot's part as an element_token field's value. */
function elementToken(s: string, a: number, b: number): boolean {
  if (b - a < 9 || s[a] !== 's' || (a > 0 && isWordChar(s[a - 1]))) return false
  if (!/^[0-9a-f]{8}$/.test(s.slice(a + 1, a + 9))) return false
  let end = a + 9
  if (s[end] === ':') {
    let i = end + 1
    while (i < s.length && s[i]! >= '0' && s[i]! <= '9') i++
    if (i === end + 1) return false
    end = i
  }
  if ((b !== a + 9 && b !== end) || (end < s.length && isWordChar(s[end]))) return false
  return end > a + 9 || elementField(fieldWords(s, a))
}

/** The id s[a:b] is in, or is: a UUID, 32 hex digits or more, a short digest, or an element token. */
function idAround(s: string, a: number, b: number): [number, number] | undefined {
  if (elementToken(s, a, b)) return [a, b]
  let l = a
  let r = b
  while (l > 0 && hexOrHyphen(s[l - 1])) l--
  while (r < s.length && hexOrHyphen(s[r])) r++
  while (l < r && s[l] === '-') l++
  while (r > l && s[r - 1] === '-') r--
  const v = s.slice(l, r)
  if (a < l || b > r || !/^[-0-9a-fA-F]*$/.test(v) || !idShaped(v)) return undefined
  if (digestShaped(v) && ((l > 0 && isWordChar(s[l - 1])) || (r < s.length && isWordChar(s[r])))) return undefined
  return [l, r]
}

/** s[l:r] is a JSON object's key ({"5d41402abc4b2a76": …}), never a secret. */
export function nameOfField(s: string, l: number, r: number): boolean {
  if (l === 0 || s[l - 1] !== '"') return false
  let i = r
  if (s[i] === '\\') i++
  if (s[i] !== '"') return false
  i++
  while (s[i] === ' ' || s[i] === '\t') i++
  return s[i] === ':'
}

function keyPhrase(s: string, at: number): boolean {
  let before = s.slice(Math.max(0, at - 24), at).toLowerCase()
  const i = before.lastIndexOf('key')
  if (i < 0) return false
  before = before.slice(0, i).replace(/ +$/, '')
  return ['api', 'access', 'secret', 'private', 'signing', 'license', 'licence'].some(
    (w) => before.endsWith(w) && (before.length === w.length || !isWordChar(before[before.length - w.length - 1])),
  )
}

const NOT_CREDENTIAL = new Set(
  ('page next cursor continuation csrf xsrf trace request idempotency sync nonce hash digest checksum sha fingerprint etag ' +
    'cache commit object blob file content revision rev partition shard bucket dedup dedupe lookup row sort').split(' '),
)

/** The field whose value starts at s[at] is named for a credential (refresh_token, DB_PASSWORD), not an id, a cursor or a bare key. */
function credentialField(s: string, at: number): boolean {
  const words = fieldWords(s, at)
  if (words.length === 1 && words[0] === 'key' && keyPhrase(s, at)) return true
  if ((words.length < 2 && (words.length === 0 || words[0] === 'key')) || elementField(words)) return false
  if (['id', 'ids', 'uuid', 'guid'].includes(words[words.length - 1] as string)) return false
  return !words.some((w) => NOT_CREDENTIAL.has(w))
}

/**
 * `found` without what is in an id of s (a UUID, a commit, a request's id):
 * a backend looks it up by every character, so a piece of one is never a
 * value, and a whole one is masked only as a credential in a field named
 * for one. What the user chose (their words) stays theirs.
 */
export function noIDs(s: string, found: Found[]): Found[] {
  return found.filter((f) => {
    if (f.by === 'word' || f.by === 'cookie') return true
    const id = idAround(s, f.start, f.end)
    if (!id) return true
    const [l, r] = id
    if (f.start > l || f.end < r) return false
    if (f.by === 'known') return !elementToken(s, l, r)
    switch (f.kind) {
      case 'PASSWORD': case 'API_KEY': case 'TOKEN': case 'PRIVATE_KEY':
        return true
      case 'SECRET':
        if (digestShaped(s.slice(l, r)) && fieldWords(s, l).length === 0) return true
        return credentialField(s, l)
    }
    return false
  })
}

/** s[a:b] starts with a decimal's fraction digit or ends with its whole part's (5.13800138000, 13800138000.5). */
function inDecimal(s: string, a: number, b: number): boolean {
  const d = (i: number): boolean => i >= 0 && i < s.length && DIGITS.includes(s[i] as string)
  return (d(a) && a >= 2 && s[a - 1] === '.' && d(a - 2)) || (d(b - 1) && b + 1 < s.length && s[b] === '.' && d(b + 1))
}

/** s[a:b] is all of a bare JSON number ("timestamp": 17929036837): a count or a time, not a phone. */
function jsonNumber(s: string, a: number, b: number): boolean {
  if (a >= b || !/^[0-9]+$/.test(s.slice(a, b))) return false
  const space = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  let k = b
  while (k < s.length && space(s[k])) k++
  if (k < s.length && !',}]'.includes(s[k] as string)) return false
  let i = a - 1
  while (i >= 0 && space(s[i])) i--
  if (i < 0) return false
  if (s[i] === ':') {
    for (i--; i >= 0 && space(s[i]); i--);
    return i >= 0 && s[i] === '"'
  }
  if (s[i] === '[' || s[i] === ',') {
    for (; i >= 0; i--) {
      if (s[i] === '[') return true
      if (!(DIGITS + ',.-+eE').includes(s[i] as string) && !space(s[i])) return false
    }
  }
  return false
}

/** `found` without personal data that is a piece of a decimal or a bare JSON number; a secret is masked wherever it is. */
export function noNumbers(s: string, found: Found[]): Found[] {
  return found.filter((f) => !(PERSONAL_KINDS.has(f.kind) && f.by !== 'word' && (inDecimal(s, f.start, f.end) || jsonNumber(s, f.start, f.end))))
}
