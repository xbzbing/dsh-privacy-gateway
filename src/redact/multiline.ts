/** Narrow config-scalar scanning: one contiguous secret token on each nonempty line. */
import { algorithmValue, namedAt, namedValue, notATemplate } from './checks.ts'
import { MIN_SECRET_CHARS, type DecodedView } from './find.ts'
import type { Found } from './ids.ts'
import { MAX_SECRET, SECRET_CH, SECRET_NAMES } from './rules.ts'

const SECRET_FIELD = new RegExp(`(?:${SECRET_NAMES.join('|')})[A-Za-z0-9_.-]{0,64}$`, 'i')
const TOKEN = new RegExp(`^${SECRET_CH}+$`)
// Bound the field copied and checked per token; longer headers still delimit their scalar.
const MAX_FIELD = 256
// Read all simple field names so a nonsensitive scalar cannot lend its body to a new header.
const HEADER = /^( *)(- +)?(?:([A-Za-z0-9_.-]+)|"((?:\\.|[^"\\\r\n])*)"|'((?:''|[^'\r\n])*)')[ \t]*([:=])[ \t]*/
const YAML = /^[|>]([1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*|[ \t]*)$/

interface Line {
  start: number
  end: number
  next: number
}

/** A line's content excludes CRLF, while its next offset preserves both bytes. */
function lineAt(s: string, start: number, limit = s.length): Line {
  const newline = s.indexOf('\n', start)
  const end = newline < 0 || newline >= limit ? limit : newline
  return { start, end: end > start && s[end - 1] === '\r' ? end - 1 : end, next: end < limit ? end + 1 : limit }
}

/** All token spans, or none if any nonempty line needs syntax outside this scanner's scope. */
function tokens(s: string, start: number, end: number, field: string): Found[] {
  const out: Found[] = []
  for (let at = start; at < end;) {
    const line = lineAt(s, at, end)
    let a = line.start
    let b = line.end
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a++
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--
    if (a < b) {
      const value = s.slice(a, b)
      if (!TOKEN.test(value)) return []
      // Reuse the single-line semantic checks without making their field lookback cross a line.
      const context = `${field}=${value}`
      const from = field.length + 1
      if (value.length >= MIN_SECRET_CHARS && value.length <= MAX_SECRET && namedValue(value) && notATemplate(value) && !algorithmValue(value) && namedAt(context, from, context.length)) {
        out.push({ start: a, end: b, kind: 'SECRET', by: 'rule', field })
      }
    }
    at = line.next
  }
  return out
}

/** YAML block content ends at the first nonempty line below its explicit or inferred indentation. */
function yamlEnd(s: string, start: number, base: number, indicator: string): number {
  const digit = indicator.match(/[1-9]/)?.[0]
  let indent = digit === undefined ? undefined : base + Number(digit)
  let at = start
  while (at < s.length) {
    const line = lineAt(s, at)
    let i = at
    while (i < line.end && s[i] === ' ') i++
    if (i !== line.end) {
      const spaces = i - at
      if (spaces <= base || (indent !== undefined && spaces < indent)) break
      indent ??= spaces
    }
    at = line.next
  }
  return at
}

/** Basic strings escape their next character; literal strings have no escape syntax. */
function tomlEnd(s: string, start: number, quote: string): number {
  for (let i = start; i < s.length; i++) {
    if (quote === '"""' && s[i] === '\\') {
      i++
      continue
    }
    if (s.startsWith(quote, i)) return i
  }
  return -1
}

/** Contextual SECRET matches follow the free-form rules, so existing vendor-specific kinds win. */
function scalarSpans(s: string): Found[] {
  if (!s.includes('|') && !s.includes('>') && !s.includes('"""') && !s.includes("'''")) return []
  const out: Found[] = []
  for (let at = 0; at < s.length;) {
    const line = lineAt(s, at)
    const header = HEADER.exec(s.slice(at, line.end))
    if (!header) {
      at = line.next
      continue
    }
    const field = (header[3] ?? header[4] ?? header[5]) as string
    const start = at + header[0].length
    const sensitive = field.length <= MAX_FIELD && /^[A-Za-z0-9_.-]+$/.test(field) && SECRET_FIELD.test(field)
    if (header[6] === ':') {
      const indicator = s.slice(start, line.end)
      if (YAML.test(indicator)) {
        const base = header[1]!.length + (header[2]?.length ?? 0)
        const end = yamlEnd(s, line.next, base, indicator.split('#')[0]!)
        if (sensitive) out.push(...tokens(s, line.next, end, field))
        at = end
        continue
      }
    } else {
      const quote = s.slice(start, start + 3)
      if (quote === '"""' || quote === "'''") {
        const end = tomlEnd(s, start + 3, quote)
        // An unterminated string has no reliable scope for contextual matching.
        if (end < 0) break
        const closing = lineAt(s, end + 3)
        const tail = s.slice(end + 3, closing.end)
        // Four/five closing quotes carry literal quote content, outside a contiguous token.
        if (sensitive && /^[ \t]*(?:#.*)?$/.test(tail)) out.push(...tokens(s, start + 3, end, field))
        at = closing.next
        continue
      }
    }
    at = line.next
  }
  return out
}

/** JSON arguments need independent string scopes, before decoded quotes lose their structural role. */
export function multilineSpans(s: string, raw?: string, view?: DecodedView): Found[] {
  if (raw === undefined) return scalarSpans(s)
  try {
    JSON.parse(raw)
  } catch {
    return scalarSpans(s)
  }
  const out: Found[] = []
  let decoded = 0
  // Both cursors move only forwards; decoding is already owned by decodedView.
  const offset = (at: number): number => {
    if (view === undefined) return at
    while (decoded < view.at.length && view.at[decoded]! < at) decoded++
    return decoded
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '"') continue
    const start = offset(i + 1)
    let end = i + 1
    while (end < raw.length && raw[end] !== '"') {
      if (raw[end] === '\\') end++
      end++
    }
    const finish = offset(end)
    let after = end + 1
    while (after < raw.length && /[ \t\r\n]/.test(raw[after]!)) after++
    // Object keys are parameter names, not config text; array and top-level strings remain values.
    if (raw[after] !== ':') {
      for (const f of scalarSpans(s.slice(start, finish))) out.push({ ...f, start: f.start + start, end: f.end + start })
    }
    i = end
  }
  return out
}
