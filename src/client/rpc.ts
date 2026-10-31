/** The host's `privacyGateway/overview`, through the shared `/api` channel. */
import type { Overview } from '../remote.ts'
import { isOverview } from './view.ts'

export interface ClientCtx {
  get(key: string): unknown
  effect(cb: () => void | (() => void), label?: string): void
  /** Runs `callback` once every named service is there (cordis deferred injection). */
  inject?(deps: string[], callback: (child: ClientCtx) => void): unknown
  slots: {
    inject(name: string, provider: () => unknown): unknown
    register(registration: Record<string, unknown>, component: unknown): unknown
  }
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): (() => void) | void
    bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  }
}

interface ConnectionFace {
  rpc?: { call?(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}

export type OverviewResult = { ok: true; value: Overview } | { ok: false; message: string }

/** The overview, or why there is none; never throws. */
export async function fetchOverview(ctx: ClientCtx, limit: number, signal?: AbortSignal, session?: string): Promise<OverviewResult> {
  let rpc: ConnectionFace['rpc']
  try {
    rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
  } catch {
    rpc = undefined
  }
  if (!rpc || typeof rpc.call !== 'function') return { ok: false, message: 'no connection' }
  try {
    const request = session ? { limit, session } : { limit }
    const r = (await rpc.call('/api', 'privacyGateway/overview', { args: { request } }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: string } } | null
    if (r?.ok === true && isOverview(r.value)) return { ok: true, value: r.value }
    return { ok: false, message: r?.error?.message ?? 'malformed reply' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export type VendorViewResult = { ok: true; body: string | null } | { ok: false; message: string }

/** The body kept for record `key` (docs/adr/0016): null when it is no longer kept; never throws. */
export async function fetchVendorView(ctx: ClientCtx, key: number, signal?: AbortSignal): Promise<VendorViewResult> {
  let rpc: ConnectionFace['rpc']
  try {
    rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
  } catch {
    rpc = undefined
  }
  if (!rpc || typeof rpc.call !== 'function') return { ok: false, message: 'no connection' }
  try {
    const r = (await rpc.call('/api', 'privacyGateway/vendorView', { args: { request: { key } } }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: string } } | null
    if (r?.ok !== true) return { ok: false, message: r?.error?.message ?? 'malformed reply' }
    const v = r.value as { body?: unknown } | null
    return { ok: true, body: v !== null && typeof v === 'object' && typeof v.body === 'string' ? v.body : null }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** One provider route with an adapter, as the excludeProviders choice lists it. */
export interface ProviderEntry {
  id: string
  name: string
}

export type ProvidersResult = { ok: true; providers: ProviderEntry[] } | { ok: false; message: string }

/** The providers with an adapter, from this plugin's own host half; never throws. */
export async function fetchProviders(ctx: ClientCtx, signal?: AbortSignal): Promise<ProvidersResult> {
  let rpc: ConnectionFace['rpc']
  try {
    rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
  } catch {
    rpc = undefined
  }
  if (!rpc || typeof rpc.call !== 'function') return { ok: false, message: 'no connection' }
  try {
    const r = (await rpc.call('/api', 'privacyGateway/providers', { args: {} }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: string } } | null
    if (r?.ok !== true || !Array.isArray(r.value)) return { ok: false, message: r?.error?.message ?? 'malformed reply' }
    const providers = r.value.flatMap((p: unknown) => {
      const e = p as { id?: unknown; name?: unknown } | null
      return e !== null && typeof e === 'object' && typeof e.id === 'string' && e.id !== '' ? [{ id: e.id, name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id }] : []
    })
    return { ok: true, providers }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
