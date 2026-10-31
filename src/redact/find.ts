/**
 * Finding values in one string (magpie redact.go `mask`, before `apply`):
 * the rules, the user's words, the values known from before, and the
 * checks that drop a find by where it sits.
 */
import { createHash } from 'node:crypto'

import type { Found } from './ids.ts'
import type { KnownSpan } from './known.ts'
import type { Rule } from './rules.ts'

/** s with its ASCII letters in lower case, as long as s, so a place in one is the same place in the other. */
export function lowerASCII(s: string): string {
  return s.replace(/[A-Z]+/g, (c) => c.toLowerCase())
}

/** Whether r's value s[a:b] is one it masks: nothing it may not touch beside it, and its checks pass. */
function takes(r: Rule, s: string, a: number, b: number): boolean {
  if (b <= a) return false
  if (r.bound && ((a > 0 && r.bound.includes(s[a - 1] as string)) || (b < s.length && r.bound.includes(s[b] as string)))) return false
  if (r.ok && !r.ok(s.slice(a, b))) return false
  return !r.at || r.at(s, a, b)
}

type Indexed = RegExpExecArray & { indices?: Array<[number, number] | undefined> }

function push(r: Rule, s: string, m: Indexed, out: Found[]): void {
  const g = m.length > 1 ? m.indices?.[1] : undefined
  const a = g ? g[0] : m.index
  const b = g ? g[1] : m.index + m[0].length
  if (takes(r, s, a, b)) out.push({ start: a, end: b, kind: r.kind, by: 'rule' })
}

/** The values r finds in s; `lower` is lowerASCII(s), made once for all the rules. */
export function ruleSpans(r: Rule, s: string, lower: () => string): Found[] {
  if (r.markers && !r.markers.some((m) => s.includes(m))) return []
  const out: Found[] = []
  if (r.fold) {
    const l = lower()
    if (!r.fold.some((m) => l.includes(m))) return []
    if (r.anchor) {
      // the sticky pattern tried where a marker is, once per place
      const tried = new Set<number>()
      for (const f of r.fold) {
        for (let at = l.indexOf(f); at >= 0; at = l.indexOf(f, at + 1)) {
          const from = r.anchor(s, at)
          if (from < 0 || tried.has(from)) continue
          tried.add(from)
          r.re.lastIndex = from
          const m = r.re.exec(s) as Indexed | null
          if (m) push(r, s, m, out)
        }
      }
      return out
    }
  }
  for (const m of s.matchAll(r.re)) push(r, s, m as Indexed, out)
  return out
}

/** Where s has one of the user's words, as written (magpie `Options.Words`, whole words and case folding off). */
export function wordSpans(s: string, words: readonly string[]): Found[] {
  const out: Found[] = []
  for (const raw of words) {
    const w = raw.trim()
    if (w.length < 2) continue
    for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + w.length)) {
      out.push({ start: i, end: i + w.length, kind: 'TERM', by: 'word' })
    }
  }
  return out
}

/**
 * `s`, JSON text, as long as `s` and read as the vendor reads it once
 * unescaped, as far as the finders tell: the letter of \n, \t, \r, \b, \f is
 * read as a line break and a \u escape's u and digits too, so none of them
 * starts or ends a value (magpie `unescapedView`).
 */
export function unescapedView(s: string): string {
  if (!s.includes('\\')) return s
  const b = s.split('')
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] !== '\\') continue
    i++
    switch (b[i]) {
      case 'n': case 'b': case 'f': b[i] = '\n'; break
      case 'r': b[i] = '\r'; break
      case 't': b[i] = '\t'; break
      case 'u':
        for (let j = i; j < i + 5 && j < b.length; j++) b[j] = '\n'
        i += 4
        break
    }
  }
  return b.join('')
}

/** `found` with no value starting or ending inside one of the escapes of `s`: each is cut back to the escape's edge. */
export function outsideEscapes(s: string, found: Found[]): Found[] {
  if (found.length === 0 || !s.includes('\\')) return found
  const inside: Array<[number, number] | undefined> = new Array(s.length + 1)
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue
    const end = Math.min(i + (s[i + 1] === 'u' ? 6 : 2), s.length)
    for (let j = i + 1; j < end; j++) inside[j] = [i + 1, end]
    i = end - 1
  }
  const out: Found[] = []
  for (const f of found) {
    let { start, end } = f
    const a = inside[start]
    if (a) start = a[1]
    const z = inside[end]
    if (z) end = z[0] - 1
    if (start < end) out.push({ ...f, start, end })
  }
  return out
}

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

