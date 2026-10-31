import type { ResolvedConfig } from './config.ts'
import { ValueTable } from './redact/known.ts'
import { Masker } from './redact/mask.ts'
import { Restorer, type StreamRestorer } from './redact/restore.ts'

/** What the dispatcher needs from the redaction engine. */
export interface RedactionEngine {
  /** The masked body, or null when it is not a model request (sent as it is). Throws when masking fails. */
  maskRequest(body: string): string | null
  /** Whether a reply can hold a placeholder to put back. */
  restoring(): boolean
  /** Restores a whole JSON (or text) reply body. */
  restoreBody(text: string): string
  /** A restorer for one `text/event-stream` reply. */
  streamRestorer(): StreamRestorer
}

export class PrivacyEngine implements RedactionEngine {
  readonly #table: ValueTable
  readonly #masker: Masker
  readonly #restorer: Restorer

  constructor(key: Uint8Array, config: ResolvedConfig) {
    this.#table = new ValueTable(config.maxValues)
    this.#masker = new Masker(key, this.#table, {
      secrets: config.secrets,
      protectEnvBlock: config.protectEnvBlock,
      protectTools: config.protectTools,
    })
    this.#restorer = new Restorer(this.#table)
  }

  maskRequest(body: string): string | null {
    const r = this.#masker.maskJSON(body)
    return r === null ? null : r.text
  }

  restoring(): boolean {
    return this.#table.size > 0
  }

  restoreBody(text: string): string {
    return this.#restorer.restoreJSON(text)
  }

  streamRestorer(): StreamRestorer {
    return this.#restorer.stream()
  }
}
