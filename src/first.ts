import type { StepAt } from './steps.ts'

/**
 * Where each value was first sent in a session (docs/adr/0030). A value met
 * while masking a request may have gone out long before: the record of the
 * request that carries it says which request that was, and this says which
 * one it was the first time. Kept in memory only, one entry a value a
 * session, so a run that masks many values cannot grow it without bound.
 */
export const MAX_FIRST_SENT = 5000

/** The key one session's value goes by; a placeholder is unique to its value, so the two name one value. */
function keyOf(session: string, placeholder: string): string {
  return `${session}\u0000${placeholder}`
}

export class FirstSending {
  /** One entry a value a session, in the order they were first sent. */
  readonly #by = new Map<string, StepAt>()

  /**
   * Notes that `placeholder` went out in `at`, and answers where it was first
   * sent: `at` itself when this is the first time, the place already kept
   * otherwise.
   */
  note(session: string, placeholder: string, at: StepAt): StepAt {
    const key = keyOf(session, placeholder)
    const first = this.#by.get(key)
    if (first !== undefined) return first
    this.#by.set(key, at)
    if (this.#by.size > MAX_FIRST_SENT) {
      const oldest = this.#by.keys().next()
      if (!oldest.done) this.#by.delete(oldest.value)
    }
    return at
  }

  /** Where `placeholder` was first sent in `session`; undefined for a value the run did not see sent yet. */
  get(session: string, placeholder: string): StepAt | undefined {
    return this.#by.get(keyOf(session, placeholder))
  }

  clear(): void {
    this.#by.clear()
  }
}
