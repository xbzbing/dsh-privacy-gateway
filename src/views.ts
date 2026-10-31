/**
 * What the vendor got, kept for the side-by-side view (config `vendorView`,
 * design §7.5, docs/adr/0016): the body of a recorded request as it went,
 * by its record's key, in memory only, within magpie's bounds.
 *
 * A value a warn action sent as written is in the body the vendor got; the
 * copy kept here has it as the placeholder it would have had, so no value
 * reaches the card.
 */

export interface ViewLimits {
  /** Bodies kept. */
  maxViews: number
  /** The largest body kept, in UTF-8 bytes. */
  maxBody: number
  /** All bodies together, in UTF-8 bytes. */
  maxTotal: number
}

export const VIEW_LIMITS: ViewLimits = { maxViews: 100, maxBody: 4 << 20, maxTotal: 64 << 20 }

export class ViewStore {
  readonly #limits: ViewLimits
  /** key → body and its UTF-8 bytes, the oldest first. */
  readonly #views = new Map<number, { body: string; bytes: number }>()
  #total = 0

  constructor(limits: ViewLimits = VIEW_LIMITS) {
    this.#limits = limits
  }

  /** Keeps `body` for the record `key`; false when it is larger than one body may be. */
  put(key: number, body: string): boolean {
    // bytes, not string length: a CJK body takes three bytes a character, and the limits say what memory is used
    const bytes = Buffer.byteLength(body)
    if (bytes > this.#limits.maxBody) return false
    const had = this.#views.get(key)
    if (had) {
      // a body put again under its key replaces the old one, and goes last as the newest
      this.#views.delete(key)
      this.#total -= had.bytes
    }
    this.#views.set(key, { body, bytes })
    this.#total += bytes
    for (const [k, v] of this.#views) {
      if (this.#views.size <= this.#limits.maxViews && this.#total <= this.#limits.maxTotal) break
      this.#views.delete(k)
      this.#total -= v.bytes
    }
    return true
  }

  get(key: number): string | undefined {
    return this.#views.get(key)?.body
  }

  has(key: number): boolean {
    return this.#views.has(key)
  }

  /** The keys kept, the oldest first. */
  keys(): number[] {
    return [...this.#views.keys()]
  }

  /** Drops every body. */
  clear(): void {
    this.#views.clear()
    this.#total = 0
  }

  get size(): number {
    return this.#views.size
  }

  /** The UTF-8 bytes of every body kept. */
  get bytes(): number {
    return this.#total
  }
}

/** `text` with each warned value, as written in it, swapped for its placeholder. */
export function hideWarned(text: string, warned: ReadonlyArray<readonly [written: string, placeholder: string]>): string {
  let out = text
  for (const [w, p] of [...warned].sort((a, b) => b[0].length - a[0].length)) if (w !== '') out = out.split(w).join(p)
  return out
}
