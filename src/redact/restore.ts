import type { ValueTable } from './known.ts'
import { asJSON, jsonEscape, walkJSON } from './json.ts'

/**
 * A placeholder's body, without its braces, as a model may write one back:
 * API_KEY_k3v9x2mq, api_key_k3v9x2mq, API_KEY_K3V9X2MQ.
 */
const PLACEHOLDER_BODY = /[A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8}/g

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c)
}

/** The placeholder the masker wrote for `body`, whatever its case. */
function canonical(body: string): string {
  const cut = body.length - 8
  return `{{${body.slice(0, cut).toUpperCase()}${body.slice(cut).toLowerCase()}}}`
}

/**
 * Widens s[a:z], a placeholder's body, over the braces the model wrote around
 * it and the spaces inside them: both of {{ and }}, one of them dropped
 * ({{X} or {X}}), or just {{ or just }}. A single brace on one side alone is
 * the text's own ({X as in code) and stays (magpie `braces`).
 */
function braces(s: string, a: number, z: number): [number, number] {
  let la = a
  let l = 0
  while (la > 0 && (s[la - 1] === ' ' || s[la - 1] === '\t')) la--
  while (l < 2 && la > 0 && s[la - 1] === '{') {
    la--
    l++
  }
  let rz = z
  let r = 0
  while (rz < s.length && (s[rz] === ' ' || s[rz] === '\t')) rz++
  while (r < 2 && rz < s.length && s[rz] === '}') {
    rz++
    r++
  }
  if (l === 2 || (l === 1 && r >= 1)) a = la
  if (r === 2 || (r === 1 && l >= 1)) z = rz
  return [a, z]
}

/** A line restorer for a `text/event-stream` body: each `data:` line is restored as it completes. */
export interface StreamRestorer {
  /** The restored text of the lines `chunk` completes; the rest is held for the next chunk. */
  push(chunk: Uint8Array): string
  /** Whatever is still held, restored, at the end of the body. */
  end(): string
}

/**
 * Puts the values back in what the vendor says (magpie `Restore`): any
 * placeholder this gateway made, also with its braces changed, dropped or
 * spaced, or in another case, as long as its kind and the 8 of its hash name
 * one in the table.
 */
export class Restorer {
  readonly #table: ValueTable

  constructor(table: ValueTable) {
    this.#table = table
  }

  /** `escaped` is for text that is itself JSON (a tool call's arguments), where a value goes in escaped. */
  restoreText(s: string, escaped = false): string {
    if (this.#table.size === 0 || !s.includes('_')) return s
    const out: string[] = []
    let last = 0
    for (const m of s.matchAll(PLACEHOLDER_BODY)) {
      let a = m.index
      let z = a + m[0].length
      if (a < last || isWordChar(s[a - 1]) || isWordChar(s[z])) continue
      const v = this.#table.get(canonical(m[0]))
      if (v === undefined) continue
      ;[a, z] = braces(s, a, z)
      if (a < last) continue
      out.push(s.slice(last, a), escaped ? jsonEscape(v) : v)
      last = z
    }
    if (last === 0) return s
    out.push(s.slice(last))
    return out.join('')
  }

  /** Restores the strings of a JSON body; text that is not JSON is restored as text. */
  restoreJSON(text: string): string {
    if (this.#table.size === 0 || !text.includes('_')) return text
    let type = ''
    const out = walkJSON(text, (path, key, s) => {
      if (path === 'type') type = s
      return this.restoreText(s, asJSON(key, type))
    })
    return out ?? this.restoreText(text)
  }

  stream(): StreamRestorer {
    const decoder = new TextDecoder('utf-8')
    let pending = ''
    const lines = (text: string): string =>
      text
        .split(/(?<=\n)/)
        .map((line) => {
          if (!line.startsWith('data:')) return line // event:, id:, keep-alive comments
          const eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
          const body = line.slice(5, line.length - eol.length)
          const lead = body.startsWith(' ') ? ' ' : ''
          return `data:${lead}${this.restoreJSON(body.slice(lead.length))}${eol}`
        })
        .join('')
    return {
      push(chunk) {
        pending += decoder.decode(chunk, { stream: true })
        const i = pending.lastIndexOf('\n')
        if (i < 0) return ''
        const done = pending.slice(0, i + 1)
        pending = pending.slice(i + 1)
        return lines(done)
      },
      end() {
        const rest = pending + decoder.decode()
        pending = ''
        return rest === '' ? '' : lines(rest)
      },
    }
  }
}
