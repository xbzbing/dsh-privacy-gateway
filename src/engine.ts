import type { ResolvedConfig } from './config.ts'
import { valuesOf, whatOf, RecordStore, type MaskRecord } from './records.ts'
import { ValueTable } from './redact/known.ts'
import { Masker, type Hit, type MaskResult } from './redact/mask.ts'
import { jsonEscape, walkJSON } from './redact/json.ts'
import { decodedView } from './redact/find.ts'
import { bodies } from './redact/placeholder.ts'
import { newTally, Restorer, type StreamRestorer, type Tally } from './redact/restore.ts'
import { FirstSending } from './first.ts'
import type { ViewStore } from './views.ts'

/** Where a request goes, as the record keeps it. */
export interface RequestInfo {
  /** host or host:port. */
  host: string
  /** Path and query. */
  path: string
  session?: string
}

/** One masked request on its way: its body, and how to put its reply back. */
export interface Exchange {
  /** The body as it goes. */
  readonly text: string
  /** Whether the reply can hold a placeholder to put back: the log restore switch is on and the table holds values (docs/adr/0003). */
  restoring(): boolean
  /** Restores a whole JSON (or text) reply body. */
  restoreBody(text: string): string
  /** A restorer for one `text/event-stream` reply. */
  streamRestorer(): StreamRestorer
  /** The reply ended, or failed: the request's record is kept. Once only. */
  finish(): void
}

/** What the dispatcher needs from the redaction engine. */
export interface RedactionEngine {
  /** The request as it goes, or null when it goes as it is (not a model request, or masking is off). Throws when masking fails. */
  maskRequest(body: string, info: RequestInfo): Exchange | null
}

/**
 * A block action stopped the request (design §6): it is not sent. The message
 * names each value by its kind, its head and its length, never the value.
 */
export class RequestBlocked extends Error {
  readonly hits: readonly Hit[]
  constructor(hits: readonly Hit[]) {
    const seen = new Set<string>()
    const what: string[] = []
    for (const h of hits) {
      if (seen.has(h.placeholder)) continue
      seen.add(h.placeholder)
      what.push(`${h.kind} (${h.head}…, ${h.len} characters)`)
    }
    super(`request blocked: it has ${what.join(', ')}; remove the value or change the kind's action`)
    this.name = 'RequestBlocked'
    this.hits = hits
  }
}

export interface EngineLogger {
  warn(...args: unknown[]): void
}

export interface EngineOptions {
  /** Where the records go; a memory-only one by default. */
  records?: RecordStore
  logger?: EngineLogger
  /** Where the bodies as they went are kept for the vendor view (config vendorView); none keeps none. */
  views?: ViewStore
  /** The names a record keeps beside the session id: its title and its workspace (docs/adr/0020). */
  names?: (session: string) => { title?: string; workspace?: string }
  /** The turn and step that session was at when the request went (docs/adr/0030). */
  steps?: (session: string) => { turn: number; step: number } | undefined
}

function isLoopback(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || name.startsWith('127.')
}

/** The model a request names in its path (Gemini: …/models/<name>:generateContent). */
function modelInPath(path: string): string | undefined {
  const m = /\/models\/([^/:?]+)/.exec(path)
  return m ? decodeURIComponent(m[1] as string) : undefined
}

export class PrivacyEngine implements RedactionEngine {
  readonly #key: Uint8Array
  readonly #table: ValueTable
  /** Audit-only recent hits include warn/block values without granting masking or restoration authority. */
  readonly #auditForms = new Map<string, string>()
  #masker: Masker
  /** Audit has no wire exemptions: allow, actions, protected regions and disabled categories cannot expose known values. */
  #auditMasker: Masker
  #restorer: Restorer
  /** Keep the bodies for the vendor view (config vendorView); `reconfigure` changes it. */
  #keepViews: boolean
  /** Put a reply's placeholders back before the session log gets it (config restoreLog, docs/adr/0003); `reconfigure` changes it. */
  #restoreLog: boolean
  readonly records: RecordStore
  readonly #logger: EngineLogger | undefined
  readonly views: ViewStore | undefined
  readonly #names: ((session: string) => { title?: string; workspace?: string }) | undefined
  readonly #steps: ((session: string) => { turn: number; step: number } | undefined) | undefined
  /** Where each value was first sent, for the record's line about it (docs/adr/0030). */
  readonly #first = new FirstSending()
  /** `/privacy off` turns masking off until `/privacy on` or a restart; the config stays as it is. */
  active = true

