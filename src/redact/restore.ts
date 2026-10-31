import { externalHosts } from './guard.ts'
import type { ValueTable } from './known.ts'
import { asJSON, jsonEscape, KEPT, SIGNATURE_KEYS, walkJSON } from './json.ts'

/**
 * A placeholder's body, without its braces, as a model may write one back:
 * API_KEY_k3v9x2mq, api_key_k3v9x2mq, API_KEY_K3V9X2MQ. A whole word, with a
 * kind of 24 characters at most: tried from every place in a long word, an
 * unbounded kind read the rest of it each time.
 */
const PLACEHOLDER_BODY = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]{0,23}_[A-Za-z2-7]{8}(?![A-Za-z0-9_])/g

/** A placeholder as the masker writes it: one the table lacks is counted as unmapped (design §13 R11). */
const STRICT = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g

/** The longest placeholder the masker writes: {{, a kind of up to 24, _, the 8 of the hash, }}. */
const MAX_PLACEHOLDER = 2 + 24 + 1 + 8 + 2

/**
 * What a reply had put back, for the record: places per placeholder, the
 * places inside a tool call's arguments (where a value put back can leave the
 * machine when the tool runs, design §13 R15), and placeholders no value is
 * known for.
 */
export interface Tally {
  restored: Map<string, number>
  inTools: number
  unmapped: number
  /** Tool calls whose arguments had a value put back and named a host off this machine (toolGuard warn or block). */
  exfil: number
  /** Places in those arguments left as placeholders (toolGuard block). */
  exfilBlocked: number
  /** The hosts they named. */
  exfilHosts: Set<string>
}

export function newTally(): Tally {
  return { restored: new Map(), inTools: 0, unmapped: 0, exfil: 0, exfilBlocked: 0, exfilHosts: new Set() }
}

/**
 * What is done with a tool call's arguments that would have a value put back
 * and name a host off this machine (design §13 R15, docs/adr/0014): nothing
 * but the count (off), a warning and a record (warn), or the placeholders
 * left in them as they are (block).
 */
export type ToolGuard = 'off' | 'warn' | 'block'

/** The most hosts a tally keeps. */
const MAX_HOSTS = 8

/** Keys a tool call's arguments sit under, in any vendor's reply. */
const TOOL_PATH = /(?:^|\.)(?:tool_calls|function_call|functionCall|tool_use|args|arguments|input|partial_json)(?:\.|$)/

/** Whether the string at `path` (its key `key`, in an event of `type`) is part of a tool call's arguments. */
export function inToolCall(path: string, key: string, type: string): boolean {
  return asJSON(key, type) || TOOL_PATH.test(path)
}

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

/** A restorer for one `text/event-stream` body. */
export interface StreamRestorer {
  /** The restored text of the events `chunk` completes; the rest is held for the next chunk. */
  push(chunk: Uint8Array): string
  /** Whatever is still held, restored, at the end of the body. */
  end(): string
}

/** An event held for its texts' tails: each tail by its path, the event as it is, and without the tails. */
interface Held {
  ctx: string
  tails: Map<string, string>
  full: string
  cut: string
}

/** How long the whole comment lines (": keep-alive") and blank lines at the start of b are: none of them is part of an event. */
function commentLines(b: string): number {
  let n = 0
  while (n < b.length && (b[n] === ':' || b[n] === '\n' || b[n] === '\r')) {
    const i = b.indexOf('\n', n)
    if (i < 0 || (b[n] === '\r' && i !== n + 1)) break
    n = i + 1
  }
  return n
}

/** Where the first complete event in b ends, and the length of the blank line that ends it. */
function eventEnd(b: string): [number, number] {
  const i = b.indexOf('\n\n')
  const j = b.indexOf('\r\n\r\n')
  if (i < 0 && j < 0) return [-1, 0]
  if (j >= 0 && (i < 0 || j < i)) return [j, 4]
  return [i, 2]
}

