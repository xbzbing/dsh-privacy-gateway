import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The sessions whose masking the user turned off from the session's Privacy
 * tab (docs/adr/0023). Masking is on for every session unless it is listed
 * here. The list is kept in a small JSON file so the choice survives a
 * restart; when the file cannot be read or written the list still works for
 * this run.
 */

/** The most sessions kept; the oldest choices go first. */
export const MAX_SESSIONS = 1000

interface Logger {
  warn(...args: unknown[]): void
}

export class SessionSwitches {
  readonly #file: string | undefined
  readonly #logger: Logger | undefined
  /** Insertion order is the order the sessions were turned off. */
  readonly #off = new Set<string>()

  constructor(options: { file?: string; logger?: Logger } = {}) {
    this.#file = options.file
    this.#logger = options.logger
    if (this.#file) this.#load(this.#file)
  }

  /** Whether masking is off for `session`; a call without a session is never off. */
  isOff(session: string | undefined): boolean {
    return session !== undefined && session !== '' && this.#off.has(session)
  }

  /** Turns masking for `session` on or off; true when that changed anything. */
  set(session: string, on: boolean): boolean {
    if (session === '') return false
    const was = this.#off.has(session)
    if (on === !was) return false
    if (on) this.#off.delete(session)
    else {
      this.#off.add(session)
      for (const old of this.#off) {
        if (this.#off.size <= MAX_SESSIONS) break
        this.#off.delete(old)
      }
    }
    this.#save()
    return true
  }

  /** How many sessions have masking off. */
  get size(): number {
    return this.#off.size
  }

  #load(file: string): void {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger?.warn(`dsh-privacy-gateway: could not read ${file}`, err)
      return
    }
    try {
      const parsed = JSON.parse(raw) as { off?: unknown }
      const ids = Array.isArray(parsed?.off) ? parsed.off : []
      for (const id of ids.slice(-MAX_SESSIONS)) if (typeof id === 'string' && id !== '') this.#off.add(id)
    } catch (err) {
      this.#logger?.warn(`dsh-privacy-gateway: ${file} is not valid JSON; every session is masked`, err)
    }
  }

  #save(): void {
    const file = this.#file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ off: [...this.#off] })}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      this.#logger?.warn(`dsh-privacy-gateway: could not save ${file}; the choice holds until restart`, err)
    }
  }
}
