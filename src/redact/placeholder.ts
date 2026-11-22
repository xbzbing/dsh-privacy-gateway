import { isWordChar } from './checks.ts'

/**
 * The placeholder protocol: `⟦DSH_REDACTED:KIND_hash⟧` (docs/adr/0037).
 *
 * The brackets are U+27E6 and U+27E7, which no template language writes and
 * no config file has, and the namespace says what the text is: a value the
 * gateway took out, not one a tool may use. `{{KIND_hash}}` read as a
 * placeholder only by the gateway: a Go template, Helm, Jinja and Vue all
 * write the same braces, so an agent could not tell one from its own
 * variables (issue #2).
 *
 * The kind and the hash stay joined by `_`, as they were inside the braces: a
 * colon there (`API_KEY:hash`) is exactly the `name: value` a secret rule
 * masks, and the gateway would mask its own placeholder a second time
 * wherever the protection in `mask.ts` did not reach — a placeholder inside a
 * placeholder, with the value's mapping lost.
 */

/** The namespace between the brackets: what tells a reader the text is a value the gateway took out. */
export const NAMESPACE = 'DSH_REDACTED'

/** The brackets around a placeholder. */
export const OPEN = '\u27E6'
export const CLOSE = '\u27E7'

/** The longest kind a placeholder names: the masker's own, and a user's rule. */
export const MAX_KIND = 24

/** The longest placeholder the masker writes: ⟦, the namespace, :, a kind, _, the 8 of the hash, ⟧. */
export const MAX_PLACEHOLDER = OPEN.length + NAMESPACE.length + 1 + MAX_KIND + 1 + 8 + CLOSE.length

/** A body, as the masker writes it and as a model may write it back in another case. */
const BODY = new RegExp(`${NAMESPACE}[ \\t]*:[ \\t]*([A-Za-z][A-Za-z0-9_]{0,${MAX_KIND - 1}})[ \\t]*_[ \\t]*([A-Za-z2-7]{8})`, 'gi')

/** Where a placeholder may start: its opening bracket, or the namespace with no bracket. */
const START = new RegExp(`${OPEN}|${NAMESPACE}`, 'gi')

/** A placeholder found in a text. */
export interface Found {
  /** Where it starts and ends, the brackets and the spaces inside them included. */
  start: number
  end: number
  kind: string
  hash: string
}

/**
 * The placeholder of `kind` with `hash`, whatever case it is given in. The
 * hash is the first 8 base32 characters of HMAC-SHA256(key, kind NUL value),
 * so the same value is the same placeholder every time (docs/adr/0002).
 */
export function format(kind: string, hash: string): string {
  return `${OPEN}${NAMESPACE}:${kind.toUpperCase()}_${hash.toLowerCase()}${CLOSE}`
}

/** The kind `p`, a placeholder, names; `''` where it names none. */
export function kindOf(p: string): string {
  BODY.lastIndex = 0
  const m = BODY.exec(p)
  return m ? (m[1] as string).toUpperCase() : ''
}

/**
 * Where `s` has a placeholder, left to right, none overlapping: the body the
 * masker writes, or one a model wrote back with a bracket changed, dropped or
 * spaced, or in another case. The span takes in the brackets and the spaces
 * inside them, so a value put back replaces them too.
 *
 * A body with no namespace is no placeholder: `API_KEY_k3v9x2mq` is also a
 * name and a word, and putting a value there is a guess. A guess that is
 * wrong sends a value where it was not meant to go; a placeholder left as it
 * is only fails to put one back.
 */
export function bodies(s: string): Found[] {
  const out: Found[] = []
  for (const m of s.matchAll(BODY)) {
    const a = m.index
    const z = a + m[0].length
    // the spaces inside the brackets go with them; one with no bracket beside
    // a word is part of a longer word, as a placeholder's body always was
    let start = a
    let after = a
    while (after > 0 && (s[after - 1] === ' ' || s[after - 1] === '\t')) after--
    const opened = after > 0 && s[after - 1] === OPEN
    if (opened) start = after - 1
    else if (start > 0 && isWordChar(s[start - 1] as string)) continue
    let end = z
    let before = z
    while (before < s.length && (s[before] === ' ' || s[before] === '\t')) before++
    const closed = before < s.length && s[before] === CLOSE
    if (closed) end = before + 1
    else if (end < s.length && isWordChar(s[end] as string)) continue
    out.push({ start, end, kind: m[1] as string, hash: m[2] as string })
  }
  return out
}

/** Whether `s` holds what reads as a placeholder: the brackets, or the namespace in any case. */
export function hasPlaceholder(s: string): boolean {
  return s.includes(OPEN) || s.toUpperCase().includes(NAMESPACE)
}

/**
 * How much of the end of `s` may be the start of a placeholder the next piece
 * of a stream finishes: from a ⟦ or a namespace on, up to a body that is not
 * whole yet, or a last word that starts the namespace (`d`, `ds`, `dsh_`).
 */
export function tailLen(s: string): number {
  const at = startOf(s)
  if (at >= 0) {
    const t = s.slice(at)
    if (t.length <= MAX_PLACEHOLDER + 4 && couldStart(t)) return t.length
  }
  // a word that is only the start of the namespace may go on as one; it is let
  // out unchanged where the next event is another text
  let i = s.length
  while (i > 0 && isWordChar(s[i - 1] as string)) i--
  const w = s.slice(i)
  if (w !== '' && w.length < NAMESPACE.length && NAMESPACE.startsWith(w.toUpperCase())) return w.length
  return 0
}

/** Where the last run that may open a placeholder starts, the bracket before its namespace included; -1 where none. */
function startOf(s: string): number {
  let open = -1
  let ns = -1
  for (const m of s.matchAll(START)) {
    if (s[m.index] === OPEN) open = m.index
    else ns = m.index
  }
  if (ns < 0) return open
  // the bracket right before the namespace is the placeholder's own start, and
  // a tail cut there must hold it too: `⟦DSH_REDACTED` is one run
  if (open >= 0 && open < ns && s.slice(open + 1, ns).trim() === '') return open
  return ns
}

/** Whether `t`, a tail of a text, may still become a placeholder with more characters after it. */
function couldStart(t: string): boolean {
  let i = 0
  if (t[i] === OPEN) i++
  i = skip(t, i)
  for (let k = 0; k < NAMESPACE.length; k++) {
    if (i >= t.length) return true
    if ((t[i] as string).toUpperCase() !== NAMESPACE[k]) return false
    i++
  }
  i = skip(t, i)
  if (i >= t.length) return true
  if (t[i] !== ':') return false
  const from = skip(t, i + 1)
  i = from
  while (i < t.length && isWordChar(t[i] as string)) i++
  const body = t.slice(from, i)
  if (body.length > MAX_KIND + 1 + 8) return false
  i = skip(t, i)
  // a closing bracket means the placeholder is whole and goes back now; any
  // other character after the body means this is text, not a placeholder
  if (i < t.length) return false
  // a whole body with no bracket yet is held: one bracket dropped is still one
  return true
}

function skip(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++
  return i
}
