import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { MaskRecord, Stats } from './records.ts'

/**
 * What the settings card reads (design §7.4), through the typert Gateway as
 * `privacyGateway/overview` on the shared `/api` channel. Counts and hints
 * only: a record never has a value in it (docs/adr/0008).
 */

export interface OverviewRequest {
  /** How many of the latest records to send; 1–200, default 50. */
  limit?: number
  /** Only this session's records and sums (the sidebar panel, docs/adr/0021). */
  session?: string
}

export interface Overview {
  /** Masking is effectively on: the run switch (`/privacy on|off`) and the configuration both say so. */
  active: boolean
  secrets: boolean
  personal: boolean
  /** Records go to disk too. */
  record: boolean
  /** Values the table holds. */
  values: number
  stats: Stats
  /** The latest records, newest first. */
  recent: MaskRecord[]
  /** The session the sums and records are about; absent means every session. */
  session?: string
  /** The vendor view is on (config vendorView). */
  vendorView?: boolean
  /** The keys of the records whose body as it went is kept. */
  views?: number[]
  /** The sidebar tab is offered (config showPanel). */
  showPanel?: boolean
  /** Providers whose requests go on unmasked (config excludeProviders). */
  excludeProviders?: string[]
  /** With `session`: whether masking is on for that session (docs/adr/0023). */
  sessionMasking?: boolean
}

export interface SessionMaskingRequest {
  session: string
  /** Masking on (the default) or off for this session. */
  on: boolean
}

export interface VendorViewRequest {
  /** The record's key. */
  key: number
}

/** A recorded request's body as the vendor got it, a warned value as its placeholder (docs/adr/0016). */
export interface VendorView {
  key: number
  body: string
}

/** One provider route with an adapter, as the excludeProviders choice lists it. */
export interface ProviderEntry {
  /** The provider route key (`deepseek`, `openai`, …). */
  id: string
  /** Its human-readable name. */
  name: string
}

/** What a reset cleared. */
export interface ResetResult {
  /** Day files deleted from disk. */
  files: number
}

/** What the service reads from the plugin. */
export interface OverviewSource {
  overview(limit: number, session?: string): Overview
  /** The providers with an adapter now (host `llm.listProviders()`). */
  providers?(): ProviderEntry[]
  /** The body kept for `key`, or null when the view is off or it is not kept. */
  vendorView?(key: number): VendorView | null
  /** Clears the records, the sums and the kept bodies, on disk too (docs/adr/0022). */
  reset?(): Promise<ResetResult>
  /** Turns masking on or off for one session (docs/adr/0023); the state after. */
  setSessionMasking?(session: string, on: boolean): boolean
}

export const NAMESPACE = 'privacyGateway'

/** The longest session id the service takes. */
export const MAX_SESSION_ID = 128

/** A session id as the host makes them: up to MAX_SESSION_ID letters, digits, `_`, `.`, `:` or `-`. */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID && /^[\w.:-]+$/.test(id)
}

export function clampLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50
}

export class PrivacyGatewayService extends TypertRemoteService {
  // a plain field: cordis hands the service out behind a Proxy, which a #field does not survive
  readonly source: OverviewSource

  constructor(ctx: Context, source: OverviewSource) {
    super(ctx, NAMESPACE)
    this.source = source
  }

  /** The state, the sums and the latest records; with `session`, only that session's. */
  async overview(request: OverviewRequest): Promise<Overview> {
    const session = typeof request?.session === 'string' && request.session !== '' ? request.session : undefined
    return this.source.overview(clampLimit(request?.limit), session)
  }

  /** The providers with an adapter, for the excludeProviders choice. */
  async providers(): Promise<ProviderEntry[]> {
    return this.source.providers?.() ?? []
  }

  /** Clears the history; the value table stays, so replies on their way are still restored. */
  async reset(): Promise<ResetResult> {
    if (!this.source.reset) throw new Error('reset is not offered')
    return this.source.reset()
  }

  /** Turns masking on or off for one session; answers whether it is on now. */
  async sessionMasking(request: SessionMaskingRequest): Promise<{ on: boolean }> {
    const session = request?.session
    // the id is written to the switch file and the log: one the host would not make is refused
    if (!isSessionId(session) || typeof request?.on !== 'boolean') throw new Error(`a session id (1–${MAX_SESSION_ID} of A–Z, a–z, 0–9, _ . : -) and on: true|false are needed`)
    if (!this.source.setSessionMasking) throw new Error('per-session masking is not offered')
    return { on: this.source.setSessionMasking(session, request.on) }
  }

  /** One recorded request as the vendor got it, or null. */
  async vendorView(request: VendorViewRequest): Promise<VendorView | null> {
    const key = request?.key
    if (typeof key !== 'number' || !Number.isSafeInteger(key)) return null
    return this.source.vendorView?.(key) ?? null
  }
}

/**
 * Marks `overview` as a Remote method, as `@Remote('overview')` would: Node
 * runs this source as it is (type stripping has no decorators), so the
 * decorator is applied by hand. Its initializer records the marker on the
 * prototype, which is what the Gateway's source mode reads.
 */
function markRemote(cls: { prototype: object }, method: string): void {
  const inits: Array<() => void> = []
  const decorate = Remote(method) as unknown as (value: unknown, context: unknown) => void
  decorate((cls.prototype as Record<string, unknown>)[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    metadata: undefined,
    access: { has: (o: object) => method in o, get: (o: Record<string, unknown>) => o[method] },
    addInitializer: (fn: () => void) => inits.push(fn),
  })
  const probe = Object.create(cls.prototype) as object
  for (const fn of inits) fn.call(probe)
}

markRemote(PrivacyGatewayService, 'overview')
markRemote(PrivacyGatewayService, 'vendorView')
markRemote(PrivacyGatewayService, 'providers')
markRemote(PrivacyGatewayService, 'reset')
markRemote(PrivacyGatewayService, 'sessionMasking')
