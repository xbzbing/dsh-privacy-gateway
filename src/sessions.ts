import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  /** Choices whose write failed, by session and value: a later save must not drop them. */
  readonly #unsaved = new Map<string, boolean>()

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
    apply(this.#off, session, on)
    this.#save(session, on)
    return true
  }

  /** How many sessions have masking off. */
  get size(): number {
    return this.#off.size
  }

  #load(file: string): void {
    const ids = this.#read(file)
    if (ids) for (const id of ids) this.#off.add(id)
  }

  /** The sessions listed in `file`; undefined when it cannot be read or is not the list. */
  #read(file: string): string[] | undefined {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger?.warn(`dsh-privacy-gateway: could not read ${file}`, err)
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined
    }
    try {
      const parsed = JSON.parse(raw) as { off?: unknown }
      const ids = Array.isArray(parsed?.off) ? parsed.off : []
      return ids.slice(-MAX_SESSIONS).filter((id): id is string => typeof id === 'string' && id !== '')
    } catch (err) {
      this.#logger?.warn(`dsh-privacy-gateway: ${file} is not valid JSON; every session is masked`, err)
      return undefined
    }
  }

  /**
   * Writes the one change just made. Another dsh process may have saved its
   * own choices since this one read the file: the file is read again and only
   * this change applied to it, so a session another process turned back on
   * is not turned off again by this one's older copy. A choice this process
   * could not write earlier is applied too: it is still the user's, and the
   * next successful save carries it to the file. The merged list is this
   * process's from then on.
   */
  #save(session: string, on: boolean): void {
    const file = this.#file
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      const onDisk = this.#read(file)
      if (onDisk) {
        const merged = new Set(onDisk)
        for (const [id, state] of this.#unsaved) {
          if (id !== session) apply(merged, id, state)
        }
        apply(merged, session, on)
        this.#off.clear()
        for (const id of merged) this.#off.add(id)
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, `${JSON.stringify({ off: [...this.#off] })}\n`, { mode: 0o600 })
      renameSync(tmp, file)
      this.#unsaved.clear()
    } catch (err) {
      rmSync(tmp, { force: true })
      this.#unsaved.set(session, on)
      this.#logger?.warn(`dsh-privacy-gateway: could not save ${file}; the choice holds for this run and goes in with the next save`, err)
    }
  }
}

/** `off` with `session` turned on (taken out) or off (put last), the oldest dropped past the cap. */
function apply(off: Set<string>, session: string, on: boolean): void {
  if (on) {
    off.delete(session)
    return
  }
  off.add(session)
  for (const old of off) {
    if (off.size <= MAX_SESSIONS) break
    off.delete(old)
  }
}
