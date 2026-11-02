/**
 * The turn and step a session is at (docs/adr/0030). The gateway sees an HTTP
 * request, not the step that sent it: that is known one layer up, where the
 * agent appends `step/start` to the session log before it makes the call, and
 * `session/event` hands each committed entry to the plugin. A record names the
 * step so a reader can find the request in the trajectory; a value's
 * `messages.N` only says where inside one request it sat, and that index
 * shifts as the history is compacted (docs/adr/0028).
 */

/** Where a session was, as its last `step/start` said. */
export interface StepAt {
  /** The turn, counted from 1 as the trajectory counts them. */
  turn: number
  /** The step of that turn, counted from 1. */
  step: number
}

/**
 * The most sessions a book holds. One entry a session, so a run that opens
 * many of them (subagents) cannot grow it without bound; the oldest goes
 * first, and a request from a session it forgot is recorded without a step.
 */
export const MAX_BOOK_SESSIONS = 500

/** A session's id, when the subject of a `session/event` names one. */
function idOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The turn and step a `step/start` names; undefined for any other entry, or one that names neither. */
function stepOf(event: unknown): StepAt | undefined {
  const e = event as { type?: unknown; data?: unknown } | null | undefined
  if (e?.type !== 'step/start') return undefined
  const data = e.data as { turn?: unknown; step?: unknown } | null | undefined
  const turn = data?.turn
  const step = data?.step
  // a step is one the trajectory counts from 1: anything else is not read as one
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) return undefined
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 1) return undefined
  return { turn, step }
}

/**
 * The turn and step each session is at, read from the host's session log. A
 * step stays until the next one starts, so a call the agent makes between
 * steps (a compaction, a title) is recorded as the step nearest it.
 */
export class StepBook {
  /** One entry a session, in the order they were last spoken for. */
  readonly #by = new Map<string, StepAt>()

  /** Reads one `session/event` into the book; every entry but a `step/start` leaves it as it is. */
  observe(session: unknown, event: unknown): void {
    const id = idOf(session)
    const at = stepOf(event)
    if (id === undefined || at === undefined) return
    // met again: moved to the end, so the first entry is the one forgotten first
    this.#by.delete(id)
    this.#by.set(id, at)
    if (this.#by.size > MAX_BOOK_SESSIONS) {
      const oldest = this.#by.keys().next()
      if (!oldest.done) this.#by.delete(oldest.value)
    }
  }

  /** Where `session` was at its last `step/start`; undefined for one the book never read one for. */
  at(session: string): StepAt | undefined {
    return this.#by.get(session)
  }

  clear(): void {
    this.#by.clear()
  }
}
