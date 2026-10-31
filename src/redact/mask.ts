import { tagOf } from './key.ts'
import type { ValueTable } from './known.ts'
import { secretRules, type Rule } from './rules.ts'
import { asJSON, walkJSON } from './json.ts'
import { envBlockRanges, TOOL_ROOTS, under, type Range } from '../protect.ts'

export interface MaskOptions {
  secrets: boolean
  protectEnvBlock: boolean
  protectTools: boolean
}

interface Span {
  start: number
  end: number
  kind: string
}

export interface MaskResult {
  text: string
  /** How many values were swapped for placeholders. */
  n: number
}

/** A placeholder as the masker writes it. */
const PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g

/**
 * Keys whose strings the vendor needs as they are: ids, names and kinds, and
 * what is sealed or encoded. magpie json.go `kept`: a tool's name masked is a
 * 400 on every turn that replays the call.
 */
const KEPT = new Set([
  'signature', 'encrypted_content', 'data', 'thoughtSignature', 'thought_signature',
  'model', 'id', 'tool_use_id', 'call_id', 'item_id', 'type', 'role',
  'name', 'namespace', 'server_label', 'server_name', 'previous_response_id', 'prompt_cache_key', 'media_type', 'mime_type',
  'mimeType', 'url', 'image_url', 'file_id', 'reasoning_effort', 'effort',
  'stop_reason', 'finish_reason', 'status', 'object', 'event',
])

/** A key holding an identifier the vendor matches against another (tool_call_id against its call's id). */
function isID(key: string): boolean {
  return key === 'id' || key === 'ids' || key.endsWith('_id') || key.endsWith('_ids') || key.endsWith('Id') || key.endsWith('Ids')
}

/**
 * The request's own keys whose values the agent defines for the vendor to read
 * as structure (magpie json.go `defKeys`): only a description in them is masked.
 */
const DEF_KEYS = [
  'tools', 'tool_choice', 'functions', 'function_call', 'toolConfig', 'tool_config',
  'response_format', 'text', 'reasoning', 'include', 'output_format', 'output_config',
  'generationConfig', 'generation_config', 'stream_options', 'client_metadata',
]

/** Responses input items that carry tools. */
const DEF_ITEMS = new Set(['additional_tools', 'tool_search_output'])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A chat (`messages`) or Responses (`input`) request: the shape this gateway rewrites. */
export function isModelRequest(doc: unknown): doc is Record<string, unknown> {
  return isObject(doc) && (Array.isArray(doc.messages) || Array.isArray(doc.input))
}

function definitions(doc: Record<string, unknown>): string[] {
  const defs: string[] = []
  for (const k of DEF_KEYS) {
    if (!(k in doc)) continue
    // Responses' text is the output's settings; a prompt's text is a string
    if (k === 'text' && !isObject(doc[k])) continue
    defs.push(k)
  }
  const items = doc.input
  if (Array.isArray(items)) {
    items.forEach((it, i) => {
      if (isObject(it) && typeof it.type === 'string' && DEF_ITEMS.has(it.type)) defs.push(`input.${i}.tools`)
    })
  }
  return defs
}

/** Paths of tool calls' arguments as objects (Anthropic tool_use input, Gemini functionCall args): their keys are the tool's. */
function argPaths(doc: unknown, body: string): string[] {
  if (!body.includes('"tool_use"') && !body.includes('"server_tool_use"') && !body.includes('"functionCall"') && !body.includes('"function_call"')) {
    return []
  }
  const args: string[] = []
  const visit = (path: string, key: string, v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach((c, i) => visit(path === '' ? String(i) : `${path}.${i}`, key, c))
      return
    }
    if (!isObject(v)) return
    const t = typeof v.type === 'string' ? v.type : ''
    for (const [k, c] of Object.entries(v)) {
      const p = path === '' ? k : `${path}.${k}`
      if ((k === 'input' && (t === 'tool_use' || t === 'server_tool_use')) || (k === 'args' && (key === 'functionCall' || key === 'function_call'))) {
        args.push(p)
        continue
      }
      visit(p, k, c)
    }
  }
  visit('', '', doc)
  return args
}

function keepIn(path: string, key: string, s: string, args: string[], defs: string[]): boolean {
  if (s.startsWith('data:')) return true
  if (under(path, args)) return false
  if (under(path, defs)) return key !== 'description'
  return KEPT.has(key) || isID(key)
}

/**
 * `s`, JSON text, as long as `s` and read as the vendor reads it once
 * unescaped, as far as the finders tell: the letter of \n, \t, \r, \b, \f is
 * read as a line break and a \u escape's u and digits too, so none of them
 * starts or ends a key (magpie `unescapedView`).
 */
function unescapedView(s: string): string {
  if (!s.includes('\\')) return s
  const b = s.split('')
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] !== '\\') continue
    i++
    switch (b[i]) {
      case 'n': case 'b': case 'f': b[i] = '\n'; break
      case 'r': b[i] = '\r'; break
      case 't': b[i] = '\t'; break
      case 'u':
        for (let j = i; j < i + 5 && j < b.length; j++) b[j] = '\n'
        i += 4
        break
    }
  }
  return b.join('')
}

