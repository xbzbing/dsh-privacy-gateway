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
export async function fetchOverview(ctx: ClientCtx, limit: number, signal?: AbortSignal): Promise<OverviewResult> {
  let rpc: ConnectionFace['rpc']
  try {
    rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
  } catch {
    rpc = undefined
  }
  if (!rpc || typeof rpc.call !== 'function') return { ok: false, message: 'no connection' }
  try {
    const r = (await rpc.call('/api', 'privacyGateway/overview', { args: { request: { limit } } }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: string } } | null
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

export interface ProviderEntry {
  id: string
  name: string
}

export type ProvidersResult = { ok: true; providers: ProviderEntry[] } | { ok: false; message: string }

/** The providers with an adapter (`llm/listProviders`), for the excludeProviders choice; never throws. */
export async function fetchProviders(ctx: ClientCtx, signal?: AbortSignal): Promise<ProvidersResult> {
  let list: unknown
  try {
    // the typed remote the models settings page uses, else the raw channel
    const remote = (ctx as { remote?: { llm?: { listProviders?(): Promise<unknown> } } }).remote
    if (typeof remote?.llm?.listProviders === 'function') list = await remote.llm.listProviders()
    else {
      let rpc: ConnectionFace['rpc']
      try {
        rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
      } catch {
        rpc = undefined
      }
      if (!rpc || typeof rpc.call !== 'function') return { ok: false, message: 'no connection' }
      const r = (await rpc.call('/api', 'llm/listProviders', { args: {} }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: string } } | null
      if (r?.ok !== true) return { ok: false, message: r?.error?.message ?? 'malformed reply' }
      list = r.value
    }
    if (!Array.isArray(list)) return { ok: false, message: 'malformed reply' }
    const providers = list.flatMap((p: unknown) => {
      const e = p as { id?: unknown; name?: unknown } | null
      return e !== null && typeof e === 'object' && typeof e.id === 'string' && e.id !== '' ? [{ id: e.id, name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id }] : []
    })
    return { ok: true, providers }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
