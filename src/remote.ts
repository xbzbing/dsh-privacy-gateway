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
}

export interface Overview {
  /** Masking on for this run (`/privacy on|off`). */
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
  /** The vendor view is on (config vendorView). */
  vendorView?: boolean
  /** The keys of the records whose body as it went is kept. */
  views?: number[]
  /** The sidebar tab is offered (config showPanel). */
  showPanel?: boolean
  /** Providers whose requests go on unmasked (config excludeProviders). */
  excludeProviders?: string[]
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

/** What the service reads from the plugin. */
export interface OverviewSource {
  overview(limit: number): Overview
  /** The providers with an adapter now (host `llm.listProviders()`). */
  providers?(): ProviderEntry[]
  /** The body kept for `key`, or null when the view is off or it is not kept. */
  vendorView?(key: number): VendorView | null
}

export const NAMESPACE = 'privacyGateway'

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

  /** The state, the sums and the latest records. */
  async overview(request: OverviewRequest): Promise<Overview> {
    return this.source.overview(clampLimit(request?.limit))
  }

  /** The providers with an adapter, for the excludeProviders choice. */
  async providers(): Promise<ProviderEntry[]> {
    return this.source.providers?.() ?? []
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
