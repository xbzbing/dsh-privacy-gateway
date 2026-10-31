import { cookieSpans, type CookieOptions } from './cookie.ts'
import { decodedView, hint, inRaw, inStrings, lowerASCII, ruleSpans, SentMemo, wordSpans, type DecodedView } from './find.ts'
import { noIDs, noNumbers, PERSONAL_KINDS, type Finder, type Found } from './ids.ts'
import { tagOf } from './key.ts'
import type { KnownSpan, ValueTable } from './known.ts'
import { rules } from './rules.ts'
import { shapeOf, splitName } from './shape.ts'
import { asJSON, KEPT, walkJSON, type Edit } from './json.ts'
import { envBlockRanges, TOOL_ROOTS, under, type Range } from '../protect.ts'

export interface MaskOptions {
  /** API keys, tokens, passwords, private keys, cookies. */
  secrets: boolean
  /** Emails, phone numbers, ID and bank card numbers. */
  personal?: boolean
  protectEnvBlock: boolean
  protectTools: boolean
  /** The user's own words (a project's code name), masked wherever they are, as written. */
  words?: readonly string[]
  /** Values sent as written whichever finder finds them: each a whole value, in any case. */
  allow?: readonly string[]
  cookies?: CookieOptions
  /** Kinds whose values are not masked: warn sends them as written, block stops the request. Each is recorded. */
  actions?: Readonly<Record<string, 'warn' | 'block'>>
  /** A secret goes as a made-up key of its own form, not a placeholder, where it can (docs/adr/0015). */
  shape?: boolean
  /** Each hit of a request body says where it was and the text around it, as sent (docs/adr/0024). */
  context?: boolean
}

/** Where in a request body a value was: the string's dotted path, and the role and block type around it. */
export interface Place {
  path: string
  role?: string
  type?: string
}

/** One value masked, as the record keeps it: never the value itself. */
export interface Hit {
  placeholder: string
  kind: string
  by: Finder
  /** Its first characters: a key's prefix (sk-) and a few after it, or a cookie's name (docs/adr/0019). */
  head: string
  /** Its last characters, where it is long enough to spare them. */
  tail?: string
  len: number
  /** Not masked: sent as written (warn) or the request stopped (block). The placeholder is the one it would have had. */
  action?: 'warn' | 'block'
  /** The text just before and after it as it went, every value found there already its placeholder (docs/adr/0024). */
  before?: string
  after?: string
  /** Where in the request body it was. */
  at?: Place
}

/** How many characters of context each side keeps. */
export const CONTEXT_CHARS = 80

/** The last (`end`) or first `n` characters of `s` with its runs of white space made one space. */
export function clip(s: string, n: number, end: boolean): string {
  const flat = s.replace(/\s+/g, ' ')
  const chars = [...flat]
  if (chars.length <= n) return flat
  return end ? `…${chars.slice(-n).join('')}` : `${chars.slice(0, n).join('')}…`
}

/** The role and block type of the objects along `path` in `doc`, the innermost of each. */
export function placeOf(doc: unknown, path: string): Place {
  const place: Place = { path }
  let node: unknown = doc
  for (const seg of path.split('.')) {
    if (typeof node !== 'object' || node === null) break
    if (!Array.isArray(node)) {
      const o = node as Record<string, unknown>
      if (typeof o.role === 'string') place.role = o.role
      if (typeof o.type === 'string') place.type = o.type
    }
    node = (node as Record<string, unknown>)[seg]
  }
  return place
}

export interface MaskResult {
  text: string
  /** How many values were swapped for placeholders. */
  n: number
  hits: Hit[]
  /** The request body's `model`, where it names one (maskJSON). */
  model?: string
  /** Each warned value as written in its string, with its placeholder: for the vendor view only, never kept (docs/adr/0016). */
  warned?: Array<[written: string, placeholder: string]>
}

/** A placeholder as the masker writes it. */
const PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g

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

