import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Providers whose requests go on unmasked (config excludeProviders,
 * docs/adr/0018). The gateway sits on undici's global dispatcher and sees an
 * HTTP request, not the provider that sends it; the provider is known one
 * layer up, on `llm/stream`. That listener runs the provider's stream in an
 * async context that names it, and the dispatcher asks the context when the
 * request reaches it: the adapter's fetch is started inside it, and the
 * context goes with every promise from there.
 */
export interface CallContext {
  /** The excluded provider whose stream this is, while that stream runs; absent for a masked one. */
  provider?: string
  /** The session the call belongs to, when the host names one. */
  session?: string
}

const current = new AsyncLocalStorage<CallContext | undefined>()

/**
 * The excluded provider whose stream the caller runs in, if any. A context
 * that only carries the session (a masked provider's stream) names none: an
 * empty or absent provider is never a bypass.
 */
export function bypassedProvider(): string | undefined {
  const provider = current.getStore()?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/** The session the request being started belongs to, when it is one the host named (docs/adr/0020). */
export function currentSession(): string | undefined {
  return current.getStore()?.session
}

/** `open`'s stream, with each step it takes (the request it starts, every chunk it reads) run in the context of `provider`. */
export function bypassing<T>(provider: string, open: () => AsyncIterable<T>, session?: string): AsyncIterable<T> {
  return within((f) => current.run({ provider, ...(session ? { session } : {}) }, f), open)
}

/** `open`'s stream run outside any excluded provider: a nested call to a provider that is masked is masked. */
export function unbypassing<T>(open: () => AsyncIterable<T>, session?: string): AsyncIterable<T> {
  return within((f) => current.run(session ? { session } : undefined, f), open)
}

/**
 * What the `llm/stream` listener hands on for a call to `provider`: the stream
 * carries the provider (so an excluded one goes unmasked) and the session (so
 * its records say where the call came from).
 */
export function routeStream<T>(provider: unknown, excluded: readonly string[], next: () => AsyncIterable<T>, sessionId?: unknown): AsyncIterable<T> {
  const session = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  if (isExcluded(provider, excluded)) return bypassing(provider, next, session)
  return current.getStore() === undefined && session === undefined ? next() : unbypassing(next, session)
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
