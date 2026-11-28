import type { ResolvedConfig } from './config.ts'
import { valuesOf, whatOf, RecordStore, type DetectionActivity, type LoadedRecord, type MaskRecord } from './records.ts'
import { ValueTable } from './redact/known.ts'
import { Masker, type Hit, type MaskResult, type Place } from './redact/mask.ts'
import { jsonEscape, walkJSON } from './redact/json.ts'
import { decodedView } from './redact/find.ts'
import { bodies } from './redact/placeholder.ts'
import { newTally, Restorer, type StreamRestorer, type Tally, type ToolGuard } from './redact/restore.ts'
import { knownKind } from './redact/kinds.ts'
import { FirstSending } from './first.ts'
import type { ViewStore } from './views.ts'
import { envBlockRanges } from './protect.ts'

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
  /** The reply ended, or failed: the request's record is kept. Once only. `partial` says the reply was cut off. */
  finish(partial?: boolean): void
}

/** What the dispatcher needs from the redaction engine. */
export interface RedactionEngine {
  /** The request as it goes, or null when it goes as it is (not a model request, or masking is off). Throws when masking fails. */
  maskRequest(body: string, info: RequestInfo): Exchange | null
}

/** Where one structured string sits, and which protected region semantics apply to it. */
export interface StructuredMaskMeta {
  at?: Place
  /** Host-written system text, where configured <env> blocks stay byte for byte. */
  env?: boolean
  /** A tool definition, skipped while protectTools is on. */
  tool?: boolean
}

export interface StructuredMaskResult {
  text: string
  /** A key's audit-only projection; warned keys keep their wire text but not their record path. */
  shown?: string
  hits: Hit[]
  warned: number
  n: number
  /** Request-only view projection inputs, never persisted as records. */
  warnedForms?: MaskResult['warned']
  /** Request-only audit projection inputs, matching maskJSON's trueforms boundary. */
  trueforms?: MaskResult['trueforms']
}

/** The reply side and deferred record of one structured request. */
export interface StructuredExchange {
  readonly restorer: Restorer
  readonly tally: Tally
  /** The restoreLog setting this request went out with. */
  readonly restoring: boolean
  /** Writes restored, unknown-placeholder, tool and exfiltration counts once. */
  finish(): void
}

export interface StructuredRecordFields {
  info: RequestInfo
  what: string
  model?: string
  session?: string
  n: number
  warned: number
  hits: readonly Hit[]
  started: number
  /** The redispatched structured request for vendorView, without its live AbortSignal. */
  view?: unknown
  warnedForms?: MaskResult['warned']
  trueforms?: MaskResult['trueforms']
  failed?: boolean
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
  /** Keep request copies for the vendor view (config vendorView); `reconfigure` changes it. */
  #keepViews: boolean
  /** Whether non-structural JSON keys are content too (docs/adr/0029). */
  #maskKeys: boolean
  /** Put a reply's placeholders back before the session log gets it (config restoreLog, docs/adr/0003); `reconfigure` changes it. */
  #restoreLog: boolean
  #protectEnvBlock: boolean
  #protectTools: boolean
  /** The reply guard this run sends under, as the record's settings say (docs/adr/0039). */
  #guard: ToolGuard
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
    this.#maskKeys = config.maskKeys
    this.#restoreLog = config.restoreLog
    this.#protectEnvBlock = config.protectEnvBlock
    this.#protectTools = config.protectTools
    this.#guard = config.toolGuard
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
    this.#maskKeys = config.maskKeys
    this.#restoreLog = config.restoreLog
    this.#protectEnvBlock = config.protectEnvBlock
    this.#protectTools = config.protectTools
    this.#guard = config.toolGuard
    // off drops the bodies kept: they are not to stay in memory once it is turned off
    if (!this.#keepViews) this.views?.clear()
  }

  /** How many values the table holds. */
  get values(): number {
    return this.#table.size
  }

  /** What `text` would go as, with nothing remembered (`/privacy test`). */
  preview(text: string): MaskResult {
    return this.#masker.preview(text)
  }

