/**
 * The values behind the placeholders, in memory only (design §5.2): a
 * restart loses them, and the next request that has a value brings it back.
 * Past `maxValues` the half used longest ago is let go and the known index
 * is made again (magpie `makeRoom`).
 *
 * The known index (magpie known.go): a value masked once is masked again
 * wherever it shows up in a request, whatever is around it. The vendor
 * answers about a placeholder in words of its own ("the password is
 * {{SECRET_…}}"), the agent reads the value there, and on the next turn
 * that text comes back in the history where no rule matches it.
 */
import { ALNUM } from './checks.ts'

/** The shortest value matched as known: shorter ones would turn up all over ordinary text. */
export const MIN_KNOWN = 8

interface KnownValue {
  v: string
  p: string
  kind: string
}

export interface KnownSpan {
  start: number
  end: number
  kind: string
}

const BITS = 1 << 20

/** A 20-bit hash of the four characters at s[i]. */
function gram(s: string, i: number): number {
  const g = (s.charCodeAt(i) ^ (s.charCodeAt(i + 1) << 7) ^ (s.charCodeAt(i + 2) << 14) ^ (s.charCodeAt(i + 3) << 21)) >>> 0
  return Math.imul(g, 2654435761) >>> 12
}

function kindOf(p: string): string {
  const i = p.lastIndexOf('_')
  return i > 2 ? p.slice(2, i) : ''
}

/**
 * s[a:b] is the known value itself, not a piece of a longer one: a number
 * with no letter or digit beside it, an email not part of a longer address
 * (a full stop may end the sentence after it), a secret with no letter or
 * digit against it.
 */
function standsAlone(kind: string, s: string, a: number, b: number): boolean {
  const before = a > 0 ? (s[a - 1] as string) : ''
  const after = b < s.length ? (s[b] as string) : ''
  const is = (c: string, set: string): boolean => c !== '' && set.includes(c)
  switch (kind) {
    case 'PHONE': case 'BANK_CARD': case 'ID_CARD':
      return !is(before, ALNUM) && !is(after, ALNUM)
    case 'EMAIL':
      if (is(before, ALNUM + '._%+-') || is(after, ALNUM + '_%+')) return false
      return !is(after, '.-') || b + 1 >= s.length || !is(s[b + 1] as string, ALNUM)
  }
  return !(is(before, ALNUM) && is(s[a] as string, ALNUM)) && !(is(after, ALNUM) && is(s[b - 1] as string, ALNUM))
}

export class ValueTable {
  readonly maxValues: number
  /** placeholder → value, the least recently used first. */
  #values = new Map<string, string>()
  #kinds = new Set<string>()
  #known = new Map<string, KnownValue[]>()
  #bits = new Uint32Array(BITS / 32)
  /** Changes whenever the known index does: a remembered known match is good only at the generation it was made at. */
  generation = 0

  constructor(maxValues: number) {
    this.maxValues = maxValues
  }

  get size(): number {
    return this.#values.size
  }

  /** Remembers `value` behind `placeholder`, or marks it used now. */
  put(placeholder: string, kind: string, value: string): void {
    if (this.#values.has(placeholder)) {
      this.#values.delete(placeholder)
      this.#values.set(placeholder, value)
      return
    }
    this.#makeRoom()
    this.#values.set(placeholder, value)
    this.#kinds.add(kind)
    this.#addKnown(placeholder, value)
  }

  get(placeholder: string): string | undefined {
    return this.#values.get(placeholder)
  }

  /** The kinds a placeholder has been made for. */
  kinds(): ReadonlySet<string> {
    return this.#kinds
  }

  /** Where s has a known value whose kind `covers` takes; where two start at one place, the longer. */
  knownSpans(s: string, covers: (kind: string) => boolean): KnownSpan[] {
    if (this.#known.size === 0 || s.length < MIN_KNOWN) return []
    const out: KnownSpan[] = []
    for (let i = 0; i + MIN_KNOWN <= s.length; i++) {
      const g = gram(s, i)
      if ((((this.#bits[g >>> 5] as number) >>> (g & 31)) & 1) === 0) continue
      const bucket = this.#known.get(s.slice(i, i + MIN_KNOWN))
      if (!bucket) continue
      let best: KnownValue | undefined
      for (const k of bucket) {
        if (!covers(k.kind)) continue
        if ((best && k.v.length <= best.v.length) || !s.startsWith(k.v, i) || !standsAlone(k.kind, s, i, i + k.v.length)) continue
        best = k
      }
      if (best) {
        out.push({ start: i, end: i + best.v.length, kind: best.kind })
        i += best.v.length - 1
      }
    }
    return out
  }

  #addKnown(p: string, v: string): void {
    const kind = kindOf(p)
    // the user's own words match anywhere already
    if (kind === 'TERM' || v.length < MIN_KNOWN) return
    const head = v.slice(0, MIN_KNOWN)
    const bucket = this.#known.get(head)
    if (bucket) {
      const i = bucket.findIndex((k) => k.v === v)
      if (i >= 0) {
        // one value under two kinds: the same one wins whichever came first
        if (p < (bucket[i] as KnownValue).p) {
          bucket[i] = { v, p, kind }
          this.generation++
        }
        return
      }
      bucket.push({ v, p, kind })
    } else {
      this.#known.set(head, [{ v, p, kind }])
    }
    const g = gram(v, 0)
    this.#bits[g >>> 5] = ((this.#bits[g >>> 5] as number) | (1 << (g & 31))) >>> 0
    this.generation++
  }

  #makeRoom(): void {
    if (this.#values.size < this.maxValues) return
    let drop = Math.floor(this.#values.size / 2)
    for (const k of this.#values.keys()) {
      if (drop-- <= 0) break
      this.#values.delete(k)
    }
    this.#known = new Map()
    this.#bits.fill(0)
    this.generation++
    for (const [p, v] of this.#values) this.#addKnown(p, v)
  }
}
