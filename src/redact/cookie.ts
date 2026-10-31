/**
 * COOKIE (design §5.5; magpie has no such rule): a cookie's value has no
 * form of its own (BDUSS's and JSESSIONID's are any string), so it is found
 * by where it is and by its name. Only the value is masked and each value
 * on its own: Cookie: BDUSS={{COOKIE_…}}; lang=zh-CN keeps the names, so
 * the model knows which cookies there are and can send just one.
 */
import type { Found } from './ids.ts'

export interface CookieOptions {
  /** Cookie names masked wherever NAME=value is written, beside the built-in list. */
  names?: readonly string[]
  /** Cookie names never masked. */
  keep?: readonly string[]
}

/** The shortest value masked, as for a known value (MIN_KNOWN): lang=zh and _gat=1 stay. */
const MIN_VALUE = 8

/** High-value cookies, masked wherever NAME=value is written (dsh_auth: dsh-auth-gateway's login cookie). */
export const COOKIE_NAMES = [
  'BDUSS', 'BDUSS_BFESS', 'STOKEN', 'PTOKEN', 'JSESSIONID', 'PHPSESSID', 'ASP.NET_SessionId',
  'connect.sid', 'sessionid', 'laravel_session', '_session_id', 'dsh_auth',
]
export const DEFAULT_COOKIE_KEEP = ['lang', 'locale', 'theme', 'tz']

const TOKEN = /[!#$%&'*+.^_`|~0-9A-Za-z-]/
/** Where a value ends: a pair's ;, a space, a quote, a backslash (an escaped quote in JSON text). */
const VALUE_END = ';\t\n\r "\'`\\'
/** Where an unquoted cookie string ends: its line's end or a quote around it. */
const REGION_END = '\n\r"\'`\\'
/** Where a named cookie's value ends: as a pair's does, or at a query's & or markup. */
const NAMED_END = VALUE_END + '&<>,'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Ctx {
  s: string
  keep: ReadonlySet<string>
  out: Found[]
  next: Next
}

/**
 * Where the next of some characters is in one string, remembered: asked again
 * from a later place that is not past the one found, the answer is the same.
 * A text with a cookie field on every line asks from each of them, and
 * scanning to the end each time was quadratic.
 */
class Next {
  readonly #s: string
  readonly #memo = new Map<string, [from: number, at: number]>()

  constructor(s: string) {
    this.#s = s
  }

  /** s.indexOf(needle, i), or s.length where there is none. */
  index(needle: string, i: number): number {
    return this.#find(`=${needle}`, i, () => {
      const at = this.#s.indexOf(needle, i)
      return at < 0 ? this.#s.length : at
    })
  }

  /** The first place at or after i whose character is one of `set`, or s.length. */
  any(set: string, i: number): number {
    return this.#find(`[${set}`, i, () => {
      let k = i
      while (k < this.#s.length && !set.includes(this.#s[k] as string)) k++
      return k
    })
  }

  #find(key: string, i: number, scan: () => number): number {
    const m = this.#memo.get(key)
    if (m && i >= m[0] && i <= m[1]) return m[1]
    const at = scan()
    this.#memo.set(key, [i, at])
    return at
  }
}

/** The value s[a:b] of cookie `name`, masked unless kept or short; an outer pair of double quotes stays. */
function value(c: Ctx, name: string, a: number, b: number): void {
  if (c.s[a] === '"' && b - a >= 2 && c.s[b - 1] === '"') {
    a++
    b--
  }
  if (b - a < MIN_VALUE || c.keep.has(name.toLowerCase())) return
  c.out.push({ start: a, end: b, kind: 'COOKIE', by: 'cookie', head: name })
}

/**
 * The pairs of a cookie string in s[from:to] (a Cookie: header's, curl -b's):
 * name=value; name=value … until a piece that is no pair (the prose after
 * it). `first` takes only the first, as Set-Cookie's attributes are no
 * cookies. Where it stopped reading.
 */