/** s[a:b], JSON text outside its strings, is all of one bare value, with the , } or ] that ends it after it. */
function bareValue(s: string, a: number, b: number): boolean {
  if (a >= b || /[ \t\r\n{}[\]",:]/.test(s.slice(a, b))) return false
  let i = a - 1
  while (i >= 0 && isSpace(s[i])) i--
  let k = b
  while (k < s.length && isSpace(s[k])) k++
  return i >= 0 && ':[,'.includes(s[i] as string) && (k === s.length || ',}]'.includes(s[k] as string))
}

/**
 * `found`, for s JSON text (a tool call's arguments), with each value inside
 * the one string it starts in, so the arguments stay JSON: masked over a
 * quote, a vendor turns away every turn that replays the call (magpie
 * `inStrings`). A whole bare value is kept and goes in quoted.
 */
export function inStrings(s: string, found: Found[]): Found[] {
  if (found.length === 0) return found
  try {
    JSON.parse(s)
  } catch {
    return found
  }
  const where = new Int32Array(s.length)
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue
    n++
    let j = i + 1
    for (; j < s.length && s[j] !== '"'; j++) {
      where[j] = n
      if (s[j] === '\\' && j + 1 < s.length) where[++j] = n
    }
    i = j
  }
  const out: Found[] = []
  for (const f of found) {
    let a = f.start
    while (a < f.end && where[a] === 0) a++
    if (a === f.end) {
      if (bareValue(s, f.start, f.end)) out.push({ ...f, bare: true })
      continue
    }
    let b = a
    while (b < f.end && where[b] === where[a]) b++
    out.push({ ...f, start: a, end: b })
  }
  return out
}

/**
 * A text sent before goes again as it went (magpie known.go `sentSpans`):
 * the known values found in it the first time it was masked for a host are
 * the ones masked in it there from then on. An agent sends its whole
 * conversation every turn and a vendor caches it by its bytes; a value that
 * became known later, masked again in every earlier message, changed the
 * prefix and the cache was written whole instead of read. Masking it there
 * keeps nothing from the vendor: the text went to it as written. What is
 * remembered is a hash of the host, the options and the text, and the
 * places; nothing of a value.
 */
export class SentMemo {
  static readonly ENTRIES = 1 << 16
  #cur = new Map<string, KnownSpan[]>()
  #old = new Map<string, KnownSpan[]>()

  spans(route: string, options: string, s: string, find: () => KnownSpan[]): KnownSpan[] {
    const k = createHash('sha256').update(route).update('\0').update(options).update('\0').update(s).digest('base64')
    let sp = this.#cur.get(k)
    if (!sp) {
      sp = this.#old.get(k)
      if (sp) this.#add(k, sp) // still in use: kept past the next turnover
    }
    if (sp) return sp
    sp = find()
    this.#add(k, sp)
    return sp
  }

  #add(k: string, sp: KnownSpan[]): void {
    if (this.#cur.size >= SentMemo.ENTRIES) {
      this.#old = this.#cur
      this.#cur = new Map()
    }
    this.#cur.set(k, sp)
  }
}

/**
 * As much of a value as a record may keep (magpie `Hint`): its first
 * character, or a key's prefix up to where its random part starts (sk-,
 * ghp_), and how many characters it has.
 */
export function hint(kind: string, v: string, personal: boolean): { head: string; len: number } {
  const chars = [...v]
  const len = chars.length
  if (len < 2) return { head: '', len }
  let k = 1
  if (!personal && kind !== 'TERM' && len >= 16) {
    k = 0
    for (const c of chars) {
      if (k >= 4 || !/[A-Za-z_-]/.test(c)) break
      k++
      if (c === '-' || c === '_') break
    }
    k = Math.max(k, 1)
  }
  return { head: chars.slice(0, k).join(''), len }
}
