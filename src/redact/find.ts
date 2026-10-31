/**
 * Finding values in one string (magpie redact.go `mask`, before `apply`):
 * the rules, the user's words, the values known from before, and the
 * checks that drop a find by where it sits.
 */
import { createHash } from 'node:crypto'

import type { Found } from './ids.ts'
import type { KnownSpan } from './known.ts'
import type { Rule } from './rules.ts'
import { publicHead } from './shape.ts'

/**
 * How much of a value a hint keeps, so a human can tell which one it was and
 * check the masking against the value: by the length of what follows any
 * public prefix, a few characters at the start and, once it is long enough
 * to spare them, a couple at the end. Never more than `hintMax` allows.
 */
function hintSpan(len: number): { keep: number; tail: number } {
  if (len < 6) return { keep: 1, tail: 0 }
  if (len < 10) return { keep: 2, tail: 0 }
  if (len < 16) return { keep: 3, tail: 1 }
  return { keep: 4, tail: 2 }
}

/**
 * The most characters of `len` (after any public prefix) a hint may show: at
 * least max(4, half of them) stay hidden, so a short value is never shown
 * whole or nearly whole (docs/adr/0019).
 */
export function hintMax(len: number): number {
  return Math.max(0, len - Math.max(4, Math.ceil(len / 2)))
}

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

/** What a named secret's value has, beside the quote and the backslash an escape wrote in JSON text. */
const VALUE_CH = /[A-Za-z0-9_\-./+=~!@#%^&*]/

/**
 * A JSON text read as the vendor reads it once unescaped, and where each of
 * its code units is in the text as written.
 */
export interface DecodedView {
  /** The text as the tool will get it: what a value known from before and a cookie are read in. */
  text: string
  /**
   * `text` with a quote or a backslash an escape wrote read as a character a
   * value holds (`~`) where the escape is followed by one, so a value with a
   * quote inside it is read whole instead of ending there. What the rules
   * are read in. The quote that closes a quoted value is followed by no
   * value's character and stays as it is.
   */
  match: string
  /** at[i]: where text[i] starts in the raw text; at[text.length] is the raw text's length. */
  at: Int32Array
}

const ESCAPED: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** What an escaped quote or backslash reads as where the rules are read, so one inside a value does not end it. */
const IN_VALUE = '~'

/**
 * `raw`, JSON text (a tool call's arguments), with its escapes read: \/ as /,
 * \u0026 as &, \n as a line break. The finders read a value as the tool will
 * get it, so a key, a known value or a word written with escapes is found
 * whole, and none starts or ends inside an escape. An escape JSON has not is
 * left as written.
 */
export function decodedView(raw: string): DecodedView {
  const text: string[] = []
  const match: string[] = []
  const at: number[] = []
  let last = 0
  let i = raw.indexOf('\\')
  while (i >= 0 && i + 1 < raw.length) {
    const c = raw[i + 1] as string
    let d: string | undefined = ESCAPED[c]
    let n = 2
    if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      d = String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16))
      n = 6
    }
    if (d === undefined) {
      // an escape JSON has not: as written
      i = raw.indexOf('\\', i + 2)
      continue
    }
    const literal = raw.slice(last, i)
    text.push(literal, d)
    match.push(literal, (d === '"' || d === '\\') && VALUE_CH.test(raw[i + n] ?? '') ? IN_VALUE : d)
    for (let k = last; k <= i; k++) at.push(k)
    last = i + n
    i = raw.indexOf('\\', last)
  }
  const tail = raw.slice(last)
  text.push(tail)
  match.push(tail)
  for (let k = last; k <= raw.length; k++) at.push(k)
  return { text: text.join(''), match: match.join(''), at: Int32Array.from(at) }
}

/**
 * `found` in the decoded view, as places in the raw text. A match that opens
 * on a quote an escape wrote leaves that quote outside it: the quote belongs
 * to the text, not to the value.
 */
export function inRaw(raw: string, view: DecodedView, found: Found[]): Found[] {
  return found.map((f) => {
    let start = view.at[f.start] as number
    const opened = raw[start] === '\\' && raw[start + 1] === '"' && VALUE_CH.test(raw[start + 2] ?? '')
    if (opened) start = (view.at[f.start + 1] as number) ?? start
    return { ...f, start, end: view.at[f.end] as number }
  })
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
 * As much of a value as a record may keep (magpie `Hint`, widened in
 * docs/adr/0019): a vendor key's prefix (sk-, ghp_, AKIA) and a few
 * characters after it, a couple of characters at the end once the value is
 * long enough, and how many characters it has. Two keys of one kind are told
 * apart, and a masked value is recognizable as the one that was there
 * (sk-proj-g6sx…3QaZ), while most of it never leaves the mask: of what follows
 * the prefix, at least max(4, half) characters stay hidden.
 */
export function hint(kind: string, v: string, personal: boolean): { head: string; tail?: string; len: number } {
  const chars = [...v]
  const len = chars.length
  if (len < 2) return { head: '', len }
  // personal data and the user's words: one character, they are not a key to recognize
  if (personal || kind === 'TERM') return { head: hintMax(len) >= 1 ? (chars[0] as string) : '', len }
  const prefix = [...publicHead(kind, v)].length
  const rest = len - prefix
  let { keep, tail } = hintSpan(rest)
  const max = hintMax(rest)
  // the tail goes first, then the head, until enough stays hidden
  if (keep + tail > max) tail = Math.max(0, max - keep)
  if (keep > max) keep = max
  const head = chars.slice(0, prefix + keep).join('')
  return tail > 0 ? { head, tail: chars.slice(-tail).join(''), len } : { head, len }
}
