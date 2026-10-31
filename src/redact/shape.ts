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

/**
 * The prefixes a vendor puts before its keys' random part, kept as they are:
 * they say whose key it is and are the same in every key of the vendor, so
 * they are no secret. Longer ones first, so sk-proj- is taken before sk-.
 */
const KEY_PREFIXES = [
  'sk-ant-api03-', 'sk-ant-oat01-', 'sk-ant-admin01-', 'sk-proj-', 'sk-svcacct-', 'sk-admin-', 'sk-or-v1-', 'sk-ant-', 'sk-or-',
  'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-',
  'xoxa-', 'xoxb-', 'xoxo-', 'xoxp-', 'xoxr-', 'xoxs-', 'dop_v1_', 'whsec_', 'pypi-', 'gsk_', 'xai-', 'npm_', 'hf_', 'SG.',
  'AKIA', 'ASIA', 'AIza', 'LTAI', 'AKID', 'sk-',
].sort((a, b) => b.length - a.length)

/** A gateway's or a relay's own key prefix (oc_sk_, or_sk_), as the API_KEY rule finds them. */
const RELAY_PREFIX = /^[a-z]{2,4}_sk_/

/**
 * The kinds whose values are vendors' keys, so a known prefix at their start
 * is the vendor's and not the value's own characters. A password or a named
 * secret that happens to start with ghp_ keeps it hidden.
 */
export const KEY_KINDS: ReadonlySet<string> = new Set(['API_KEY', 'TOKEN'])

/**
 * The start of v that names its kind and stays: one of KEY_PREFIXES or a
 * relay's prefix, nothing else. Letters before a - or _ in any other value
 * are its own characters and stay hidden.
 */
export function keyHead(v: string): string {
  for (const p of KEY_PREFIXES) if (v.startsWith(p)) return p
  return RELAY_PREFIX.exec(v)?.[0] ?? ''
}

/** keyHead for a value of `kind`: none unless the kind is a vendor's key. */
export function publicHead(kind: string, v: string): string {
  return KEY_KINDS.has(kind) ? keyHead(v) : ''
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
  const head = publicHead(kind, v)
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
