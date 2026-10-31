/**
 * The rules that find secrets in a text, by magpie's (internal/redact/
 * redact.go) semantics. P0 has the three most common key forms; the rest of
 * the table (§5.1 of the design) comes with P1.
 */
export interface Rule {
  kind: string
  /** Global regex; the whole match is the value. */
  re: RegExp
  /** One of these is in any text the pattern can match: a cheap skip. */
  markers: readonly string[]
  /** Characters that may not touch the value on either side: a key inside a longer word is no key. */
  bound?: string
  /** Checks the value further. */
  ok?: (value: string) => boolean
}

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const TOKEN_CH = ALNUM + '_-'

/**
 * False for words in lower case joined by hyphens: a page's address names
 * an article about SK hynix (…/sk-hynix-third-quarter-profit.html), which is
 * no key. A key's characters are random: it has a capital, or a run of 16 or
 * more with no hyphen, or is hex digits alone (sk- and a UUID in lower case).
 */
export function notASlug(v: string): boolean {
  if (/[A-Z]/.test(v)) return true
  if (!/[^-_0-9a-f]/.test(v.startsWith('sk-') ? v.slice(3) : v)) return true
  return v.split(/[-_]/).some((w) => w.length >= 16)
}

export const secretRules: readonly Rule[] = [
  {
    kind: 'API_KEY',
    re: /sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    markers: ['sk-'],
    bound: TOKEN_CH,
    ok: notASlug,
  },
  {
    kind: 'API_KEY',
    re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/g,
    markers: ['gh', 'github_pat_', 'glpat-'],
    bound: TOKEN_CH,
  },
  {
    kind: 'API_KEY',
    re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    markers: ['AKIA', 'ASIA'],
    bound: ALNUM,
  },
]