  constructor(key: Uint8Array, config: ResolvedConfig, options: EngineOptions = {}) {
    this.#key = key
    this.#table = new ValueTable(config.maxValues)
    this.#masker = this.#maskerFor(config)
    this.#auditMasker = this.#maskerFor(config, true)
    this.#restorer = new Restorer(this.#table, config.toolGuard)
    this.#keepViews = config.vendorView
    this.#restoreLog = config.restoreLog
    this.#logger = options.logger
    this.#names = options.names
    this.#steps = options.steps
    this.views = options.views
    this.records = options.records ?? new RecordStore({ keepDays: config.keepDays, keepBytes: config.keepMegabytes * 1024 * 1024, keepRecords: config.keepRecords })
  }

  #maskerFor(config: ResolvedConfig, audit = false): Masker {
    return new Masker(this.#key, this.#table, {
      secrets: audit || config.secrets,
      personal: audit || config.personal,
      protectEnvBlock: !audit && config.protectEnvBlock,
      protectTools: !audit && config.protectTools,
      words: config.words,
      allow: audit ? [] : config.allow,
      cookies: { names: config.cookieNames, keep: audit ? [] : config.cookieKeep },
      actions: audit ? {} : notMasked(config.actions),
      shape: !audit && config.shape,
      maskKeys: config.maskKeys,
      context: !audit && config.recordContext,
    })
  }

  /**
   * The rules from `config` from the next request on (docs/adr/0021): the
   * finders and the reply guard are rebuilt, the value table stays, so a reply
   * to a request already sent is still restored. The log restore switch
   * (docs/adr/0003) is read when a request goes and held for its reply, so a
   * call in flight runs under the settings it went out with. The masker starts
   * with an empty memo of what was sent, which was keyed to the old rules.
   */
  reconfigure(config: ResolvedConfig): void {
    this.#masker = this.#maskerFor(config)
    this.#auditMasker = this.#maskerFor(config, true)
    this.#restorer = new Restorer(this.#table, config.toolGuard)
    this.#keepViews = config.vendorView
    this.#restoreLog = config.restoreLog
    // off drops the bodies kept: they are not to stay in memory once it is turned off
    if (!config.vendorView) this.views?.clear()
  }

  /** How many values the table holds. */
  get values(): number {
    return this.#table.size
  }

  /** What `text` would go as, with nothing remembered (`/privacy test`). */
  preview(text: string): MaskResult {
    return this.#masker.preview(text)
  }

  /** Safe display and query text for internal audit consumers; a projection failure omits the text. */
  auditText(text: string): string | undefined {
    return auditProjection(this.#auditMasker, [...this.#auditForms, ...this.#table.trueforms()])(text)
  }

  #rememberAudit(forms: ReadonlyArray<readonly [string, string]>): void {
    for (const [value, placeholder] of forms) {
      this.#auditForms.delete(value)
      this.#auditForms.set(value, placeholder)
      if (this.#auditForms.size > this.#table.maxValues) {
        const oldest = this.#auditForms.keys().next()
        if (!oldest.done) this.#auditForms.delete(oldest.value)
      }
    }
  }

  maskRequest(body: string, info: RequestInfo): Exchange | null {
    if (!this.active) return null
    const started = performance.now()
    const time = new Date().toISOString()
    // where the session was when the request went: read once, so the record and the values it carries agree
    const step = info.session ? this.#steps?.(info.session) : undefined
    const masker = this.#masker
    const auditMasker = this.#auditMasker
    const known = [...this.#auditForms, ...this.#table.trueforms()]
    let project: (text: string) => string | undefined
    // Raw metadata is used only for lookups and routing; every persisted string has its own audit projection.
    const base = () => {
      const names = info.session ? this.#names?.(info.session) : undefined
      const session = info.session ? project(info.session) : undefined
      const title = names?.title !== undefined ? project(names.title) : undefined
      const workspace = names?.workspace !== undefined ? project(names.workspace) : undefined
      return {
        time,
        what: whatOf(info.path),
        host: project(info.host) ?? '',
        ...(isLoopback(info.host) ? { relay: true as const } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        ...step,
      }
    }
    let r: MaskResult | null
    try {
      r = masker.maskJSON(body, info.host)
    } catch (err) {
      project = auditProjection(auditMasker, known)
      const rawModel = modelInPath(info.path)
      const model = rawModel !== undefined ? project(rawModel) : undefined
      this.records.add({ ...base(), ...(model ? { model } : {}), tookMs: elapsed(started), n: 0, values: [], restored: 0, unmapped: 0, failed: true }, info.session)
      throw err
    }
    if (r === null) return null
    const tookMs = elapsed(started)
    this.#rememberAudit(r.trueforms ?? [])
    project = auditProjection(auditMasker, [...known, ...this.#auditForms, ...this.#table.trueforms(), ...(r.trueforms ?? [])])
    const rawModel = r.model ?? modelInPath(info.path)
    const model = rawModel !== undefined ? project(rawModel) : undefined
    const hits = r.hits.map((hit) => auditHit(hit, project))
    let warned = 0
    const blocks: Hit[] = []
    for (const h of hits) {
      if (h.action === 'warn') warned++
      else if (h.action === 'block') blocks.push(h)
    }
    const values = valuesOf(hits)
    // each value says which request sent it the first time, one step behind what produced it (docs/adr/0030)
    if (info.session !== undefined && step !== undefined) {
      for (const v of values) {
        const first = this.#first.get(info.session, v.placeholder)
        // A blocked attempt can refer to an earlier sending, but cannot create one.
        if (first && (first.turn !== step.turn || first.step !== step.step)) v.first = first
      }
    }
    const record: Omit<MaskRecord, 'key'> = { ...base(), ...(model ? { model } : {}), tookMs, n: r.n, ...(warned > 0 ? { warned } : {}), values, restored: 0, unmapped: 0 }
    if (blocks.length > 0) {
      this.records.add({ ...record, blocked: true }, info.session)
      throw new RequestBlocked(blocks)
    }
    if (info.session !== undefined && step !== undefined) {
      for (const v of values) this.#first.note(info.session, v.placeholder, step)
    }
    const tally: Tally = newTally()
    // the reply goes through the guard this request was sent under, whatever reconfigure does meanwhile
    const restorer = this.#restorer
    // and through the log restore switch it was sent under too: a reply on its way keeps the setting it
    // went out with, so the request header and the reply's handling never disagree (docs/adr/0003, 0021)
    const restoreLog = this.#restoreLog
    const sentText = r.text
    let done = false
    return {
      text: r.text,
      // off, the placeholders in the reply are left alone: they reach the agent and the session log as they are (docs/adr/0003)
      restoring: () => restoreLog && this.#table.size > 0,
      restoreBody: (text) => restorer.restoreJSON(text, tally),
      streamRestorer: () => restorer.stream(tally),
      finish: () => {
        if (done) return
        done = true
        let restored = 0
        for (const n of tally.restored.values()) restored += n
        // a request with nothing masked and nothing put back is not recorded (docs/adr/0008)
        if (record.n === 0 && warned === 0 && restored === 0 && tally.unmapped === 0 && tally.exfil === 0) return
        const hosts = [...tally.exfilHosts].map(project).filter((host): host is string => host !== undefined)
        if (tally.exfil > 0) {
          const left = tally.exfilBlocked > 0 ? `; ${tally.exfilBlocked} placeholders were left in them` : ''
          this.#logger?.warn(`dsh-privacy-gateway: ${tally.exfil} tool calls had a value put back in arguments that name ${hosts.join(', ')}${left}`)
        }
        const rec = this.records.add({
          ...record,
          restored,
          ...(tally.inTools > 0 ? { restoredInTools: tally.inTools } : {}),
          unmapped: tally.unmapped,
          ...(tally.exfil > 0 ? { exfil: tally.exfil, exfilHosts: hosts } : {}),
          ...(tally.exfilBlocked > 0 ? { exfilBlocked: tally.exfilBlocked } : {}),
        }, info.session)
        if (this.views && this.#keepViews) this.views.put(rec.key, warnedView(sentText, r.warned, [...known, ...(r.trueforms ?? [])].map(([, placeholder]) => placeholder)))
      },
    }
  }
}

/** Canonical stand-ins are opaque; decoded literal matches map back to the original escaped text. */
function literalProjector(known: ReadonlyArray<readonly [string, string]>, standIns: readonly string[] = known.map(([, placeholder]) => placeholder)): (text: string) => string {
  const byForm = new Map<string, string>()
  for (const [value, placeholder] of warnedForms(known)) {
    const decoded = decodedView(value).text
    for (const candidate of [value, decoded, decodedView(decoded).text]) {
      if (candidate !== '') for (const form of [candidate, candidate.toLowerCase(), candidate.toUpperCase()]) byForm.set(form, placeholder)
    }
  }
  const compile = (values: readonly string[]): RegExp | undefined => values.length > 0 ? new RegExp([...new Set(values)].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined
  const pattern = compile([...byForm.keys()])
  const atoms = compile(standIns.filter((value) => value !== ''))
  return (text) => {
    if (!pattern) return text
    const views: Array<{ text: string; at?: Int32Array }> = [{ text }]
    for (let n = 0; n < 2; n++) {
      const prior = views[views.length - 1] as { text: string; at?: Int32Array }
      if (!prior.text.includes('\\')) break
      const view = decodedView(prior.text)
      if (view.text === prior.text) break
      views.push({ text: view.text, at: prior.at ? Int32Array.from(view.at, (at) => prior.at?.[at] as number) : view.at })
    }
    const edits: Array<{ start: number; end: number; text: string }> = []
    for (const view of views) {
      const opaque = [...bodies(view.text), ...(atoms ? [...view.text.matchAll(atoms)].map((match) => ({ start: match.index, end: match.index + match[0].length })) : [])]
      for (const match of view.text.matchAll(pattern)) {
        const start = match.index
        const end = start + match[0].length
        if (opaque.some((atom) => start < atom.end && end > atom.start)) continue
        edits.push({ start: view.at?.[start] ?? start, end: view.at?.[end] ?? end, text: byForm.get(match[0]) ?? '' })
      }
    }
    edits.sort((a, b) => a.start - b.start || b.end - a.end)
    const out: string[] = []
    let last = 0
    for (const edit of edits) {
      if (edit.start < last) continue
      out.push(text.slice(last, edit.start), edit.text)
      last = edit.end
    }
    out.push(text.slice(last))
    return out.join('')
  }
}

/** Warned literals can use noncanonical escapes without exposing decoded values or corrupting protocol atoms. */
function warnedView(text: string, warned: MaskResult['warned'], standIns: readonly string[]): string {
  if (!warned?.length) return text
  try {
    const project = literalProjector(warned, standIns)
    const out = walkJSON(text, (_path, _shown, _key, value) => project(value), (_path, _shown, name) => {
      const safe = project(name)
      return safe === name ? undefined : safe
    })
    return out === null ? '' : project(out)
  } catch {
    return ''
  }
}

/** Audit replaces known literals independently of wire exemptions, with one matcher per request. */
function auditProjection(masker: Masker, known: ReadonlyArray<readonly [string, string]>): (text: string) => string | undefined {
  try {
    const project = literalProjector(known)
    return (text) => {
      try { return masker.preview(project(text)).text } catch { return undefined }
    }
  } catch {
    return () => undefined
  }
}

/** Kept role/type and other contextual metadata have no exemption from the audit boundary. */
function auditHit(hit: Hit, project: (text: string) => string | undefined): Hit {
  const { head, tail, before, after, at, ...safe } = hit
  const shownTail = tail !== undefined ? project(tail) : undefined
  const shownBefore = before !== undefined ? project(before) : undefined
  const shownAfter = after !== undefined ? project(after) : undefined
  const path = at ? project(at.path) : undefined
  const role = at?.role !== undefined ? project(at.role) : undefined
  const type = at?.type !== undefined ? project(at.type) : undefined
  return {
    ...safe,
    head: project(head) ?? '',
    ...(shownTail !== undefined ? { tail: shownTail } : {}),
    ...(shownBefore !== undefined ? { before: shownBefore } : {}),
    ...(shownAfter !== undefined ? { after: shownAfter } : {}),
    ...(path !== undefined ? { at: { path, ...(role !== undefined ? { role } : {}), ...(type !== undefined ? { type } : {}) } } : {}),
  }
}

/** Each warned value in the forms a body may have it in: as it is, escaped once (a JSON string) and twice (a tool call's arguments). */
function warnedForms(warned: ReadonlyArray<readonly [string, string]> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [w, p] of warned ?? []) {
    const once = jsonEscape(w)
    out.push([w, p])
    if (once !== w) out.push([once, p], [jsonEscape(once), p])
  }
  return out
}

/** The actions that leave a value unmasked. */
function notMasked(actions: ResolvedConfig['actions']): Record<string, 'warn' | 'block'> {
  const out: Record<string, 'warn' | 'block'> = {}
  for (const [kind, a] of Object.entries(actions)) if (a === 'warn' || a === 'block') out[kind] = a
  return out
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100
}
