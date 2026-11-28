/**
 * The llm/stream half of the gateway. It masks a structured request before
 * the provider adapter serializes it and, only when restoreLog was on for the
 * request, restores placeholders in the reply before the host consumes it.
 */
import { RequestBlocked, type RequestInfo, type StructuredExchange, type StructuredMaskMeta, type StructuredMaskResult, type StructuredRecordFields } from './engine.ts'
import { KEPT } from './redact/json.ts'
import { placeOf, type Hit, type Place } from './redact/mask.ts'
import { mergeTally, newTally, type Restorer, type Tally } from './redact/restore.ts'
import { isExcluded } from './providers.ts'

export interface WireRequest {
  provider?: unknown
  model?: unknown
  messages?: readonly WireMessage[]
  system?: unknown
  tools?: readonly WireTool[]
  stop?: readonly unknown[]
  sessionId?: unknown
  purpose?: unknown
  signal?: unknown
  [key: string]: unknown
}

export type WireBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'reasoning'; text: string; [key: string]: unknown }
  | { type: 'tool-call'; id: string; name: string; arguments: string; [key: string]: unknown }
  | { type: 'tool-result'; content: readonly WireBlock[] | string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

export interface WireMessage {
  role?: unknown
  content: readonly WireBlock[] | string
  [key: string]: unknown
}

export interface WireTool {
  name?: unknown
  description?: unknown
  parameters?: unknown
  [key: string]: unknown
}

/** DSH's ToolHistory, read by projectToolUpdates after the llm/stream waterfall. */
export interface WireToolHistory {
  tools: readonly WireTool[]
  updates: readonly { messageId?: unknown; additions: readonly WireTool[]; [key: string]: unknown }[]
  [key: string]: unknown
}

export type WireChunk =
  | { type: 'block-start'; index: number; blockType: string; [key: string]: unknown }
  | { type: 'text-delta'; index: number; text: string; [key: string]: unknown }
  | { type: 'reasoning-delta'; index: number; text: string; [key: string]: unknown }
  | { type: 'tool-call-delta'; index: number; id?: unknown; name?: unknown; argumentsDelta: string; [key: string]: unknown }
  | { type: 'block-end'; index: number; block: WireBlock; [key: string]: unknown }
  | { type: 'usage'; [key: string]: unknown }
  | { type: 'finish'; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

interface DeltaChunk {
  type: 'text-delta' | 'reasoning-delta'
  index: number
  text: string
  [key: string]: unknown
}

interface BlockEndChunk {
  type: 'block-end'
  index: number
  block: WireBlock
  [key: string]: unknown
}

export interface StreamLlm {
  stream(options: WireRequest): AsyncIterable<WireChunk>
}

export type WireListener = (options: WireRequest, next: () => AsyncIterable<WireChunk>) => AsyncIterable<WireChunk>

export interface StreamOutcome {
  request: WireRequest
  /** Whether a masked copy, rather than the original object, must be dispatched. */
  changed: boolean
  restorer: Restorer
  tally: Tally
  restoring: boolean
  finish(): void
}

export interface StreamEngine {
  maskStructuredText(text: string, meta?: StructuredMaskMeta): StructuredMaskResult | null
  maskStructuredKey(text: string, at: Place): StructuredMaskResult | null
  maskStructuredJSON(text: string, meta?: StructuredMaskMeta): StructuredMaskResult | null
  recordStructuredRequest(fields: StructuredRecordFields): StructuredExchange
}

/**
 * A structured request this half does not know how to read. The gateway is
 * fail closed (docs/adr/0005): a shape it cannot walk might carry a value in a
 * place it would leave as it is, so the call is not sent at all.
 */
export class UnhandledShape extends Error {
  constructor(what: string) {
    super(`llm/stream request has ${what}, which this gateway cannot mask`)
    this.name = 'UnhandledShape'
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function infoOf(route: string, session: string | undefined): RequestInfo {
  return { host: route, path: 'llm/stream', ...(session ? { session } : {}) }
}

function hostMessage(message: { role?: unknown }): boolean {
  return message.role === 'system' || message.role === 'developer'
}

/** Canonical DSH fields that must survive even a custom sensitive-word rule. */
const STRUCTURED_KEYS = new Set([
  'content', 'arguments', 'parameters', 'description', 'attachment', 'source', 'toolName', 'isError', 'toolCallId',
  'deferLoading', 'updates', 'additions', 'offloaded', 'provider', 'messages', 'system', 'tools', 'toolHistory', 'stop',
  'sessionId', 'purpose', 'signal', 'reasoningEffort', 'temperature', 'maxTokens',
])

function structuredKey(path: readonly string[], name: string): boolean {
  if (STRUCTURED_KEYS.has(name) || KEPT.has(name)) return true
  return name === 'id' || name === 'ids' || name.endsWith('_id') || name.endsWith('_ids') || name.endsWith('Id') || name.endsWith('Ids') || (path.length === 0 && name === 'model')
}

/**
 * Masks non-structural object keys without walking live runtime objects or
 * adapter-private replay state. Tool declarations are handled by maskTool:
 * their JSON Schema property names and tool-call argument names stay intact.
 */
function maskStructuredKeys(
  engine: StreamEngine,
  original: WireRequest,
  node: unknown,
  raw: readonly string[],
  shown: readonly string[],
  accumulate: (result: StructuredMaskResult | null) => string | undefined,
): unknown {
  if (Array.isArray(node)) {
    let changed = false
    const out = node.map((value, i) => {
      const next = maskStructuredKeys(engine, original, value, [...raw, String(i)], [...shown, String(i)], accumulate)
      if (next !== value) changed = true
      return next
    })
    return changed ? out : node
  }
  if (!isObject(node)) return node
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    const rawChild = [...raw, key]
    // AbortSignal is live and unserializable; source.replayState is an opaque
    // adapter-private value. Neither is model content for this walker to edit.
    if (key === 'signal' || key === 'source' || (raw.length === 0 && (key === 'tools' || key === 'toolHistory'))) {
      out[key] = value
      continue
    }
    const at = placeOf(original, rawChild.join('.'), rawChild)
    const result = structuredKey(raw, key) ? null : engine.maskStructuredKey(key, at)
    if (result) {
      const safeAt = { ...at, path: [...shown, result.shown ?? result.text].join('.') }
      for (const hit of result.hits) hit.at = safeAt
    }
    const nextKey = accumulate(result) ?? key
    const shownKey = result?.shown ?? nextKey
    if (nextKey !== key && (Object.hasOwn(node, nextKey) || Object.hasOwn(out, nextKey))) {
      throw new UnhandledShape('object keys that collide after masking')
    }
    if (nextKey !== key) changed = true
    const nextValue = maskStructuredKeys(engine, original, value, rawChild, [...shown, shownKey], accumulate)
    if (nextValue !== value) changed = true
    out[nextKey] = nextValue
  }
  return changed ? out : node
}

/**
 * Masks every supported string without mutating the request. Unchanged
 * messages, blocks, arrays and tools keep their identities; a warning alone
 * does not force a copy. Masking errors, and a shape this half cannot read,
 * are recorded and fail the request.
 */
export function maskStructuredRequest(engine: StreamEngine, options: WireRequest, route: string, session: string | undefined, what: string): StreamOutcome {
  const started = performance.now()
  const info = infoOf(route, session)
  const model = typeof options.model === 'string' ? options.model : undefined
  let n = 0
  let warned = 0
  const hits: Hit[] = []
  const warnedForms: Array<[string, string]> = []
  const trueforms: Array<[string, string]> = []

  const accumulate = (r: StructuredMaskResult | null): string | undefined => {
    if (r === null) return undefined
    n += r.n
    warned += r.warned
    hits.push(...r.hits)
    warnedForms.push(...r.warnedForms ?? [])
    trueforms.push(...r.trueforms ?? [])
    return r.text
  }
  const maskText = (raw: string, at: Place, env = false, tool = false): string | undefined =>
    accumulate(engine.maskStructuredText(raw, { at, env, tool }))
  const maskArgs = (raw: string, at: Place): string | undefined => accumulate(engine.maskStructuredJSON(raw, { at }))

  let nextMessages: readonly WireMessage[] | undefined
  let nextSystem: string | readonly WireBlock[] | undefined
  let nextTools: readonly WireTool[] | undefined
  let nextToolHistory: WireToolHistory | undefined
  let nextStop: readonly unknown[] | undefined
  try {
    const walkBlocks = (blocks: readonly WireBlock[], path: string, env: boolean): readonly WireBlock[] => {
      let touched = false
      const out = blocks.map((block, i): WireBlock => {
        if (!isObject(block)) return block as WireBlock
        const at = `${path}.${i}`
        if (block.type === 'tool-result') {
          const content = (block as { content?: unknown }).content
          // Some hosts serialize a tool result as one plain string: mask it as
          // the free text it is, the way a message-level string content is.
          if (typeof content === 'string') {
            if (content === '') return block as WireBlock
            const next = maskText(content, placeOf(options, `${at}.content`), env)
            if (next === undefined || next === content) return block as WireBlock
            touched = true
            return { ...block, content: next } as WireBlock
          }
          if (Array.isArray(content)) {
            const next = walkBlocks(content as readonly WireBlock[], `${at}.content`, env)
            if (next === content) return block as WireBlock
            touched = true
            return { ...block, content: next } as WireBlock
          }
          // A result this half cannot read may hold a value in a place it would
          // leave as it is, so the request is not sent (docs/adr/0005).
          throw new UnhandledShape('a tool result whose content is neither text nor a block array')
        }
        if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call') return block as WireBlock
        const raw = block.type === 'tool-call' ? (block as { arguments?: unknown }).arguments : (block as { text?: unknown }).text
        if (raw === undefined) return block as WireBlock
        if (typeof raw !== 'string') throw new UnhandledShape(`a ${block.type} block whose payload is not text`)
        if (raw === '') return block as WireBlock
        const next = block.type === 'tool-call' ? maskArgs(raw, placeOf(options, `${at}.arguments`)) : maskText(raw, placeOf(options, `${at}.text`), env)
        if (next === undefined || next === raw) return block as WireBlock
        touched = true
        return (block.type === 'tool-call' ? { ...block, arguments: next } : { ...block, text: next }) as WireBlock
      })
      return touched ? out : blocks
    }

    /**
     * Masks the strings of a tool's parameter schema, as the dispatcher masks
     * that body while protectTools is off. Schema keys are tool-owned protocol,
     * so maskKeys never rewrites them (docs/adr/0029).
     */
    const maskSchema = (node: unknown, path: string): { value: unknown; changed: boolean } => {
      if (typeof node === 'string') {
        if (node === '') return { value: node, changed: false }
        const next = maskText(node, placeOf(options, path), false, true)
        return next === undefined || next === node ? { value: node, changed: false } : { value: next, changed: true }
      }
      if (Array.isArray(node)) {
        let changed = false
        const out = node.map((item, i) => {
          const masked = maskSchema(item, `${path}.${i}`)
          if (masked.changed) changed = true
          return masked.value
        })
        return { value: changed ? out : node, changed }
      }
      if (isObject(node)) {
        let changed = false
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(node)) {
          const masked = maskSchema(value, `${path}.${key}`)
          if (masked.changed) changed = true
          out[key] = masked.value
        }
        return { value: changed ? out : node, changed }
      }
      return { value: node, changed: false }
    }

    /** One tool definition: its description, and the schema of its parameters while protectTools is off. */
    const maskTool = (tool: WireTool, path: string): WireTool => {
      if (!isObject(tool)) return tool
      let next: Record<string, unknown> | undefined
      if (typeof tool.description === 'string' && tool.description !== '') {
        const masked = maskText(tool.description, placeOf(options, `${path}.description`), false, true)
        if (masked !== undefined && masked !== tool.description) next = { ...tool, description: masked }
      }
      if (isObject(tool.parameters)) {
        const masked = maskSchema(tool.parameters, `${path}.parameters`)
        if (masked.changed) next = { ...(next ?? tool), parameters: masked.value }
      }
      return (next ?? tool) as WireTool
    }

    const messages = options.messages
    if (messages !== undefined && !Array.isArray(messages)) throw new UnhandledShape('messages that are not an array')
    if (Array.isArray(messages)) {
      let touched = false
      const out = messages.map((message, i): WireMessage => {
        if (!isObject(message)) return message as WireMessage
        const content = message.content
        const env = hostMessage(message)
        if (typeof content === 'string') {
          if (content === '') return message as WireMessage
          const next = maskText(content, placeOf(options, `messages.${i}.content`), env)
          if (next === undefined || next === content) return message as WireMessage
          touched = true
          return { ...message, content: next } as WireMessage
        }
        if (Array.isArray(content)) {
          const next = walkBlocks(content, `messages.${i}.content`, env)
          if (next === content) return message as WireMessage
          touched = true
          return { ...message, content: next } as WireMessage
        }
        if (content === undefined) return message as WireMessage
        throw new UnhandledShape(`a message whose content is neither text nor a block array (messages.${i})`)
      })
      if (touched) nextMessages = out
    }

    // A block-array system prompt is a covered shape (docs/adr/0004): walk it like a message.
    const system = options.system
    if (system !== undefined) {
      if (typeof system === 'string') {
        if (system !== '') {
          const next = maskText(system, placeOf(options, 'system'), true)
          if (next !== undefined && next !== system) nextSystem = next
        }
      } else if (Array.isArray(system)) {
        const next = walkBlocks(system as readonly WireBlock[], 'system', true)
        if (next !== system) nextSystem = next
      } else {
        throw new UnhandledShape('a system prompt that is neither text nor a block array')
      }
    }

    if (options.tools !== undefined && !Array.isArray(options.tools)) throw new UnhandledShape('tools that are not an array')
    if (Array.isArray(options.tools)) {
      let touched = false
      const out = options.tools.map((tool, i): WireTool => {
        const next = maskTool(tool, `tools.${i}`)
        if (next !== tool) touched = true
        return next
      })
      if (touched) nextTools = out
    }

    // DSH projects this history into `tools` after the waterfall. Both the
    // baseline and every later addition therefore need the same masking.
    const history = options.toolHistory
    if (history !== undefined && !isObject(history)) throw new UnhandledShape('toolHistory that is not an object')
    if (isObject(history)) {
      if (!Array.isArray(history.tools) || !Array.isArray(history.updates)) {
        throw new UnhandledShape('toolHistory without a tools array and an updates array')
      }
      let touched = false
      let toolsChanged = false
      const tools = history.tools.map((tool, i): WireTool => {
        const next = maskTool(tool as WireTool, `toolHistory.tools.${i}`)
        if (next !== tool) touched = toolsChanged = true
        return next
      })
      const updates: WireToolHistory['updates'] = (history.updates as readonly unknown[]).map((update, i): WireToolHistory['updates'][number] => {
        if (!isObject(update) || !Array.isArray(update.additions)) throw new UnhandledShape(`toolHistory.updates.${i} without an additions array`)
        const checked = update as unknown as WireToolHistory['updates'][number]
        let changed = false
        const additions = checked.additions.map((tool, j): WireTool => {
          const next = maskTool(tool as WireTool, `toolHistory.updates.${i}.additions.${j}`)
          if (next !== tool) changed = true
          return next
        })
        if (!changed) return checked
        touched = true
        return { ...checked, additions }
      })
      if (touched) {
        nextToolHistory = {
          ...history,
          tools: toolsChanged ? tools : history.tools,
          updates,
        }
      }
    }

    if (Array.isArray(options.stop)) {
      let touched = false
      const out = options.stop.map((entry, i) => {
        if (typeof entry !== 'string' || entry === '') return entry
        const next = maskText(entry, placeOf(options, `stop.${i}`))
        if (next === undefined || next === entry) return entry
        touched = true
        return next
      })
      if (touched) nextStop = out
    }
  } catch (err) {
    engine.recordStructuredRequest({
      info, what, model, session, n, warned, hits, started, failed: true,
      ...(warnedForms.length > 0 ? { warnedForms } : {}),
      ...(trueforms.length > 0 ? { trueforms } : {}),
    })
    throw err
  }

  const changed = nextMessages !== undefined || nextSystem !== undefined || nextTools !== undefined || nextToolHistory !== undefined || nextStop !== undefined
  let request: WireRequest = changed
    ? {
        ...options,
        ...(nextMessages !== undefined ? { messages: nextMessages } : {}),
        ...(nextSystem !== undefined ? { system: nextSystem } : {}),
        ...(nextTools !== undefined ? { tools: nextTools } : {}),
        ...(nextToolHistory !== undefined ? { toolHistory: nextToolHistory } : {}),
        ...(nextStop !== undefined ? { stop: nextStop } : {}),
      }
    : options
  try {
    request = maskStructuredKeys(engine, options, request, [], [], accumulate) as WireRequest
  } catch (err) {
    engine.recordStructuredRequest({
      info, what, model, session, n, warned, hits, started, failed: true,
      ...(warnedForms.length > 0 ? { warnedForms } : {}),
      ...(trueforms.length > 0 ? { trueforms } : {}),
    })
    throw err
  }
  const exchange = engine.recordStructuredRequest({
    info,
    what,
    model,
    session,
    n,
    warned,
    hits,
    started,
    view: request,
    ...(warnedForms.length > 0 ? { warnedForms } : {}),
    ...(trueforms.length > 0 ? { trueforms } : {}),
  })
  return { request, changed: request !== options, restorer: exchange.restorer, tally: exchange.tally, restoring: exchange.restoring, finish: exchange.finish }
}

const MASKED_REQUESTS = new WeakSet<object>()

/** Marks a masked copy so its re-entry through the waterfall is not masked again. */
export function markMaskedRequest<T extends object>(request: T): T {
  MASKED_REQUESTS.add(request)
  return request
}

export function isMaskedRequest(request: unknown): boolean {
  return typeof request === 'object' && request !== null && MASKED_REQUESTS.has(request)
}

type ReplyExchange = Pick<StreamOutcome, 'restorer' | 'tally' | 'restoring' | 'finish'>

/**
 * Restores text and reasoning incrementally, then restores each assembled
 * block authoritatively. A live delta is counted in a tally of its own and
 * merged into the request's only where no block ever closes that index, so
 * one placeholder in a reply counts once (docs/adr/0040). Tool arguments are
 * judged and restored at block-end, before the tool executor reads them; a
 * call that only ever arrives as deltas is closed here, for the host would
 * otherwise assemble it from the placeholders. Held text is released before a
 * terminal chunk or normal EOF. Cancellation and errors discard it, finish
 * the request immediately, and never yield from cleanup; restoreLog off is a
 * strict pass-through.
 */
export function restoreWireStream(source: AsyncIterable<WireChunk>, exchange: ReplyExchange): AsyncIterable<WireChunk> {
  return (async function* () {
    if (!exchange.restoring) {
      try {
        for await (const chunk of source) yield chunk
      } finally {
        exchange.finish()
      }
      return
    }
    const { restorer, tally } = exchange
    const kinds = new Map<number, 'text-delta' | 'reasoning-delta'>()
    const held = new Map<number, string>()
    /** What each index's live text put back, kept apart until a block says whether it counts. */
    const live = new Map<number, Tally>()
    /** Tool calls whose deltas no block has closed yet. */
    const open = new Map<number, { id?: unknown; name?: unknown; args: string }>()
    const liveTally = (index: number): Tally => {
      let t = live.get(index)
      if (t === undefined) {
        t = newTally()
        live.set(index, t)
      }
      return t
    }
    const take = (index: number): { kind: 'text-delta' | 'reasoning-delta'; text: string } | undefined => {
      const kind = kinds.get(index)
      const text = held.get(index)
      kinds.delete(index)
      held.delete(index)
      if (kind === undefined || text === undefined) return undefined
      return { kind, text }
    }
    const drain = function* (): Generator<WireChunk> {
      for (const [index] of [...held]) {
        const tail = take(index)
        if (tail === undefined || tail.text === '') continue
        const text = restorer.restoreText(tail.text, false, liveTally(index), false)
        yield { type: tail.kind, index, text } as WireChunk
      }
    }
    /**
     * Closes the tool calls that only ever arrived as deltas. The host's
     * assembler takes a block over the deltas it accumulated, so this is what
     * the executor reads; a call it cannot name is not sent on at all.
     */
    const closeOpen = function* (): Generator<WireChunk> {
      for (const [index, call] of [...open].sort((a, b) => a[0] - b[0])) {
        open.delete(index)
        if (call.args === '' || !call.args.includes('_')) continue
        const name = typeof call.name === 'string' ? call.name : ''
        if (name === '') throw new UnhandledShape('a tool call that only arrived as deltas and cannot be named')
        const args = restorer.restoreTool(call.args, tally)
        yield { type: 'block-end', index, block: { type: 'tool-call', id: typeof call.id === 'string' ? call.id : '', name, arguments: args } } as WireChunk
      }
    }
    /** Keeps what the live text put back where no block ever counted it. */
    const settle = (): void => {
      for (const t of live.values()) mergeTally(tally, t)
      live.clear()
    }
    try {
      for await (const chunk of source) {
        switch (chunk.type) {
          case 'text-delta':
          case 'reasoning-delta': {
            const c = chunk as DeltaChunk
            if (!kinds.has(c.index)) {
              kinds.set(c.index, c.type)
              held.set(c.index, '')
            }
            const buf = (held.get(c.index) ?? '') + c.text
            const n = restorer.partialTail(buf)
            const ready = n > 0 ? buf.slice(0, buf.length - n) : buf
            held.set(c.index, buf.slice(buf.length - n))
            if (ready === '') continue
            const text = restorer.restoreText(ready, false, liveTally(c.index), false)
            yield text === ready && ready === c.text ? chunk : ({ ...chunk, text } as WireChunk)
            continue
          }
          case 'tool-call-delta': {
            const c = chunk as { index: number; id?: unknown; name?: unknown; argumentsDelta?: unknown }
            const call = open.get(c.index) ?? { id: c.id, name: c.name, args: '' }
            if (c.id !== undefined) call.id = c.id
            if (c.name !== undefined) call.name = c.name
            call.args += typeof c.argumentsDelta === 'string' ? c.argumentsDelta : ''
            open.set(c.index, call)
            // The assembled block is authoritative for tool execution.
            yield chunk
            continue
          }
          case 'block-end': {
            const c = chunk as BlockEndChunk
            const tail = take(c.index)
            if (tail !== undefined && tail.text !== '') {
              const text = restorer.restoreText(tail.text, false, liveTally(c.index), false)
              yield { type: tail.kind, index: c.index, text } as WireChunk
            }
            // The block is authoritative: the live counts of its index are dropped.
            live.delete(c.index)
            open.delete(c.index)
            const block = c.block
            if (isObject(block) && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
              const whole = restorer.restoreText(block.text, false, tally, false)
              yield whole === block.text ? chunk : ({ ...c, block: { ...block, text: whole } } as WireChunk)
              continue
            }
            if (isObject(block) && block.type === 'tool-call' && typeof block.arguments === 'string') {
              const args = restorer.restoreTool(block.arguments, tally)
              yield args === block.arguments ? chunk : ({ ...c, block: { ...block, arguments: args } } as WireChunk)
              continue
            }
            yield chunk
            continue
          }
          case 'usage':
          case 'finish':
            // DSH emits usage and finish after content: no held text may follow them.
            for (const pending of drain()) yield pending
            for (const closed of closeOpen()) yield closed
            yield chunk
            continue
          default:
            yield chunk
        }
      }
      for (const pending of drain()) yield pending
      for (const closed of closeOpen()) yield closed
    } finally {
      kinds.clear()
      held.clear()
      open.clear()
      settle()
      exchange.finish()
    }
  })()
}

export interface StreamGatewayOptions {
  engine: StreamEngine
  /** The current llm service; absent means the request must not bypass masking. */
  llm(): StreamLlm | undefined
  excluded(): readonly string[]
  sessionOff(session: string | undefined): boolean
  enabled(): boolean
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

function whatOfCall(options: WireRequest): string {
  return typeof options.purpose === 'string' && options.purpose !== '' ? options.purpose : 'chat'
}

function providerOf(options: WireRequest): string {
  return typeof options.provider === 'string' ? options.provider : ''
}

function failed(err: unknown): AsyncIterable<WireChunk> {
  return (async function* () {
    if (err instanceof RequestBlocked) throw err
    throw new Error('masking failed, request not sent')
  })()
}

/** Middleware and adapter failures keep their own identity and diagnostic. */
function thrown(err: unknown): AsyncIterable<WireChunk> {
  return (async function* () {
    throw err
  })()
}

/** The structured listener; all bypasses are explicit and re-entry is marked. */
export function makeStreamListener(o: StreamGatewayOptions): WireListener {
  const warnedProviders = new Set<string>()
  return (options, next) => {
    if (isMaskedRequest(options)) return next()
    const session = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
    const provider = providerOf(options)
    if (!o.enabled() || o.sessionOff(session)) return next()
    if (isExcluded(provider, o.excluded())) {
      const id = provider.toLowerCase()
      if (!warnedProviders.has(id)) {
        if (warnedProviders.size >= 32) warnedProviders.clear()
        warnedProviders.add(id)
        o.logger.warn(`dsh-privacy-gateway: requests of provider ${JSON.stringify(provider)} go out unmasked (excludeProviders); this is said once for that provider`)
      }
      return next()
    }
    const llm = o.llm()
    if (llm === undefined) {
      o.logger.warn('dsh-privacy-gateway: llm service unavailable, request not sent')
      return failed(new Error('llm service unavailable'))
    }
    let outcome: StreamOutcome
    try {
      outcome = maskStructuredRequest(o.engine, options, provider, session, whatOfCall(options))
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err
      o.logger.warn(`dsh-privacy-gateway: masking failed (${name}), request not sent`)
      return failed(err)
    }
    let source: AsyncIterable<WireChunk>
    try {
      if (outcome.changed) {
        o.logger.info('dsh-privacy-gateway: masked a call on llm/stream')
        source = llm.stream(markMaskedRequest(outcome.request))
      } else {
        source = next()
      }
    } catch (err) {
      outcome.finish()
      return thrown(err)
    }
    return restoreWireStream(source, outcome)
  }
}
