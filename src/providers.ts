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
const current = new AsyncLocalStorage<string>()

/** The excluded provider whose stream the caller runs in, if any. */
export function bypassedProvider(): string | undefined {
  return current.getStore()
}

/** `open`'s stream, with each step it takes (the request it starts, every chunk it reads) run in the context of `provider`. */
export function bypassing<T>(provider: string, open: () => AsyncIterable<T>): AsyncIterable<T> {
  return within((f) => current.run(provider, f), open)
}

/** `open`'s stream run outside any excluded provider: a nested call to a provider that is masked is masked. */
export function unbypassing<T>(open: () => AsyncIterable<T>): AsyncIterable<T> {
  return within((f) => current.exit(f), open)
}

/** What the `llm/stream` listener hands on for a call to `provider`. */
export function routeStream<T>(provider: unknown, excluded: readonly string[], next: () => AsyncIterable<T>): AsyncIterable<T> {
  if (isExcluded(provider, excluded)) return bypassing(provider, next)
  return bypassedProvider() === undefined ? next() : unbypassing(next)
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
