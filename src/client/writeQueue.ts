/**
 * The configuration page's writes, one at a time and in order. A change made
 * while another is on its way waits behind it instead of being dropped, and a
 * second change to a field that is still waiting replaces the first, so a
 * burst of clicks ends in one write of the last value. `latest` is the value
 * a field will have once everything queued has landed, which is what the
 * next change has to start from: a provider ticked while the previous tick is
 * being saved adds to that tick, not to the value the page last read.
 */

export interface QueueState {
  /** A write is on its way or waiting. */
  busy: boolean
  /** The latest write the host did not take (or that could not reach it). */
  failed: boolean
}

interface Entry {
  path: string
  value: unknown
  done: Array<(ok: boolean) => void>
}

/**
 * Sends one field's value; `followOn` says a write of this same run went just
 * before it, so the revision the page read is already spent and the latest
 * one has to fence it.
 */
export type Send = (path: string, value: unknown, followOn: boolean) => Promise<boolean>

export class WriteQueue {
  private readonly waiting: Entry[] = []
  private current: Entry | undefined
  private failed = false
  private readonly send: Send
  private readonly onState: (s: QueueState) => void

  constructor(send: Send, onState: (s: QueueState) => void = () => {}) {
    this.send = send
    this.onState = onState
  }

  get state(): QueueState {
    return { busy: this.current !== undefined || this.waiting.length > 0, failed: this.failed }
  }

  /** The value `path` will have once the queued writes land, or `fallback` when none is queued for it. */
  latest(path: string, fallback: unknown): unknown {
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i]?.path === path) return this.waiting[i]?.value
    return this.current?.path === path ? this.current.value : fallback
  }

  /** Queues `value` for `path`; resolves with whether it landed (false when it failed or was dropped behind a failure). */
  write(path: string, value: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const same = this.waiting.find((e) => e.path === path)
      if (same) {
        same.value = value
        same.done.push(resolve)
      } else {
        this.waiting.push({ path, value, done: [resolve] })
      }
      this.failed = false
      this.notify()
      if (!this.current) void this.drain()
    })
  }

  private async drain(): Promise<void> {
    let followOn = false
    while (this.waiting.length > 0) {
      const entry = this.waiting.shift() as Entry
      this.current = entry
      let ok: boolean
      try {
        ok = await this.send(entry.path, entry.value, followOn)
      } catch {
        ok = false
      }
      this.current = undefined
      followOn = true
      for (const d of entry.done) d(ok)
      if (!ok) {
        // what still waits was worked out from a value that did not land: drop it rather than write on top of it
        this.failed = true
        for (const rest of this.waiting.splice(0)) for (const d of rest.done) d(false)
      }
      this.notify()
    }
  }

  private notify(): void {
    this.onState(this.state)
  }
}