/** The one data line of an event that has JSON in it: the event's name, what comes before the JSON, the JSON, and after it. */
function splitEvent(ev: string): { name: string; pre: string; data: string; post: string } | undefined {
  let name = ''
  let at = -1
  let off = 0
  let lineAt = 0
  for (const l of ev.split(/(?<=\n)/)) {
    const t = l.replace(/\r?\n$/, '')
    if (t.startsWith('event:')) name = t.slice(6).trim()
    else if (t.startsWith('data:')) {
      if (at >= 0) return undefined // data over more than one line
      at = off
      lineAt = t.length
    }
    off += l.length
  }
  if (at < 0) return undefined
  const start = ev[at + 5] === ' ' ? 6 : 5
  const data = ev.slice(at + start, at + lineAt)
  if (data[0] !== '{' && data[0] !== '[') return undefined
  return { name, pre: ev.slice(0, at + start), data, post: ev.slice(at + lineAt) }
}

/** What says which text an event goes on with: its type, its item and the indexes it has. */
function eventCtx(data: string): string {
  let b = ''
  walkJSON(data, (path, _k, s) => {
    if (path === 'type' || path === 'item_id') b += `${path}=${s};`
    return s
  })
  for (const k of ['"index":', '"output_index":', '"content_index":']) {
    const i = data.indexOf(k)
    if (i < 0) continue
    let e = i + k.length
    while (e < data.length && /[0-9 ]/.test(data[e] as string)) e++
    b += `${k}${data.slice(i + k.length, e)};`
  }
  return b
}

function typeOf(data: string): string {
  let t = ''
  walkJSON(data, (path, _k, s) => {
    if (path === 'type') t = s
    return s
  })
  return t
}

/** A string of a vendor's answer that goes on as it came: what the vendor sealed, and a file's encoded data. */
function sealedText(key: string, s: string): boolean {
  return SIGNATURE_KEYS.has(key) || s.startsWith('data:') || (key === 'data' && s.length >= 64 && !/[ \n]/.test(s))
}

/**
 * Puts the values back in what the vendor says (magpie `Restore`): any
 * placeholder this gateway made, also with its braces changed, dropped or
 * spaced, or in another case, as long as its kind and the 8 of its hash
 * name one in the table.
 */
export class Restorer {
  readonly #table: ValueTable
  readonly #guard: ToolGuard

  constructor(table: ValueTable, guard: ToolGuard = 'off') {
    this.#table = table
    this.#guard = guard
  }

  /**
   * `escaped` is for text that is itself JSON (a tool call's arguments), where
   * a value goes in escaped. `leave` puts nothing back: the places are counted
   * as left (toolGuard block).
   */
  restoreText(s: string, escaped = false, tally?: Tally, tool = false, leave = false): string {
    if (this.#table.size === 0) return s
    const shapes = this.#table.shapes > 0
    if (!shapes && !s.includes('_')) return s
    if (leave) {
      const scratch = newTally()
      this.restoreText(s, escaped, scratch, tool)
      if (tally) {
        for (const n of scratch.restored.values()) tally.exfilBlocked += n
        tally.unmapped += scratch.unmapped
      }
      return s
    }
    const out = s.includes('_') ? this.#placeholders(s, escaped, tally, tool) : s
    return shapes ? this.#shapes(out, tally, tool) : out
  }

  /** Puts back the made-up keys in s (docs/adr/0015): a key and its value need no escaping. */
  #shapes(s: string, tally: Tally | undefined, tool: boolean): string {
    const spans = this.#table.shapeSpans(s)
    if (spans.length === 0) return s
    const out: string[] = []
    let last = 0
    for (const sp of spans) {
      const v = this.#table.get(sp.shape)
      if (v === undefined) continue
      out.push(s.slice(last, sp.start), v)
      last = sp.end
      if (tally) {
        tally.restored.set(sp.shape, (tally.restored.get(sp.shape) ?? 0) + 1)
        if (tool) tally.inTools++
      }
    }
    if (last === 0) return s
    out.push(s.slice(last))
    return out.join('')
  }

  #placeholders(s: string, escaped: boolean, tally: Tally | undefined, tool: boolean): string {
    if (tally && s.includes('{{')) {
      for (const m of s.matchAll(STRICT)) if (this.#table.get(m[0]) === undefined) tally.unmapped++
    }
    const out: string[] = []
    let last = 0
    for (const m of s.matchAll(PLACEHOLDER_BODY)) {
      let a = m.index
      let z = a + m[0].length
      if (a < last) continue
      const p = canonical(m[0])
      const v = this.#table.get(p)
      if (v === undefined) continue
      ;[a, z] = braces(s, a, z)
      if (a < last) continue
      if (tally) {
        tally.restored.set(p, (tally.restored.get(p) ?? 0) + 1)
        if (tool) tally.inTools++
      }
      out.push(s.slice(last, a), escaped ? jsonEscape(v) : v)
      last = z
    }
    if (last === 0) return s
    out.push(s.slice(last))
    return out.join('')
  }

