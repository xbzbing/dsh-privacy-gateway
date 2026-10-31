/**
 * Whether a tool call's arguments send a value put back off this machine
 * (design §13 R15, docs/adr/0014): the hosts they name that are not this
 * machine's.
 */

/**
 * A URL's host: after the scheme and any user:password@, up to a port, a
 * path, a query or the end. The user part has no ? or #: in
 * https://evil.example#@localhost/ the @ is in the fragment, and the host is
 * evil.example.
 */
const URL_HOST = /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@"'\\<>]*@)?(\[[0-9a-f:.]+\]|[^\s/:?#"'\\<>]+)/gi

/** scp's and git's user@host:path. */
const SCP_HOST = /(?:^|[\s"'=])[A-Za-z0-9._-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):/g

/** Schemes that name no other machine. */
const LOCAL_SCHEMES = new Set(['file', 'data', 'about', 'blob', 'javascript', 'mailto'])

/** An IPv4 loopback address written out in full: 127.0.0.1 is, 127.0.0.1.evil.example is a name of another machine. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Whether `host` is this machine: localhost and its subdomains, a loopback address in full, or the any-address. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return h === '' || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0' || LOOPBACK_V4.test(h)
}

/**
 * `text` with its JSON escapes read (\/ as /, \u002f as /): tool arguments
 * are JSON text, and the tool gets https://evil.example from https:\/\/….
 * An escape a stream cut in two reads whole once its pieces are joined.
 */
export function unescapeJSON(text: string): string {
  if (!text.includes('\\')) return text
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_m, u: string | undefined, c: string | undefined) => {
    if (u !== undefined) return String.fromCharCode(parseInt(u, 16))
    switch (c) {
      case 'b': return '\b'
      case 'f': return '\f'
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
    }
    return c as string
  })
}

/**
 * The hosts `text` names that are not this machine's, in lower case, each
 * once, in the order first named: as written, and with its JSON escapes read.
 */
export function externalHosts(text: string): string[] {
  const out = new Set<string>()
  hostsOf(text, out)
  const plain = unescapeJSON(text)
  if (plain !== text) hostsOf(plain, out)
  return [...out]
}

function hostsOf(text: string, out: Set<string>): void {
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
}
