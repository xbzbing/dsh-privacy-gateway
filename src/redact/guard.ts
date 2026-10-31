/**
 * Whether a tool call's arguments send a value put back off this machine
 * (design §13 R15, docs/adr/0014): the hosts they name that are not this
 * machine's.
 */

/** A URL's host: after the scheme and any user:password@, up to a port, a path, a query or the end. */
const URL_HOST = /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@"'\\<>]*@)?(\[[0-9a-f:.]+\]|[^\s/:?#"'\\<>]+)/gi

/** scp's and git's user@host:path. */
const SCP_HOST = /(?:^|[\s"'=])[A-Za-z0-9._-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):/g

/** Schemes that name no other machine. */
const LOCAL_SCHEMES = new Set(['file', 'data', 'about', 'blob', 'javascript', 'mailto'])

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return h === '' || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h.startsWith('127.') || h === '::'
}

/** The hosts `text` names that are not this machine's, in lower case, each once, in the order first named. */
export function externalHosts(text: string): string[] {
  const out = new Set<string>()
  if (text.includes('://')) {
    for (const m of text.matchAll(URL_HOST)) {
      const scheme = (m[1] as string).toLowerCase()
      const host = (m[2] as string).toLowerCase()
      if (LOCAL_SCHEMES.has(scheme) || isLocalHost(host) || host.includes('{{')) continue
      out.add(host)
    }
  }
  if (text.includes('@')) {
    for (const m of text.matchAll(SCP_HOST)) {
      const host = (m[1] as string).toLowerCase()
      if (!isLocalHost(host)) out.add(host)
    }
  }
  return [...out]
}