  /** Restores the strings of a JSON body; text that is not JSON is restored as text. */
  restoreJSON(text: string, tally?: Tally): string {
    if (this.#table.size === 0 || (this.#table.shapes === 0 && !text.includes('_'))) return text
    const type = typeOf(text)
    const leave = this.#guard !== 'off' && this.#judge(toolText(text, type) ?? '', tally) && this.#guard === 'block'
    const out = walkJSON(text, (path, key, s) => {
      if (SIGNATURE_KEYS.has(key)) return s
      const tool = inToolCall(path, key, type)
      return this.restoreText(s, asJSON(key, type), tally, tool, leave && tool)
    })
    return out ?? this.restoreText(text, false, tally)
  }

  /**
   * Whether tool arguments `text` (as the vendor wrote them, placeholders in
   * them) would have a value put back and name a host off this machine;
   * counted in `tally` where they would.
   */
  #judge(text: string, tally?: Tally): boolean {
    if (text === '') return false
    const scratch = newTally()
    const restored = this.restoreText(text, false, scratch, true)
    if (scratch.restored.size === 0) return false
    const hosts = externalHosts(restored)
    if (hosts.length === 0) return false
    if (tally) {
      tally.exfil++
      for (const h of hosts) if (tally.exfilHosts.size < MAX_HOSTS) tally.exfilHosts.add(h)
    }
    return true
  }

  /**
   * How much of the end of s may be the start of a placeholder the next
   * event finishes (magpie `partialTail`): from a { or {{ on, or a last word
   * that starts as a kind this table has, up to the 8 of its hash.
   */
  #partialTail(s: string): number {
    const n = braceTail(s)
    return Math.max(n > 0 ? n : this.#wordTail(s), this.#table.shapeTail(s))
  }

