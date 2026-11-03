import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Providers whose requests go on unmasked (config excludeProviders,
 * docs/adr/0018). The gateway sits on undici's global dispatcher and sees an
 * HTTP request, not the provider that sends it; the provider is known one
 * layer up, on `llm/stream`. That listener runs the provider's stream in an
 * async context that names it, and the dispatcher asks the context when the
 * request reaches it: the adapter's fetch is started inside it, and the
 * context goes with every promise from there.
 *
 * One shape or the other, never both: a stream is either an excluded
 * provider's (let by) or a model call's (masked, docs/adr/0032). The union
 * makes a context that is both impossible, which a `provider?: string` plus a
 * flag would allow (docs/adr/0018 records what `provider: ''` once cost).
 */
export type CallContext =
  /** A stream of `provider`, which `excluded` names: its requests go as they are. */
  | { kind: 'excluded'; provider: string; session?: string }
  /**
   * A model call's stream. Every `llm/stream` runs in one, even one the host
   * named no session for: the gateway refuses an upgrade only inside one, and
   * an upgrade opened outside any call is a plugin's own connection
   * (docs/adr/0032). It says which call this is, not that masking is on: an
   * explicit bypass still lets the call by, and the dispatcher asks that first.
   */
  | { kind: 'masked'; session?: string }

const current = new AsyncLocalStorage<CallContext | undefined>()

/**
 * The excluded provider whose stream the caller runs in, if any. A context
 * that is a model call names none: an empty or absent provider is never a
 * bypass.
 */
export function bypassedProvider(): string | undefined {
  const store = current.getStore()
  return store?.kind === 'excluded' && store.provider !== '' ? store.provider : undefined
}

/** The session the request being started belongs to, when it is one the host named (docs/adr/0020). */
export function currentSession(): string | undefined {
  return current.getStore()?.session
}

/**
 * Whether the current async context is a model call (docs/adr/0032). An
 * upgrade inside one is the provider's transport and is refused; one a plugin
 * opens outside any call is its own connection and was let through. It answers
 * "is this call", not "is masking on": a call an explicit bypass lets by is
 * still one, and the dispatcher asks the bypass first.
 */
export function inModelCall(): boolean {
  return current.getStore()?.kind === 'masked'
}

/** `open`'s stream, with each step it takes (the request it starts, every chunk it reads) run in the context of `provider`. */
export function bypassing<T>(provider: string, open: () => AsyncIterable<T>, session?: string): AsyncIterable<T> {
  return within((f) => current.run({ kind: 'excluded', provider, ...(session ? { session } : {}) }, f), open)
}

/**
 * `open`'s stream as a model call: it leaves any excluded provider's context
 * (a nested call to a provider that is masked is masked) and marks the stream
 * as a call, so the gateway can refuse an upgrade the call opens
 * (docs/adr/0032) and still name the session in its records.
 */
export function asModelCall<T>(open: () => AsyncIterable<T>, session?: string): AsyncIterable<T> {
  return within((f) => current.run({ kind: 'masked', ...(session ? { session } : {}) }, f), open)
}

/**
 * What the `llm/stream` listener hands on for a call to `provider`: the stream
 * carries the provider (so an excluded one goes unmasked) and the session (so
 * its records say where the call came from).
 */
export function routeStream<T>(provider: unknown, excluded: readonly string[], next: () => AsyncIterable<T>, sessionId?: unknown): AsyncIterable<T> {
  const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  if (isExcluded(provider, excluded)) return bypassing(provider, next, session)
  // a call is marked even without a session: the gateway can then tell a model call's upgrade
  // (refused, docs/adr/0025) from one a plugin opens for itself (docs/adr/0032). Codex names no
  // session, and the short circuit this replaced left its WebSocket looking like no call at all.
  return asModelCall(next, session)
}

function within<T>(run: <R>(f: () => R) => R, open: () => AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const it = run(() => open()[Symbol.asyncIterator]())
      return {
        next: (...args) => run(() => it.next(...args)),
        return: (value) => run(() => (it.return ? it.return(value) : Promise.resolve({ done: true as const, value: value as T }))),
        throw: (err) => run(() => (it.throw ? it.throw(err) : Promise.reject(err))),
      }
    },
  }
}

/** Whether `provider` (an id such as deepseek) is one of `excluded`: by id, in any case. */
export function isExcluded(provider: unknown, excluded: readonly string[]): provider is string {
  if (typeof provider !== 'string' || provider === '' || excluded.length === 0) return false
  const p = provider.toLowerCase()
  return excluded.some((e) => e.toLowerCase() === p)
}

export interface SkipSources {
  /** Whether masking is on at all: config enabled and `/privacy` together. */
  enabled: () => boolean
  /** Whether the user turned masking off for `session` (docs/adr/0023); never for an absent one. */
  sessionOff: (session: string | undefined) => boolean
}

/**
 * The dispatcher's `skip`: true only for a request one of the explicit
 * bypasses names, masking turned off, a stream of an excluded provider
 * (docs/adr/0018), or a session with masking off. An empty or absent provider
 * or session is never one of them.
 */
export function makeSkip(sources: SkipSources): () => boolean {
  return () => !sources.enabled() || bypassedProvider() !== undefined || sources.sessionOff(currentSession())
}