function pairs(c: Ctx, from: number, to: number, first: boolean): number {
  const s = c.s
  let i = from
  while (i < to) {
    while (i < to && (s[i] === ' ' || s[i] === '\t' || s[i] === ';')) i++
    const ns = i
    while (i < to && TOKEN.test(s[i] as string) && s[i] !== "'") i++
    if (i === ns || s[i] !== '=') break
    const name = s.slice(ns, i)
    const vs = ++i
    if (s[i] === '"') {
      const q = c.next.index('"', i + 1)
      i = q < to ? q + 1 : to
    } else {
      i = Math.min(c.next.any(VALUE_END, i), to)
    }
    value(c, name, vs, i)
    if (first) break
  }
  return i
}

/** The end of an unquoted cookie string that starts at s[i]. */
function regionEnd(c: Ctx, i: number): number {
  return c.next.any(REGION_END, i)
}

/** The end of the quoted string whose opening quote ends at s[i-1]: its closing quote (`quote`, \" for \"), or the line's end. */
function quotedEnd(c: Ctx, i: number, quote: string): number {
  return Math.min(c.next.index(quote, i), c.next.index('\n', i))
}

/**
 * A name starts where a run of name characters does, and is at most 64 of
 * them on each side of cookie: tried from every place in a long run, the
 * pattern read the rest of it each time.
 */