/** `found` with no value starting or ending inside one of the escapes of `s`: each is cut back to the escape's edge. */
function outsideEscapes(s: string, found: Span[]): Span[] {
  if (found.length === 0 || !s.includes('\\')) return found
  // inside[i] for i past an escape's backslash: [where the escape's letters start, where it ends]
  const inside: Array<[number, number] | undefined> = new Array(s.length + 1)
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue
    const end = Math.min(i + (s[i + 1] === 'u' ? 6 : 2), s.length)
    for (let j = i + 1; j < end; j++) inside[j] = [i + 1, end]
    i = end - 1
  }
  const out: Span[] = []
  for (const f of found) {
    let { start, end } = f
    const a = inside[start]
    if (a) start = a[1]
    const z = inside[end]
    if (z) end = z[0] - 1
    if (start < end) out.push({ ...f, start, end })
  }
  return out
}

function findSpans(s: string, rules: readonly Rule[]): Span[] {
  const found: Span[] = []
  for (const r of rules) {
    if (r.markers.length > 0 && !r.markers.some((m) => s.includes(m))) continue
    for (const m of s.matchAll(r.re)) {
      const start = m.index
      const end = start + m[0].length
      if (r.bound && ((start > 0 && r.bound.includes(s[start - 1] as string)) || (end < s.length && r.bound.includes(s[end] as string)))) {
        continue
      }
      if (r.ok && !r.ok(m[0])) continue
      found.push({ start, end, kind: r.kind })
    }
  }
  return found
}

function overlaps(f: Span, r: Range): boolean {
  return f.start < r.end && f.end > r.start
}

/**
 * Swaps the secrets of a model request for placeholders, by magpie's
 * semantics (internal/redact/redact.go `mask`, json.go `MaskJSON`).
 */
export class Masker {
  readonly #key: Uint8Array
  readonly #table: ValueTable
  readonly #options: MaskOptions

  constructor(key: Uint8Array, table: ValueTable, options: MaskOptions) {
    this.#key = key
    this.#table = table
    this.#options = options
  }

  /** The placeholder `value` of `kind` goes as, remembered for the reply. */
  placeholder(kind: string, value: string): string {
    const p = tagOf(this.#key, kind, value)
    this.#table.put(p, kind, value)
    return p
  }

  /**
   * Masks one string. `escaped` says it holds JSON text of its own (a tool
   * call's arguments): the finders read it as the vendor does, no value starts
   * or ends inside an escape, and what is remembered is the value unescaped,
   * so the reply gets back what the agent wrote. Nothing inside `keep` is
   * touched.
   */
  maskText(raw: string, escaped = false, keep: readonly Range[] = []): MaskResult {
    if (raw.length < 3 || !this.#options.secrets) return { text: raw, n: 0 }
    const s = escaped ? unescapedView(raw) : raw
    let found = findSpans(s, secretRules)
    if (escaped) found = outsideEscapes(raw, found)
    if (found.length === 0) return { text: raw, n: 0 }
    // nothing inside a placeholder already there: masking again changes nothing
    const fixed: Range[] = [...keep]
    if (raw.includes('{{')) {
      for (const m of raw.matchAll(PLACEHOLDER_RE)) fixed.push({ start: m.index, end: m.index + m[0].length })
    }
    found = found.filter((f) => !fixed.some((r) => overlaps(f, r)))
    // the first to start, and of those the longest, wins where they overlap
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    const out: string[] = []
    let last = 0
    let next = 0
    let n = 0
    for (const f of found) {
      if (f.start < next) continue
      next = f.end
      out.push(raw.slice(last, f.start), this.placeholder(f.kind, escaped ? unescaped(raw.slice(f.start, f.end)) : raw.slice(f.start, f.end)))
      last = f.end
      n++
    }
    if (n === 0) return { text: raw, n: 0 }
    out.push(raw.slice(last))
    return { text: out.join(''), n }
  }

  /**
   * Masks the strings of a request body. Null when the body is not JSON or
   * not a model request: the gateway sends those as they are. Ids, names and
   * kinds, the request's own definitions (but their descriptions), the tool
   * definitions and `<env>` blocks where protected (docs/adr/0004) are left.
   */
  maskJSON(body: string): MaskResult | null {
    let doc: unknown
    try {
      doc = JSON.parse(body)
    } catch {
      return null
    }
    if (!isModelRequest(doc)) return null
    const args = argPaths(doc, body)
    const defs = definitions(doc)
    const { protectTools, protectEnvBlock } = this.#options
    let n = 0
    const out = walkJSON(body, (path, key, s) => {
      if (protectTools && under(path, TOOL_ROOTS)) return s
      if (keepIn(path, key, s, args, defs)) return s
      const r = this.maskText(s, asJSON(key, ''), protectEnvBlock ? envBlockRanges(s) : [])
      n += r.n
      return r.text
    })
    // JSON.parse took it, so the walker must too: anything else is our bug
    if (out === null) throw new Error('request body is JSON but could not be walked')
    return { text: out, n }
  }
}

/** A value found in JSON text, as the vendor and the agent read it: a JSON string's text unescaped. */
function unescaped(v: string): string {
  if (!v.includes('\\')) return v
  try {
    const u: unknown = JSON.parse(`"${v}"`)
    return typeof u === 'string' ? u : v
  } catch {
    return v
  }
}