  /** Masks one free-text string of a structured llm/stream request. */
  maskStructuredText(text: string, meta: StructuredMaskMeta = {}): StructuredMaskResult | null {
    if (!this.active || (meta.tool === true && this.#protectTools)) return null
    const keep = this.#protectEnvBlock && meta.env === true ? envBlockRanges(text) : []
    const r = this.#masker.maskText(text, false, keep, meta.at)
    return this.#structuredResult(r)
  }

  /** Masks one non-structural key of a structured request, with an audit-safe path for its hits. */
  maskStructuredKey(text: string, at: Place): StructuredMaskResult | null {
    if (!this.active || !this.#maskKeys) return null
    const r = this.#masker.maskKey(text, '')
    const result = this.#structuredResult({ ...r, hits: r.hits.map((hit) => ({ ...hit, at })) })
    return result === null ? null : { ...result, shown: r.shown }
  }

  /** Masks a tool call's JSON values, preserving its argument names and escapes. */
  maskStructuredJSON(text: string, meta: StructuredMaskMeta = {}): StructuredMaskResult | null {
    if (!this.active) return null
    const r = this.#masker.maskJSONArguments(text, '', meta.at)
    return this.#structuredResult(r)
  }

  #structuredResult(r: MaskResult): StructuredMaskResult | null {
    if (r.n === 0 && r.hits.length === 0) return null
    const hits = [...r.hits]
    let warned = 0
    for (const h of hits) if (h.action === 'warn') warned++
    return {
      text: r.text,
      hits,
      warned,
      n: r.n,
      ...(r.warned?.length ? { warnedForms: r.warned } : {}),
      ...(r.trueforms?.length ? { trueforms: r.trueforms } : {}),
    }
  }

  /**
   * Creates the deferred record and reply snapshot for a structured request.
   * Failure and block records are written immediately; a successful one is
   * finished after its reply so restoration and exfiltration counts are kept.
   */
  recordStructuredRequest(fields: StructuredRecordFields): StructuredExchange {
    const started = fields.started
    const info = fields.info
    this.#rememberAudit(fields.trueforms ?? [])
    const step = fields.session ? this.#steps?.(fields.session) : undefined
    // the audit boundary of maskRequest (v0.4.0): every persisted string is projected
    const auditMasker = this.#auditMasker
    const known = [...this.#auditForms, ...this.#table.trueforms(), ...(fields.trueforms ?? [])]
    const project = auditProjection(auditMasker, known)
    const rawModel = fields.model
    const model = rawModel !== undefined ? project(rawModel) : undefined
    const shownHost = project(info.host) ?? ''
    const shownSession = fields.session !== undefined ? project(fields.session) : undefined
    const names = fields.session !== undefined ? this.#names?.(fields.session) : undefined
    const title = names?.title !== undefined ? project(names.title) : undefined
    const workspace = names?.workspace !== undefined ? project(names.workspace) : undefined
    const hits = fields.hits.map((hit) => auditHit(hit, project))
    const values = valuesOf(hits)
    if (fields.session !== undefined && step !== undefined) {
      for (const v of values) {
        const first = this.#first.get(fields.session, v.placeholder)
        // A blocked attempt can refer to an earlier sending, but cannot create one.
        if (first && (first.turn !== step.turn || first.step !== step.step)) v.first = first
      }
    }
    const record: Omit<MaskRecord, 'key'> = {
      time: new Date().toISOString(),
      what: whatOf(fields.what),
      host: shownHost,
      ...(isLoopback(info.host) ? { relay: true as const } : {}),
      ...(shownSession !== undefined ? { session: shownSession } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(fields.session ? { ...step } : {}),
      ...(model !== undefined ? { model } : {}),
      tookMs: elapsed(started),
      n: fields.n,
      ...(fields.warned > 0 ? { warned: fields.warned } : {}),
      values,
      restored: 0,
      unmapped: 0,
    }
    const restorer = this.#restorer
    const tally = newTally()
    if (fields.failed) {
      this.records.add({ ...record, failed: true }, fields.session)
      return { restorer, tally, restoring: false, finish: () => {} }
    }
    const blocks = hits.filter((h) => h.action === 'block')
    if (blocks.length > 0) {
      this.records.add({ ...record, blocked: true }, fields.session)
      throw new RequestBlocked(blocks)
    }
    if (fields.session !== undefined && step !== undefined) {
      for (const v of values) this.#first.note(fields.session, v.placeholder, step)
    }
    // the same condition the dispatcher's restoring() answers: with the log restore
    // switch off, or with no value to put back, the reply passes through untouched
    const restoring = this.#restoreLog && this.#table.size > 0
    // A stream copy is the structured request about to be redispatched, not the adapter's eventual wire body.
    const sentView = this.views && this.#keepViews ? structuredView(fields.view) : undefined
    let done = false
    return {
      restorer,
      tally,
      restoring,
      finish: () => {
        if (done) return
        done = true
        let restored = 0
        for (const n of tally.restored.values()) restored += n
        if (record.n === 0 && (record.warned ?? 0) === 0 && restored === 0 && tally.unmapped === 0 && tally.exfil === 0) return
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
        }, fields.session)
        if (sentView !== undefined && this.views && this.#keepViews) {
          this.views.put(rec.key, warnedView(sentView, fields.warnedForms, known.map(([, placeholder]) => placeholder)))
        }
      },
    }
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

  /**
   * What the reply path actually did (docs/adr/0039). A setting on is not
   * proof: an empty table, a reply that never came or a guard turned off all
   * leave it skipped, and a cut-off reply leaves it partial.
   */
  #activity(restoreLog: boolean, tally: Tally, partial: boolean, path: 'unknown' | 'exfil'): DetectionActivity {
    if (!restoreLog) return { state: 'skipped', reasons: ['restore-disabled'] }
    // the guard only decides the exfiltration path; an unknown marker is read
    // for either way the reply goes
    if (path === 'exfil' && this.#guard === 'off') return { state: 'skipped', reasons: ['guard-off'] }
    if (this.#table.size === 0) return { state: 'skipped', reasons: ['no-value-table'] }
    if (!tally.sawReply) return { state: 'skipped', reasons: ['no-reply'] }
    return partial ? { state: 'partial', reasons: ['incomplete-reply'] } : { state: 'executed' }
  }

  /**
   * One stored row as the card may show it (docs/adr/0039): every string
   * projected again under today's rules, so a rule that came later still
   * hides what it names. A projection that fails omits the field.
   */
  detail(row: LoadedRecord): MaskRecord {
    const project = auditProjection(this.#auditMasker, [...this.#auditForms, ...this.#table.trueforms()])
    const text = (value: string | undefined): string | undefined => (value === undefined ? undefined : project(value))
    const out: MaskRecord = {
      key: row.key ?? 0,
      time: row.time,
      tookMs: row.tookMs,
      what: row.what,
      host: text(row.host) ?? '',
      n: row.n,
      values: row.values.map((v) => ({
        ...v,
        ...(v.head === '' ? {} : { head: text(v.head) ?? '' }),
        ...(v.tail !== undefined ? { tail: text(v.tail) } : {}),
        ...(v.before !== undefined ? { before: text(v.before) } : {}),
        ...(v.after !== undefined ? { after: text(v.after) } : {}),
        ...(v.at ? { at: { path: text(v.at.path) ?? '', ...(v.at.role !== undefined ? { role: text(v.at.role) } : {}), ...(v.at.type !== undefined ? { type: text(v.at.type) } : {}) } } : {}),
      })),
      restored: row.restored,
      unmapped: row.unmapped,
    }
    if (row.relay === true) out.relay = true
    if (row.blocked === true) out.blocked = true
    if (row.failed === true) out.failed = true
    if (row.warned !== undefined) out.warned = row.warned
    if (row.restoredInTools !== undefined) out.restoredInTools = row.restoredInTools
    if (row.exfil !== undefined) out.exfil = row.exfil
    if (row.exfilBlocked !== undefined) out.exfilBlocked = row.exfilBlocked
    if (row.valuesOmitted !== undefined) out.valuesOmitted = row.valuesOmitted
    if (row.exfilHosts) out.exfilHosts = row.exfilHosts.map((h) => text(h) ?? '')
    if (row.model !== undefined) out.model = text(row.model)
    if (row.session !== undefined) out.session = text(row.session)
    if (row.title !== undefined) out.title = text(row.title)
    if (row.workspace !== undefined) out.workspace = text(row.workspace)
    if (row.turn !== undefined && row.step !== undefined) {
      out.turn = row.turn
      out.step = row.step
    }
    if (row.detection) out.detection = row.detection
    // An unknown note's kind is one of ours or the fixed word; never the model's.
    if (row.unknown) out.unknown = row.unknown.map((u) => ({ ...u, kind: knownKind(u.kind) }))
    return out
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
      finish: (partial = false) => {
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
          detection: {
            settings: { restoreLog, toolGuard: this.#guard },
            unknown: this.#activity(restoreLog, tally, partial, 'unknown'),
            exfil: this.#activity(restoreLog, tally, partial, 'exfil'),
          },
          ...(tally.unknown.length > 0
            ? { unknown: tally.unknown.map((u, i) => ({ id: `unknown-${i + 1}`, kind: u.kind, n: u.n, ...(u.tool ? { tool: true as const } : {}) })) }
            : {}),
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

/** Serializes only plain request data, without invoking a third-party toJSON. */
function structuredView(request: unknown): string | undefined {
  if (request === undefined) return undefined
  try {
    const seen = new WeakSet<object>()
    const copy = (value: unknown): unknown => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value !== 'object') return undefined
      if (seen.has(value)) throw new Error('cyclic structured request')
      seen.add(value)
      try {
        if (Array.isArray(value)) return value.map((entry) => copy(entry) ?? null)
        const out: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(value)) {
          if (key === 'signal') continue
          const projected = copy(entry)
          if (projected !== undefined) out[key] = projected
        }
        return out
      } finally {
        seen.delete(value)
      }
    }
    const projected = copy(request)
    return projected === undefined ? undefined : JSON.stringify(projected, null, 2)
  } catch {
    // A third-party request may contain a cycle, a getter that throws, or a
    // value JSON cannot represent. An optional view never stops the call.
    return undefined
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
