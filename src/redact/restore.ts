import { externalHosts } from './guard.ts'
import type { ValueTable } from './known.ts'
import { asJSON, jsonEscape, KEPT, SIGNATURE_KEYS, walkJSON } from './json.ts'
import { bodies, CLOSE, format, OPEN, tailLen } from './placeholder.ts'

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
const TOOL_KEYS = new Set(['tool_calls', 'function_call', 'functionCall', 'tool_use', 'args', 'arguments', 'input', 'partial_json'])

/**
 * Whether the string at `path` (its key `key`, in an event of `type`) is part
 * of a tool call's arguments. A Responses custom tool's input streams as the
 * delta of response.custom_tool_call_input.delta: free text, not JSON.
 */
export function inToolCall(path: string, key: string, type: string, segments?: readonly string[]): boolean {
  return asJSON(key, type) || (segments ? segments.some((part) => TOOL_KEYS.has(part)) : TOOL_PATH.test(path)) || (key === 'delta' && type.includes('custom_tool_call_input'))
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

/** Where the first complete event in b ends, and the length of the blank line that ends it; from `at` on. */
function eventEnd(b: string, at = 0): [number, number] {
  const i = b.indexOf('\n\n', at)
  const j = b.indexOf('\r\n\r\n', at)
  if (i < 0 && j < 0) return [-1, 0]
  if (j >= 0 && (i < 0 || j < i)) return [j, 4]
  return [i, 2]
}

/**
 * The JSON an event's data lines hold, joined as SSE joins them (a line break
 * between each), with its name, and how to write the event again with other
 * JSON in their place. A data line may hold any part of the JSON, but a JSON
 * text has line breaks only between its tokens, so the restored JSON, which
 * has the same ones, splits back into the same lines.
 */
interface Split {
  name: string
  data: string
  /** The event with `data` in its data lines; undefined where it no longer splits into as many. */
  render(data: string): string | undefined
}

function splitEvent(ev: string): Split | undefined {
  let name = ''
  const lines = ev.split(/(?<=\n)/)
  const at: Array<{ line: number; head: string; eol: string }> = []
  const bodies: string[] = []
  lines.forEach((l, i) => {
    const t = l.replace(/\r?\n$/, '')
    if (t.startsWith('event:')) name = t.slice(6).trim()
    else if (t.startsWith('data:')) {
      const start = t[5] === ' ' ? 6 : 5
      at.push({ line: i, head: t.slice(0, start), eol: l.slice(t.length) })
      bodies.push(t.slice(start))
    }
  })
  if (at.length === 0) return undefined
  const data = bodies.join('\n')
  if (data[0] !== '{' && data[0] !== '[') return undefined
  return {
    name,
    data,
    render(d) {
      const pieces = d.split('\n')
      if (pieces.length !== at.length) return undefined
      const out = [...lines]
      at.forEach((a, k) => {
        out[a.line] = a.head + (pieces[k] as string) + a.eol
      })
      return out.join('')
    },
  }
}

/** Whether a text that is no JSON event as a whole has data that reads as JSON, where a value put back would need escaping. */
function jsonData(text: string): boolean {
  return /^data:[ ]?[{[]/m.test(text)
}

/** What says which text an event goes on with: its type, its item and the indexes it has. */
function eventCtx(data: string): string {
  let b = ''
  walkJSON(data, (path, _shown, _k, s) => {
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
  walkJSON(data, (path, _shown, _k, s) => {
    if (path === 'type') t = s
    return s
  })
  return t
}

/** A string of a vendor's answer that goes on as it came: what the vendor sealed, and a file's encoded data. */
function sealedText(key: string, s: string): boolean {
  return SIGNATURE_KEYS.has(key) || s.startsWith('data:') || (key === 'data' && s.length >= 64 && !/[ \n]/.test(s))
}

/** `⟦` or `⟧` as JSON text may have escaped it: a nested JSON text keeps the escape. */
const BRACKET_ESCAPE = '\\\\u27e([67])'

/**
 * `s` with a bracket escape read as the character it stands for, and where the
 * character taken from `at[i]` in `s` sits: a tool call's arguments are JSON
 * inside JSON, and a provider may write the brackets of a placeholder as
 * `\u27e6`/`\u27e7` there. `at` has one entry more than `text`, so a span's end
 * maps too.
 */
function readable(s: string): { text: string; at: number[] } | undefined {
  const re = new RegExp(BRACKET_ESCAPE, 'gi')
  let text = ''
  const at: number[] = []
  let last = 0
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    for (let i = last; i < m.index; i++) {
      text += s[i] as string
      at.push(i)
    }
    text += m[1] === '6' ? OPEN : CLOSE
    at.push(m.index)
    last = m.index + m[0].length
  }
  for (let i = last; i < s.length; i++) {
    text += s[i] as string
    at.push(i)
  }
  at.push(s.length)
  return { text, at }
}

/**
 * Puts the values back in what the vendor says (magpie `Restore`): any
 * placeholder this gateway made, also with a bracket changed, dropped or
 * spaced, or in another case, as long as its kind and the 8 of its hash name
 * one in the table (docs/adr/0037).
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
   * as left (toolGuard block). `plain` puts back only values that need no
   * escaping: the text is JSON this restorer could not read, and a value with
   * a quote in it would break it.
   */
  restoreText(s: string, escaped = false, tally?: Tally, tool = false, leave = false, plain = false): string {
    if (this.#table.size === 0) return s
    const shapes = this.#table.shapes > 0
    if (!shapes && !s.includes('_')) return s
    if (leave) {
      const scratch = newTally()
      this.restoreText(s, escaped, scratch, tool, false, plain)
      if (tally) {
        for (const n of scratch.restored.values()) tally.exfilBlocked += n
        tally.unmapped += scratch.unmapped
      }
      return s
    }
    const out = s.includes('_') ? this.#placeholders(s, escaped, tally, tool, plain) : s
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

  #placeholders(s: string, escaped: boolean, tally: Tally | undefined, tool: boolean, plain: boolean): string {
    // the masker reads a nested JSON text's escaped brackets too; so does this
    const view = readable(s)
    const text = view ? view.text : s
    const found = bodies(text)
    if (found.length === 0) return s
    const out: string[] = []
    let last = 0
    for (const f of found) {
      const a = view ? (view.at[f.start] as number) : f.start
      const z = view ? (view.at[f.end] as number) : f.end
      if (a < last) continue
      const p = format(f.kind, f.hash)
      const v = this.#table.get(p)
      if (v === undefined) {
        // only a placeholder written exactly as the masker writes one counts:
        // a text a model changed is no sign of one this gateway made
        if (tally && text.slice(f.start, f.end) === p) tally.unmapped++
        continue
      }
      if (plain && jsonEscape(v) !== v) continue
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

  /** Restores the strings and the keys of a JSON body; text that is not JSON is restored as text. */
  restoreJSON(text: string, tally?: Tally): string {
    if (this.#table.size === 0 || (this.#table.shapes === 0 && !text.includes('_'))) return text
    const type = typeOf(text)
    const args = toolText(text, type)
    const leave = this.#guard !== 'off' && this.#judge(args, tally) && this.#guard === 'block'
    const out = walkJSON(
      text,
      (path, _shown, key, s, segments) => {
        if (SIGNATURE_KEYS.has(key)) return s
        const tool = inToolCall(path, key, type, segments)
        return this.restoreText(s, asJSON(key, type), tally, tool, leave && tool)
      },
      // a key the masker turned into a placeholder (maskKeys) comes back as the agent wrote it
      (path, _shown, name, segments) => this.#restoreKey(path, name, segments, type, tally, leave),
    )
    return out ?? this.restoreText(text, false, tally)
  }

  /**
   * Restores one structured tool call's arguments under this request's guard.
   * Block judges the assembled arguments before any value reaches the tool;
   * warn restores and records the external hosts; off only restores.
   */
  restoreTool(text: string, tally?: Tally): string {
    // the structured arguments are one document of the tool's own: every string in it is argument text
    const args = argumentsText(text)
    const leave = this.#guard !== 'off' && this.#judge(args, tally) && this.#guard === 'block'
    return this.restoreText(text, true, tally, true, leave)
  }

  /** Keys share the value restoration policy in whole replies and stream events. */
  #restoreKey(path: string, name: string, segments: readonly string[], type: string, tally: Tally | undefined, leave: boolean): string | undefined {
    if (KEPT.has(name)) return undefined
    const tool = inToolCall(path, name, type, [...segments, name])
    const restored = this.restoreText(name, false, tally, tool, leave && tool)
    return restored === name ? undefined : restored
  }

  /**
   * Whether tool arguments `text` (as the vendor wrote them, placeholders in
   * them) would have a value put back and name a host off this machine;
   * counted in `tally` where they would.
   */
  #judge(args: ToolText | undefined, tally?: Tally): boolean {
    if (!args) return false
    const fields = [...args.values.values()]
    const text = [...fields.map((field) => field.eligible), ...args.eligibleKeys].join('\n')
    const scratch = newTally()
    const restored = this.restoreText(text, false, scratch, true)
    if (scratch.restored.size === 0) return false
    // Opaque parameter fields still name destinations, even though their own placeholders are never restored.
    const raw = [...fields.map((field) => field.raw), ...args.keys].join('\n')
    const hosts = externalHosts(raw + '\n' + restored)
    if (hosts.length === 0) return false
    if (tally) {
      tally.exfil++
      // Hosts are lowercased by the URL scanner; restored values must not cross into the audit tally.
      const forms = [...scratch.restored.keys()].flatMap((placeholder) => {
        const value = this.#table.get(placeholder)
        return value === undefined ? [] : [[value.toLowerCase(), placeholder] as const]
      }).sort((a, b) => b[0].length - a[0].length)
      for (const host of hosts) {
        let safe = host
        for (const [value, placeholder] of forms) if (value !== '') safe = safe.split(value).join(placeholder)
        if (tally.exfilHosts.size < MAX_HOSTS) tally.exfilHosts.add(safe)
      }
    }
    return true
  }

  /**
   * How much of the end of s may be the start of a placeholder the next event
   * finishes (magpie `partialTail`): from a ⟦ or a namespace on, up to a body
   * that is not whole yet.
   */
  partialTail(s: string): number {
    return Math.max(tailLen(s), this.#table.shapeTail(s))
  }

  /**
   * A restorer for one `text/event-stream` reply, event by event as it comes
   * (magpie writer.go). A placeholder a stream splits between two events,
   * ⟦DSH_REDACTED:API_ in one text delta and KEY_k3v9x2mq⟧ in the next, is put back
   * whole: an event whose text ends in what may be the start of one is held
   * until the next, and if that one goes on with the same text the start
   * moves over to it. Nothing is added or dropped. Comment lines go on as
   * they come, so a keep-alive is never held.
   */
  stream(tally?: Tally): StreamRestorer {
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let pending: Held | undefined
    const tailIdentities = new Map<string, string>()
    let tailContext = ''
    const release = (): string => {
      const out = pending?.full ?? ''
      pending = undefined
      return out
    }
    // an event read as no JSON: a value goes back where it needs no escaping, or none where it is left
    const loose = (ev: string, leave: boolean): string => this.restoreText(ev, false, tally, leave, leave, jsonData(ev))
    const event = (ev: string, leave = false): string => {
      if (!pending && this.#table.size === 0) return ev
      const e = splitEvent(ev)
      if (!e) return release() + loose(ev, leave)
      const ctx = `${e.name}|${eventCtx(e.data)}`
      let doc: unknown
      try { doc = JSON.parse(e.data) } catch { return release() + loose(ev, leave) }
      if (tailContext !== ctx) {
        tailIdentities.clear()
        tailContext = ctx
      }
      let out = ''
      let carry: Map<string, string> | undefined
      if (pending) {
        const p = pending
        pending = undefined
        let present = 0
        walkJSON(e.data, (_path, _shown, _k, s, segments) => {
          if (p.tails.has(fragmentLocation(doc, segments, tailIdentities))) present++
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
      const fullValues = new Map<string, string>()
      const restored = walkJSON(e.data, (path, _shown, key, s, segments) => {
        const location = fragmentLocation(doc, segments, tailIdentities)
        const c = carry?.get(location)
        if (c !== undefined) s = c + s
        if (sealedText(key, s)) {
          fullValues.set(location, s)
          return s
        }
        const escaped = asJSON(key, type)
        // the tail is looked for before anything is put back, so a placeholder whose last brace is still to come keeps it
        if (!KEPT.has(key) && key !== 'obfuscation') {
          const n = this.partialTail(s)
          if (n > 0) {
            tails ??= new Map()
            cuts ??= new Map()
            tails.set(location, s.slice(s.length - n))
            cuts.set(location, this.restoreText(s.slice(0, s.length - n), escaped, undefined, false, leave && inToolCall(path, key, type, segments)))
          }
        }
        // counted here only: whichever of full and cut goes out, the places are these
        const tool = inToolCall(path, key, type, segments)
        const value = this.restoreText(s, escaped, tally, tool, leave && tool)
        fullValues.set(location, value)
        return value
      }, (path, _shown, name, segments) => {
        fragmentLocation(doc, [...segments, name], tailIdentities)
        return this.#restoreKey(path, name, segments, type, tally, leave)
      })
      const full = restored === null ? undefined : e.render(restored)
      if (restored === null || full === undefined) return out + loose(ev, leave)
      if (!tails || !cuts) return out + full
      const cutMap = cuts
      // Cut the original event: restored keys no longer name the original paths whose tails were held.
      const cutData = walkJSON(e.data, (_path, _shown, _k, s, segments) => {
        const location = fragmentLocation(doc, segments, tailIdentities)
        return cutMap.get(location) ?? fullValues.get(location) ?? s
      }, (path, _shown, name, segments) => this.#restoreKey(path, name, segments, type, undefined, leave)) ?? restored
      const cut = e.render(cutData)
      if (cut === undefined) return out + full
      pending = { ctx, tails, full, cut }
      return out
    }
    // the tool arguments of the events in a row that have some: judged as one when the row ends (toolGuard)
    const guard = this.#guard
    let run: { args: ToolText; held: string[]; identities: Map<string, string> } | undefined
    const closeRun = (): string => {
      if (!run) return ''
      const r = run
      run = undefined
      const leave = this.#judge(r.args, tally) && guard === 'block'
      let out = ''
      for (const ev of r.held) out += event(ev, leave)
      return out
    }
    const route = (ev: string): string => {
      if (guard === 'off' || this.#table.size === 0) return closeRun() + event(ev)
      run ??= { args: { values: new Map(), keys: [], eligibleKeys: [] }, held: [], identities: new Map() }
      const t = eventToolText(ev, run.identities)
      if (t === undefined) return closeRun() + event(ev)
      for (const [location, field] of t.values) {
        const prior = run.args.values.get(location)
        run.args.values.set(location, { raw: (prior?.raw ?? '') + field.raw, eligible: (prior?.eligible ?? '') + field.eligible })
      }
      run.args.keys.push(...t.keys)
      run.args.eligibleKeys.push(...t.eligibleKeys)
      // block holds the row until it ends, so nothing in it goes out restored before it is judged
      if (guard === 'block') {
        run.held.push(ev)
        return ''
      }
      return event(ev)
    }
    /** How far into `buf` a blank line was last looked for: a long event in many chunks is searched once. */
    let scanned = 0
    const drain = (): string => {
      let out = ''
      for (;;) {
        const c = commentLines(buf)
        if (c > 0) {
          out += buf.slice(0, c)
          buf = buf.slice(c)
          scanned = 0
          continue
        }
        const [i, n] = eventEnd(buf, scanned)
        if (i < 0) {
          // a blank line may split a chunk: the last three characters are looked at again
          scanned = Math.max(0, buf.length - 3)
          return out
        }
        const ev = buf.slice(0, i + n)
        buf = buf.slice(i + n)
        scanned = 0
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
        if (buf !== '') out += loose(buf, false)
        buf = ''
        return out
      },
    }
  }
}

/** Raw destinations and eligible restoration text share a lossless field identity, not a flattened string. */
interface ToolText {
  values: Map<string, { raw: string; eligible: string }>
  keys: string[]
  eligibleKeys: string[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Protocol indexes identify reordered tool arrays; ids and names persist when subsequent deltas omit them. */
function fragmentLocation(doc: unknown, segments: readonly string[], identities: Map<string, string>): string {
  const root = object(doc) ? doc : {}
  const context = ['type', 'item_id', 'index', 'output_index', 'content_index'].map((key) => [key, root[key] ?? null])
  const path: Array<string | readonly unknown[]> = []
  let node = doc
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const row: unknown = node[Number(segment)]
      const index = object(row) && Number.isSafeInteger(row.index) ? row.index : undefined
      path.push(index !== undefined ? ['index', index] : segment)
      node = row
    } else {
      path.push(segment)
      node = object(node) ? node[segment] : undefined
    }
    if (!object(node)) continue
    const scope = JSON.stringify([context, path])
    const name = (segment === 'functionCall' || segment === 'function_call') && typeof node.name === 'string' ? node.name : undefined
    const id = !Number.isSafeInteger(node.index) && typeof node.id === 'string' ? node.id : name
    if (id !== undefined) identities.set(scope, id)
    const known = identities.get(scope)
    if (known !== undefined) path.push(['identity', known])
  }
  return JSON.stringify([context, path])
}

/** Empty known argument fragments keep their run open; only the same field and tool identity may concatenate. */
function toolText(data: string, type: string, identities = new Map<string, string>(), streamed = false): ToolText | undefined {
  let doc: unknown
  try { doc = JSON.parse(data) } catch { return undefined }
  let t: ToolText | undefined
  const ensure = (): ToolText => (t ??= { values: new Map(), keys: [], eligibleKeys: [] })
  walkJSON(data, (path, _shown, key, s, segments) => {
    if (inToolCall(path, key, type, segments)) {
      const args = ensure()
      const location = fragmentLocation(doc, segments, identities)
      const prior = args.values.get(location)
      // Two physical leaves in one event are never delta fragments, even if a vendor repeats a protocol index.
      const raw = prior ? prior.raw + '\n' + s : s
      const eligible = (streamed ? sealedText(key, s) : SIGNATURE_KEYS.has(key)) ? '' : s
      args.values.set(location, { raw, eligible: prior ? prior.eligible + '\n' + eligible : eligible })
    }
    return s
  }, (path, _shown, name, segments) => {
    // A parameter container is present even when it has no leaves; emptiness cannot impersonate a finish event.
    if (inToolCall(path, name, type, [...segments, name])) {
      ensure()
      fragmentLocation(doc, [...segments, name], identities)
    }
    if (inToolCall(path, '', type, segments)) {
      const args = ensure()
      args.keys.push(name)
      if (!KEPT.has(name)) args.eligibleKeys.push(name)
    }
    return undefined
  })
  return t
}

/** The complete parameter surface of one event; undefined where it has none. */
function eventToolText(ev: string, identities: Map<string, string>): ToolText | undefined {
  const e = splitEvent(ev)
  if (!e) return undefined
  return toolText(e.data, typeOf(e.data) || e.name, identities, true)
}

/**
 * Every string and key of a structured tool call's arguments, which are the
 * tool's own document rather than a vendor event: each one is argument text,
 * so each is judged (toolGuard) and none is a sealed or signed answer.
 */
function argumentsText(text: string): ToolText | undefined {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return undefined }
  const t: ToolText = { values: new Map(), keys: [], eligibleKeys: [] }
  const identities = new Map<string, string>()
  walkJSON(text, (path, _shown, key, s, segments) => {
    t.values.set(fragmentLocation(doc, segments, identities), { raw: s, eligible: s })
    t.keys.push(key)
    if (!KEPT.has(key)) t.eligibleKeys.push(key)
    void path
    return s
  })
  return t
}

