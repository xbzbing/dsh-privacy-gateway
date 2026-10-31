import { createHmac } from 'node:crypto'

import { PERSONAL_KINDS } from './ids.ts'

/**
 * A secret can go to the vendor as a made-up key of its own form instead of a
 * placeholder (config `shape`, magpie shape.go): sk-w3axCByTQgK1Px… as
 * sk-hYQWRBFmdHNI…, with the same prefix, length and separators and the same
 * kind of character in each place. A check of a key's form passes, and the
 * model has no placeholder to remark on. It is made from the placeholder key
 * as a placeholder is, so one key goes as the same made-up one every turn and
 * a vendor's cache still matches, and it comes back as it was wherever the
 * vendor writes it (docs/adr/0015).
 *
 * Only a secret's kind, of MIN_SHAPE characters or more with MIN_RANDOM of
 * them made up (not its prefix or separators), and only letters, digits, -,
 * _ and .: a made-up key like that is in no other text by chance, and needs
 * no escaping in JSON. Anything else goes as a placeholder still.
 */

export const MIN_SHAPE = 8
const MIN_RANDOM = 6

/** Prefixes that name a key's kind across more than one part, kept as they are. */
const KEY_PREFIXES = ['sk-ant-api03-', 'sk-ant-oat01-', 'sk-ant-admin01-', 'sk-proj-', 'sk-svcacct-', 'sk-or-v1-', 'github_pat_']

/**
 * The start of v that names its kind and stays: one of KEY_PREFIXES, up to
 * four letters and the - or _ after them (sk-, ghp_, xoxb-), or AWS's AKIA
 * and ASIA. A head without its separator could be the key's own letters.
 */
export function keyHead(v: string): string {
  for (const p of KEY_PREFIXES) if (v.startsWith(p)) return p
  if (v.startsWith('AKIA') || v.startsWith('ASIA')) return v.slice(0, 4)
  for (let i = 0; i < v.length && i <= 4; i++) {
    const c = v[i] as string
    if ((c === '-' || c === '_') && i > 0) return v.slice(0, i + 1)
    if (!/[A-Za-z]/.test(c)) break
  }
  return ''
}

/** A name before = or : and the value after it. */
const NAMED_VALUE = /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:][ \t]*/

/** A value found with its name (OPENAI_API_KEY=sk-…): the name, which stays, and the key after it, which alone is made up. */
export function splitName(v: string): [name: string, key: string] {
  const m = NAMED_VALUE.exec(v)
  return m ? [m[0], v.slice(m[0].length)] : ['', v]
}

/** A character a made-up key may have. */
export function shapeChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9._-]/.test(c)
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGIT = '0123456789'

/** The made-up key `v` of `kind` goes as, or undefined where it goes as a placeholder. */
export function shapeOf(key: Uint8Array, kind: string, v: string): string | undefined {
  if (PERSONAL_KINDS.has(kind) || kind === 'TERM' || v.length < MIN_SHAPE || !/^[A-Za-z0-9._-]+$/.test(v)) return undefined
  const head = keyHead(v)
  const rest = v.slice(head.length)
  // a hex key's characters are any hex digit, of the case it has
  let hexLower = true
  let hexUpper = true
  for (const c of rest) {
    if (/[0-9._-]/.test(c)) continue
    if (/[a-f]/.test(c)) hexUpper = false
    else if (/[A-F]/.test(c)) hexLower = false
    else hexLower = hexUpper = false
  }
  const seed = createHmac('sha256', key).update(`shape\0${kind}\0${v}`, 'utf8').digest()
  let stream: Buffer = Buffer.alloc(0)
  let counter = 0
  const next = (k: number): number => {
    if (stream.length === 0) {
      const c = Buffer.alloc(8)
      c.writeBigUInt64BE(BigInt(counter++))
      stream = createHmac('sha256', seed).update(c).digest()
    }
    const b = stream[0] as number
    stream = stream.subarray(1)
    return b % k
  }
  let out = head
  let made = 0
  for (const c of rest) {
    let set = ''
    if (c === '-' || c === '_' || c === '.') set = ''
    else if (hexLower) set = DIGIT + 'abcdef'
    else if (hexUpper) set = DIGIT + 'ABCDEF'
    else if (/[A-Z]/.test(c)) set = UPPER
    else if (/[a-z]/.test(c)) set = LOWER
    else set = DIGIT
    if (set === '') {
      out += c
      continue
    }
    made++
    out += set[next(set.length)]
  }
  if (made < MIN_RANDOM || out === v) return undefined
  return out
}