  #wordTail(s: string): number {
    let i = s.length
    while (i > 0 && isWordChar(s[i - 1])) i--
    const w = s.slice(i)
    if (w === '' || w.length > 24 + 9 || !/[A-Z]/.test(w[0] as string)) return 0
    const u = w.toUpperCase()
    for (const kind of this.#table.kinds()) {
      const k = `${kind}_`
      if (k.startsWith(u)) return w.length
      if (u.startsWith(k) && u.length - k.length <= 8 && /^[a-z2-7]*$/.test(u.slice(k.length).toLowerCase())) return w.length
    }
    return 0
  }

  /**
   * A restorer for one `text/event-stream` reply, event by event as it comes
   * (magpie writer.go). A placeholder a stream splits between two events,
   * {{API_ in one text delta and KEY_k3v9x2mq}} in the next, is put back
   * whole: an event whose text ends in what may be the start of one is held
   * until the next, and if that one goes on with the same text the start
   * moves over to it. Nothing is added or dropped. Comment lines go on as
   * they come, so a keep-alive is never held.
   */
  stream(tally?: Tally): StreamRestorer {
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let pending: Held | undefined
    const release = (): string => {
      const out = pending?.full ?? ''
      pending = undefined
      return out
    }
    const event = (ev: string, leave = false): string => {
      if (!pending && this.#table.size === 0) return ev
      const e = splitEvent(ev)
      if (!e) return release() + this.restoreText(ev, false, tally)
      const ctx = `${e.name}|${eventCtx(e.data)}`
      let out = ''
      let carry: Map<string, string> | undefined
      if (pending) {
        const p = pending
        pending = undefined
        let present = 0
        walkJSON(e.data, (path, _k, s) => {
          if (p.tails.has(path)) present++
          return s
        })
        if (p.ctx === ctx && present === p.tails.size) {
          out += p.cut
          carry = p.tails
        } else out += p.full
      }
      const type = typeOf(e.data) || e.name
      let tails: Map<string, string> | undefined
      let cuts: Map<string, string> | undefined
      const restored = walkJSON(e.data, (path, key, s) => {
        const c = carry?.get(path)
        if (c !== undefined) s = c + s
        if (sealedText(key, s)) return s
        const escaped = asJSON(key, type)
        // the tail is looked for before anything is put back, so a placeholder whose last brace is still to come keeps it
        if (!KEPT.has(key) && key !== 'obfuscation') {
          const n = this.#partialTail(s)
          if (n > 0) {
            tails ??= new Map()
            cuts ??= new Map()
            tails.set(path, s.slice(s.length - n))
            cuts.set(path, this.restoreText(s.slice(0, s.length - n), escaped, undefined, false, leave && inToolCall(path, key, type)))
          }
        }
        // counted here only: whichever of full and cut goes out, the places are these
        const tool = inToolCall(path, key, type)
        return this.restoreText(s, escaped, tally, tool, leave && tool)
      })
      if (restored === null) return out + this.restoreText(ev, false, tally)
      const full = e.pre + restored + e.post
      if (!tails || !cuts) return out + full
      const cutMap = cuts
      const cutData = walkJSON(restored, (path, _k, s) => cutMap.get(path) ?? s) ?? restored
      pending = { ctx, tails, full, cut: e.pre + cutData + e.post }
      return out
    }
    // the tool arguments of the events in a row that have some: judged as one when the row ends (toolGuard)
    const guard = this.#guard
    let run: { text: string; held: string[] } | undefined
    const closeRun = (): string => {
      if (!run) return ''
      const r = run
      run = undefined
      const leave = this.#judge(r.text, tally) && guard === 'block'
      let out = ''
      for (const ev of r.held) out += event(ev, leave)
      return out
    }
    const route = (ev: string): string => {
      if (guard === 'off' || this.#table.size === 0) return closeRun() + event(ev)
      const t = eventToolText(ev)
      if (t === undefined) return closeRun() + event(ev)
      run ??= { text: '', held: [] }
      run.text += t
      // block holds the row until it ends, so nothing in it goes out restored before it is judged
      if (guard === 'block') {
        run.held.push(ev)
        return ''
      }
      return event(ev)
    }
    const drain = (): string => {
      let out = ''
      for (;;) {
        const c = commentLines(buf)
        if (c > 0) {
          out += buf.slice(0, c)
          buf = buf.slice(c)
          continue
        }
        const [i, n] = eventEnd(buf)
        if (i < 0) return out
        const ev = buf.slice(0, i + n)
        buf = buf.slice(i + n)
        out += route(ev)
      }
    }
    return {
      push(chunk) {
        buf += decoder.decode(chunk, { stream: true })
        return drain()
      },
      end: () => {
        buf += decoder.decode()
        let out = drain()
        out += closeRun()
        out += release()
        if (buf !== '') out += this.restoreText(buf, false, tally)
        buf = ''
        return out
      },
    }
  }
}

/**
 * The tool call arguments' strings of a JSON body, one after another, `sep`
 * between them; undefined where it has none. A stream's pieces go on with no
 * separator, so a URL split between two events reads whole.
 */
function toolText(data: string, type: string, sep = '\n'): string | undefined {
  let t: string | undefined
  walkJSON(data, (path, key, s) => {
    if (s !== '' && !SIGNATURE_KEYS.has(key) && inToolCall(path, key, type)) t = (t ?? '') + s + sep
    return s
  })
  return t
}

/** The tool call arguments' strings of one event; undefined where it has none. */
function eventToolText(ev: string): string | undefined {
  const e = splitEvent(ev)
  if (!e) return undefined
  return toolText(e.data, typeOf(e.data) || e.name, '')
}

/** A tail from { or {{ on: then spaces, a placeholder's body or the start of one, then spaces and one } at most. */
function braceTail(s: string): number {
  let i = s.lastIndexOf('{')
  if (i < 0) return 0
  if (i > 0 && s[i - 1] === '{') i--
  const t = s.slice(i)
  if (t.length >= MAX_PLACEHOLDER + 4 || t.includes('}}')) return 0
  const body = t.replace(/^\{+/, '').replace(/^[ \t]+/, '')
  if (body === '') return t.length
  if (!/[A-Za-z]/.test(body[0] as string)) return 0
  let j = 0
  while (j < body.length && isWordChar(body[j])) j++
  const rest = body.slice(j).replace(/^[ \t]+/, '')
  if (rest !== '' && rest !== '}') return 0
  if (j < body.length) {
    const word = body.slice(0, j)
    const m = word.match(PLACEHOLDER_BODY)
    if (!m || m[0] !== word) return 0
  }
  return t.length
}
