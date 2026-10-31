/**
 * The values behind the placeholders, in memory only: a restart loses them,
 * and the next request that has a value brings it back. Past `maxValues` the
 * oldest half is let go (a Map iterates in insertion order).
 *
 * The known index (a value masked once is masked wherever it shows up again,
 * whatever words are around it) belongs here too; it is not built yet.
 */
export class ValueTable {
  readonly maxValues: number
  #values = new Map<string, string>()
  #kinds = new Set<string>()

  constructor(maxValues: number) {
    this.maxValues = maxValues
  }

  get size(): number {
    return this.#values.size
  }

  put(placeholder: string, kind: string, value: string): void {
    if (this.#values.has(placeholder)) return
    this.#makeRoom()
    this.#values.set(placeholder, value)
    this.#kinds.add(kind)
  }

  get(placeholder: string): string | undefined {
    return this.#values.get(placeholder)
  }

  /** The kinds a placeholder has been made for. */
  kinds(): ReadonlySet<string> {
    return this.#kinds
  }

  #makeRoom(): void {
    if (this.#values.size < this.maxValues) return
    let drop = Math.floor(this.maxValues / 2)
    for (const k of this.#values.keys()) {
      if (drop-- <= 0) break
      this.#values.delete(k)
    }
  }
}
