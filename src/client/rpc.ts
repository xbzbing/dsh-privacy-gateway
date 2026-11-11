/** The host's `privacyGateway/*` methods, through the shared `/api` channel. */
import type { Overview, ProviderEntry } from '../remote.ts'
import type { Key, T } from './locales.ts'
import { readOverview } from './view.ts'

export type { ProviderEntry }

export interface ClientCtx {
  get(key: string): unknown
  effect(cb: () => void | (() => void), label?: string): void
  /** Runs `callback` once every named service is there, and again whenever one is replaced (cordis deferred injection). */
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

/**
 * Why a call has no answer. `noConnection` and `malformed` are this page's own
 * words; `remote` and `thrown` carry the message the host or the transport gave.
 */
export type Failure = { code: 'noConnection' } | { code: 'malformed' } | { code: 'remote' | 'thrown'; message: string }

export type Result<V> = { ok: true; value: V } | { ok: false; failure: Failure }

/** A failure in the reader's language. */
export function failureText(f: Failure, t: T): string {
  const words: Record<Failure['code'], Key> = { noConnection: 'err.noConnection', malformed: 'err.malformed', remote: 'err.remote', thrown: 'err.thrown' }
  return t(words[f.code], 'message' in f ? { message: f.message } : undefined)
}

/**
 * One `privacyGateway/<method>` call: the reply's value read by `read`
 * (undefined meaning it is not of the shape this page knows); never throws.
 */
export async function call<V>(ctx: ClientCtx, method: string, request: unknown, read: (value: unknown) => V | undefined, signal?: AbortSignal): Promise<Result<V>> {
  let rpc: ConnectionFace['rpc']
  try {
    rpc = (ctx.get('connection') as ConnectionFace | undefined)?.rpc
  } catch {
    rpc = undefined
  }
  if (!rpc || typeof rpc.call !== 'function') return { ok: false, failure: { code: 'noConnection' } }
  try {
    const args = request === undefined ? {} : { request }
    const r = (await rpc.call('/api', `privacyGateway/${method}`, { args }, signal)) as { ok?: boolean; value?: unknown; error?: { message?: unknown } } | null
    if (r?.ok !== true) {
      const message = r?.error?.message
      return { ok: false, failure: typeof message === 'string' && message !== '' ? { code: 'remote', message } : { code: 'malformed' } }
    }
    const value = read(r.value)
    return value === undefined ? { ok: false, failure: { code: 'malformed' } } : { ok: true, value }
  } catch (err) {
    return { ok: false, failure: { code: 'thrown', message: err instanceof Error ? err.message : String(err) } }
  }
}

/** The overview, or why there is none. */
export function fetchOverview(ctx: ClientCtx, limit: number, signal?: AbortSignal, session?: string): Promise<Result<Overview>> {
  return call(ctx, 'overview', session ? { limit, session } : { limit }, readOverview, signal)
}

/** The body kept for record `key` (docs/adr/0016): null when it is no longer kept. */
export function fetchVendorView(ctx: ClientCtx, key: number, signal?: AbortSignal): Promise<Result<string | null>> {
  return call(ctx, 'vendorView', { key }, (v) => {
    // null is the host's "no longer kept"; anything else must read as a body,
    // or the call is malformed and the card can say so instead of "gone"
    if (v === null) return null
    const body = (v as { body?: unknown } | null)?.body
    return typeof body === 'string' ? body : undefined
  }, signal)
}

/** Clears the history on the host (docs/adr/0022): the number of day files deleted. */
export function resetData(ctx: ClientCtx): Promise<Result<number>> {
  return call(ctx, 'reset', undefined, (v) => {
    const files = (v as { files?: unknown } | null)?.files
    return typeof files === 'number' ? files : 0
  })
}

/** Turns masking on or off for one session (docs/adr/0023): the state after. */
export function setSessionMasking(ctx: ClientCtx, session: string, on: boolean): Promise<Result<boolean>> {
  return call(ctx, 'sessionMasking', { session, on }, (v) => {
    const now = (v as { on?: unknown } | null)?.on
    return typeof now === 'boolean' ? now : undefined
  })
}

/** The providers with an adapter, from this plugin's own host half. */
export function fetchProviders(ctx: ClientCtx, signal?: AbortSignal): Promise<Result<ProviderEntry[]>> {
  return call(ctx, 'providers', undefined, (v) => (Array.isArray(v) ? v.flatMap(providerEntry) : undefined), signal)
}

function providerEntry(p: unknown): ProviderEntry[] {
  const e = p as { id?: unknown; name?: unknown } | null
  return e !== null && typeof e === 'object' && typeof e.id === 'string' && e.id !== '' ? [{ id: e.id, name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id }] : []
}