const NAMED_FIELD = /(?<![A-Za-z0-9_.$-])([A-Za-z0-9_.$-]{0,64}cookies?[A-Za-z0-9_$-]{0,64})(\\?["'])?[ \t]*[:=][ \t]*/gi
const DICT_PAIR = /\\?["']([^"'\\\n]{1,128})\\?["'][ \t]*:[ \t]*\\?["']([^"'\\\n]*)\\?["']/dg

/** A field whose name has cookie in it: Cookie: …, Set-Cookie: …, "cookie": "…", BAIDU_COOKIE=…, document.cookie = "…", cookies={"BDUSS": "…"}. */
function namedFields(c: Ctx): void {
  const s = c.s
  // a field inside the cookie string read before is one of its pairs, read already
  let read = 0
  for (const m of s.matchAll(NAMED_FIELD)) {
    if (m.index < read) continue
    const name = (m[1] as string).toLowerCase()
    const first = name.endsWith('set-cookie')
    let i = m.index + m[0].length
    if (s[i] === '{') {
      // a dict of cookies by name: {"BDUSS": "…", "STOKEN": "…"}
      const close = s.indexOf('}', i)
      const end = close < 0 ? Math.min(s.length, i + 4096) : close
      for (const d of s.slice(i, end).matchAll(DICT_PAIR)) {
        const g = (d.indices as Array<[number, number]>)[2] as [number, number]
        value(c, d[1] as string, i + g[0], i + g[1])
      }
      read = end
      continue
    }
    let quote = ''
    if (s[i] === '\\' && (s[i + 1] === '"' || s[i + 1] === "'")) quote = s.slice(i, i + 2)
    else if (s[i] === '"' || s[i] === "'" || s[i] === '`') quote = s[i] as string
    i += quote.length
    read = pairs(c, i, quote ? quotedEnd(c, i, quote) : regionEnd(c, i), first)
  }
}

const CURL_COOKIE = /(?:^|\s)(?:-b|--cookie)(?:[ \t]+|=)(\\?["'])?/g

/** curl -b 'a=…; b=…' and --cookie '…'; an argument with no = is a cookie file's name. */
function curlCookies(c: Ctx): void {
  const s = c.s
  for (const m of s.matchAll(CURL_COOKIE)) {
    const quote = m[1] ?? ''
    const i = m.index + m[0].length
    const end = quote ? quotedEnd(c, i, quote) : (() => { let k = i; while (k < s.length && !/\s/.test(s[k] as string)) k++; return k })()
    if (!s.slice(i, end).includes('=')) continue
    pairs(c, i, end, false)
  }
}

const COOKIES_TXT = /^(?:#HttpOnly_)?[^\t\n#][^\t\n]*\t(?:TRUE|FALSE)\t[^\t\n]*\t(?:TRUE|FALSE)\t\d+\t([^\t\n]+)\t([^\t\r\n]*)/gm

/** A Netscape cookies.txt line: seven columns split by tabs, the seventh the value. */
function cookiesTxt(c: Ctx): void {
  for (const m of c.s.matchAll(COOKIES_TXT)) {
    const v = m[2] as string
    const end = m.index + m[0].length
    value(c, m[1] as string, end - v.length, end)
  }
}

const FLAT_OBJECT = /\{[^{}]{1,4000}\}/g
const OBJ_FIELD = /\\?"(name|value|domain|httpOnly)\\?"[ \t]*:[ \t]*(\\?"([^"\\\n]*)\\?"|true|false)/dgi

/**
 * A cookie as an export writes it (Playwright storageState, HAR, a browser
 * extension's): an object with name and value, and domain or httpOnly. A
 * HAR header object {"name": "Cookie", "value": "…"} is a Cookie: line.
 */
function cookieObjects(c: Ctx): void {
  const s = c.s
  for (const o of s.matchAll(FLAT_OBJECT)) {
    const text = o[0]
    if (!/value/i.test(text) || !/name/i.test(text)) continue
    let name: string | undefined
    let val: [number, number] | undefined
    let cookieish = false
    for (const f of text.matchAll(OBJ_FIELD)) {
      const key = (f[1] as string).toLowerCase()
      if (key === 'domain' || key === 'httponly') cookieish = true
      if (f[3] === undefined) continue
      if (key === 'name') name = f[3]
      if (key === 'value') {
        const g = (f.indices as Array<[number, number]>)[3] as [number, number]
        val = [o.index + g[0], o.index + g[1]]
      }
    }
    if (name === undefined || !val) continue
    const lower = name.toLowerCase()
    if (lower === 'cookie' || lower === 'set-cookie') pairs(c, val[0], val[1], lower === 'set-cookie')
    else if (cookieish) value(c, name, val[0], val[1])
  }
}

function namedCookies(c: Ctx, plan: CookiePlan): void {
  const s = c.s
  // a name inside the value read before is part of that value
  let read = 0
  for (const m of s.matchAll(plan.named)) {
    if (m.index < read) continue
    const vs = m.index + m[0].length
    let i = vs
    if (m[0].endsWith('=') && s[i] === '"') {
      i = Math.min(c.next.index('"', i + 1) + 1, s.length)
    } else {
      i = c.next.any(NAMED_END, i)
    }
    value(c, m[1] as string, vs, i)
    read = i
  }
}

/** What a set of cookie options comes to, made once for the run: the names to look for and the one regex matching them. */
interface CookiePlan {
  names: readonly string[]
  keep: ReadonlySet<string>
  named: RegExp
}

const planFor = (options: CookieOptions | undefined): CookiePlan => {
  const names = [...COOKIE_NAMES, ...(options?.names ?? []).map((n) => n.trim()).filter((n) => n !== '')]
  return {
    names,
    keep: new Set((options?.keep ?? DEFAULT_COOKIE_KEEP).map((n) => n.trim().toLowerCase())),
    named: new RegExp(
      `(?:^|[^A-Za-z0-9_.-])(${names.map(escapeRe).join('|')}|__Secure-[A-Za-z0-9_.-]+|__Host-[A-Za-z0-9_.-]+)(?:=|\\\\?["'][ \\t]*:[ \\t]*\\\\?["'])`,
      'g',
    ),
  }
}

/** Plans by the options they were made for: a masker keeps one set for its whole run. */
const plans = new WeakMap<CookieOptions, CookiePlan>()
const planless = planFor(undefined)

function planOf(options: CookieOptions | undefined): CookiePlan {
  if (options === undefined) return planless
  let plan = plans.get(options)
  if (plan === undefined) {
    plan = planFor(options)
    plans.set(options, plan)
  }
  return plan
}

/** Where `s` has a cookie's value: by its context, then by its name. */
export function cookieSpans(s: string, options: CookieOptions | undefined, lower: () => string): Found[] {
  const plan = planOf(options)
  const names = plan.names
  const c: Ctx = { s, keep: plan.keep, out: [], next: new Next(s) }
  const l = lower()
  if (l.includes('cookie')) {
    namedFields(c)
    if (/(?:-b|--cookie)/.test(s)) curlCookies(c)
  } else if (/\s-b[ \t=]/.test(s)) curlCookies(c)
  if (s.includes('\tTRUE\t') || s.includes('\tFALSE\t')) cookiesTxt(c)
  if (l.includes('"value') || l.includes('\\"value')) cookieObjects(c)
  if (names.some((n) => s.includes(n)) || s.includes('__Secure-') || s.includes('__Host-')) namedCookies(c, plan)
  return c.out
}