function overlaps(f: { start: number; end: number }, r: Range): boolean {
  return f.start < r.end && f.end > r.start
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

/** Where one string is masked: the host it goes to (SentMemo), and whether nothing is remembered (a preview). */
interface Pass {
  route: string
  preview: boolean
  hits: Hit[]
  warned?: Array<[string, string]>
  /** The string being masked is at this place; set while maskJSON keeps context. */
  at?: Place
}

/**
 * Swaps the secrets of a model request for placeholders, by magpie's
 * semantics (internal/redact/redact.go `mask`, json.go `MaskJSON`).
 */
export class Masker {
  readonly #key: Uint8Array
  readonly #table: ValueTable
  readonly #options: MaskOptions
  readonly #memo: SentMemo
  readonly #allow: Set<string>
  readonly #fingerprint: string

  constructor(key: Uint8Array, table: ValueTable, options: MaskOptions, memo: SentMemo = new SentMemo()) {
    this.#key = key
    this.#table = table
    this.#options = options
    this.#memo = memo
    this.#allow = new Set((options.allow ?? []).map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))
    this.#fingerprint = `${options.secrets ? 1 : 0}${options.personal ? 1 : 0}`
  }

  /** The placeholder `value` of `kind` goes as, remembered for the reply. */
  placeholder(kind: string, value: string): string {
    const p = tagOf(this.#key, kind, value)
    this.#table.put(p, kind, value)
    return p
  }

  /**
   * What `value` of `kind` goes as: a made-up key of its form where shape is
   * on and it can be one (its name, as in API_KEY=…, stays), else its
   * placeholder. `id` is the placeholder or made-up key, as the record keeps it.
   */
  #standIn(kind: string, value: string, preview: boolean): { text: string; id: string } {
    if (this.#options.shape) {
      const [name, k] = splitName(value)
      const f = shapeOf(this.#key, kind, k)
      if (f !== undefined && (preview || this.#table.putShape(f, kind, k))) return { text: name + f, id: f }
    }
    const p = preview ? tagOf(this.#key, kind, value) : this.placeholder(kind, value)
    return { text: p, id: p }
  }

  #covers = (kind: string): boolean => {
    if (kind === 'TERM') return true
    return PERSONAL_KINDS.has(kind) ? this.#options.personal === true : this.#options.secrets
  }

  /**
   * Masks one string. `escaped` says it holds JSON text of its own (a tool
   * call's arguments): the finders read it as the vendor does, no value starts
   * or ends inside an escape or crosses a string's quote, and what is
   * remembered is the value unescaped, so the reply gets back what the agent
   * wrote. Nothing inside `keep` is touched.
   */
  maskText(raw: string, escaped = false, keep: readonly Range[] = []): MaskResult {
    const pass: Pass = { route: '', preview: false, hits: [] }
    const { text, n } = this.#mask(raw, escaped, keep, pass)
    return { text, n, hits: pass.hits }
  }

  /** maskText with nothing remembered: each value goes as the placeholder it would have (`/privacy test`). */
  preview(raw: string): MaskResult {
    const pass: Pass = { route: '', preview: true, hits: [] }
    const { text, n } = this.#mask(raw, false, [], pass)
    return { text, n, hits: pass.hits }
  }

  /**
   * The values of a string; with `view` (escaped), the finders read its text
   * and the values come back as places in `raw`. The rules read the view's
   * match text, where a quote an escape wrote inside a value stays in it.
   */
  #find(raw: string, view: DecodedView | undefined, escaped: boolean, pass: Pass): Found[] {
    const o = this.#options
    const s = view?.text ?? raw
    const forRules = view?.match ?? raw
    let low: string | undefined
    let lowRules: string | undefined
    const lower = (): string => (low ??= lowerASCII(s))
    const lowerRules = (): string => (lowRules ??= lowerASCII(forRules))
    // a cookie's value is one value however else it reads (a JWT in it, token=…): by its context first
    const cookies = o.secrets ? cookieSpans(s, o.cookies, lower) : []
    let found: Found[] = o.words && o.words.length > 0 ? wordSpans(s, o.words) : []
    for (const r of rules) {
      if (r.cat === 'secret' ? !o.secrets : !o.personal) continue
      found.push(...ruleSpans(r, forRules, lowerRules))
    }
    if (o.secrets || o.personal) {
      const known = (): KnownSpan[] => this.#table.knownSpans(s, this.#covers)
      const spans = pass.preview ? known() : this.#memo.spans(pass.route, this.#fingerprint, s, known)
      for (const k of spans) found.push({ ...k, by: 'known' })
    }
    if (cookies.length > 0) found = [...cookies, ...found.filter((f) => f.by === 'word' || !cookies.some((c) => overlaps(f, c)))]
    found = noNumbers(s, noIDs(s, found))
    if (view) found = inRaw(raw, view, found)
    return escaped ? inStrings(raw, found) : found
  }

  /** The masked string, how many values went, and each change as an edit of `raw`. */
  #mask(raw: string, escaped: boolean, keep: readonly Range[], pass: Pass): { text: string; n: number; edits: Edit[] } {
    const o = this.#options
    const none = { text: raw, n: 0, edits: [] }
    if (raw.length < 3 || (!o.secrets && !o.personal && !(o.words && o.words.length > 0))) return none
    const view = escaped && raw.includes('\\') ? decodedView(raw) : undefined
    let found = this.#find(raw, view, escaped, pass)
    if (found.length === 0) return none
    // nothing inside a placeholder already there: masking again changes nothing
    const fixed: Range[] = [...keep]
    if (raw.includes('{{')) {
      for (const m of raw.matchAll(PLACEHOLDER_RE)) fixed.push({ start: m.index, end: m.index + m[0].length })
    }
    // nor inside a made-up key already there: one that came back unrestored is not a key of its own
    if (this.#table.shapes > 0) fixed.push(...this.#table.shapeSpans(raw))
    if (fixed.length > 0) found = found.filter((f) => !fixed.some((r) => overlaps(f, r)))
    // the first to start, and of those the longest, wins where they overlap;
    // of two the same, the one found first (a key in API_KEY=… is an API_KEY)
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    const out: string[] = []
    const edits: Edit[] = []
    let last = 0
    let next = 0
    let n = 0
    // the string as it went, but with a warned value as its placeholder too: the context is cut from it
    const context = pass.at !== undefined
    const safe: string[] = []
    let safeLen = 0
    let safeLast = 0
    const marks: Array<{ hit: Hit; at: number; len: number }> = []
    const mark = (hit: Hit, start: number, end: number, shown: string): void => {
      if (!context) return
      const piece = raw.slice(safeLast, start)
      safe.push(piece, shown)
      marks.push({ hit, at: safeLen + piece.length, len: shown.length })
      safeLen += piece.length + shown.length
      safeLast = end
    }
    for (const f of found) {
      if (f.start < next) continue
      next = f.end
      const written = raw.slice(f.start, f.end)
      const v = escaped ? unescaped(written) : written
      if (this.#allow.has(v.toLowerCase())) continue
      const action = o.actions?.[f.kind]
      const h = hint(f.kind, v, PERSONAL_KINDS.has(f.kind))
      if (action !== undefined) {
        const tag = tagOf(this.#key, f.kind, v)
        const hit: Hit = { placeholder: tag, kind: f.kind, by: f.by, head: f.head ?? h.head, ...(h.tail ? { tail: h.tail } : {}), len: h.len, action }
        pass.hits.push(hit)
        mark(hit, f.start, f.end, tag)
        if (action === 'warn' && pass.warned) pass.warned.push([written, tag])
        // a preview never shows a value: it has the placeholder there still
        if (!pass.preview) continue
      }
      const p = action === undefined ? this.#standIn(f.kind, v, pass.preview) : { text: tagOf(this.#key, f.kind, v), id: '' }
      const text = f.bare ? `"${p.text}"` : p.text
      out.push(raw.slice(last, f.start), text)
      edits.push({ start: f.start, end: f.end, text })
      if (action === undefined) {
        const hit: Hit = { placeholder: p.id, kind: f.kind, by: f.by, head: f.head ?? h.head, ...(h.tail ? { tail: h.tail } : {}), len: h.len }
        pass.hits.push(hit)
        mark(hit, f.start, f.end, text)
      }
      last = f.end
      n++
    }
    if (context && marks.length > 0) {
      safe.push(raw.slice(safeLast))
      const all = safe.join('')
      for (const m of marks) {
        m.hit.before = clip(all.slice(Math.max(0, m.at - CONTEXT_CHARS * 4), m.at), CONTEXT_CHARS, true)
        m.hit.after = clip(all.slice(m.at + m.len, m.at + m.len + CONTEXT_CHARS * 4), CONTEXT_CHARS, false)
        if (pass.at) m.hit.at = pass.at
      }
    }
    if (n === 0) return none
    out.push(raw.slice(last))
    return { text: out.join(''), n, edits }
  }

  /**
   * Masks the strings of a request body going to `route` (its host). Null
   * when the body is not JSON or not a model request: the gateway sends those
   * as they are. Ids, names and kinds, the request's own definitions (but
   * their descriptions), the tool definitions and `<env>` blocks where
   * protected (docs/adr/0004) are left.
   */
  maskJSON(body: string, route = ''): MaskResult | null {
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
    const pass: Pass = { route, preview: false, hits: [], warned: [] }
    let n = 0
    const out = walkJSON(body, (path, key, s) => {
      if (protectTools && under(path, TOOL_ROOTS)) return s
      if (keepIn(path, key, s, args, defs)) return s
      if (this.#options.context) pass.at = placeOf(doc, path)
      const r = this.#mask(s, asJSON(key, ''), protectEnvBlock ? envBlockRanges(s) : [], pass)
      n += r.n
      // spliced into the literal as written, so what is not masked keeps its escapes
      return r.edits
    })
    // JSON.parse took it, so the walker must too: anything else is our bug
    if (out === null) throw new Error('request body is JSON but could not be walked')
    const model = typeof doc.model === 'string' ? doc.model : undefined
    const r: MaskResult = { text: out, n, hits: pass.hits }
    if (model !== undefined) r.model = model
    if (pass.warned && pass.warned.length > 0) r.warned = pass.warned
    return r
  }
}
