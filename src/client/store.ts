/**
 * A value that pages read and follow: `get` and `subscribe` are the pair
 * React's `useSyncExternalStore` takes, so a change made outside React (a
 * failed registration, a service arriving) re-renders whoever shows it.
 */
export interface Store<V> {
  get(): V
  set(next: V): void
  subscribe(listener: () => void): () => void
}

export function createStore<V>(initial: V): Store<V> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const l of [...listeners]) {
        try {
          l()
        } catch {
          // one listener failing must not keep the others from hearing of the change
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
