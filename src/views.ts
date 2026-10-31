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
  /** The largest body kept, in UTF-16 code units (about bytes for JSON). */
  maxBody: number
  /** All bodies together. */
  maxTotal: number
}

export const VIEW_LIMITS: ViewLimits = { maxViews: 100, maxBody: 4 << 20, maxTotal: 64 << 20 }

export class ViewStore {
  readonly #limits: ViewLimits
  /** key → body, the oldest first. */
  readonly #views = new Map<number, string>()
  #total = 0

  constructor(limits: ViewLimits = VIEW_LIMITS) {
    this.#limits = limits
  }

  /** Keeps `body` for the record `key`; false when it is larger than one body may be. */
  put(key: number, body: string): boolean {
    if (body.length > this.#limits.maxBody) return false
    this.#views.set(key, body)
    this.#total += body.length
    for (const [k, b] of this.#views) {
      if (this.#views.size <= this.#limits.maxViews && this.#total <= this.#limits.maxTotal) break
      this.#views.delete(k)
      this.#total -= b.length
    }
    return true
  }

  get(key: number): string | undefined {
    return this.#views.get(key)
  }

  has(key: number): boolean {
    return this.#views.has(key)
  }

  /** The keys kept, the oldest first. */
  keys(): number[] {
    return [...this.#views.keys()]
  }

  get size(): number {
    return this.#views.size
  }
}

/** `text` with each warned value, as written in it, swapped for its placeholder. */
export function hideWarned(text: string, warned: ReadonlyArray<readonly [written: string, placeholder: string]>): string {
  let out = text
  for (const [w, p] of [...warned].sort((a, b) => b[0].length - a[0].length)) if (w !== '') out = out.split(w).join(p)
  return out
}
