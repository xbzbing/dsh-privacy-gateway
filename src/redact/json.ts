/**
 * A byte-preserving JSON string walker, after magpie's internal/redact/json.go
 * `walk`: `fn` is called with every string value (its dotted path, the key it
 * is under, and its decoded text), and only the strings whose text `fn`
 * changes are written again. Everything else, whitespace and escapes included,
 * comes back exactly as it was, so the parts of a request nobody masked stay
 * byte for byte what the agent sent.
 */
export type StringFn = (path: string, key: string, value: string) => string

/** The walked text, or null when `text` is not one JSON value. */
export function walkJSON(text: string, fn: StringFn): string | null {
  const out: string[] = []
  let last = 0

  const ws = (i: number): number => {
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break
      i++
    }
    return i
  }

  /** The end (past the closing quote) of the string literal at i, and whether it has escapes; -1 if unterminated. */
  const str = (i: number): { end: number; escaped: boolean } => {
    let escaped = false
    for (let j = i + 1; j < text.length; j++) {
      const c = text.charCodeAt(j)
      if (c === 0x5c) {
        escaped = true
        j++
      } else if (c === 0x22) {
        return { end: j + 1, escaped }
      }
    }
    return { end: -1, escaped }
  }

  const decode = (i: number, end: number, escaped: boolean): string | undefined => {
    if (!escaped) return text.slice(i + 1, end - 1)
    try {
      const v: unknown = JSON.parse(text.slice(i, end))
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }

  const join = (path: string, k: string): string => (path === '' ? k : `${path}.${k}`)

  const value = (i: number, path: string, key: string): number => {
    if (i >= text.length) return -1
    const c = text[i]
    if (c === '{') {
      i = ws(i + 1)
      if (text[i] === '}') return i + 1
      for (;;) {
        if (text[i] !== '"') return -1
        const k = str(i)
        if (k.end < 0) return -1
        const name = decode(i, k.end, k.escaped)
        if (name === undefined) return -1
        i = ws(k.end)
        if (text[i] !== ':') return -1
        i = value(ws(i + 1), join(path, name), name)
        if (i < 0) return -1
        i = ws(i)
        if (text[i] === ',') {
          i = ws(i + 1)
          continue
        }
        if (text[i] === '}') return i + 1
        return -1
      }
    }
    if (c === '[') {
      i = ws(i + 1)
      if (text[i] === ']') return i + 1
      for (let n = 0; ; n++) {
        // an array's strings are under the key the array is
        i = value(i, join(path, String(n)), key)
        if (i < 0) return -1
        i = ws(i)
        if (text[i] === ',') {
          i = ws(i + 1)
          continue
        }
        if (text[i] === ']') return i + 1
        return -1
      }
    }
    if (c === '"') {
      const s = str(i)
      if (s.end < 0) return -1
      const v = decode(i, s.end, s.escaped)
      if (v === undefined) return -1
      const t = fn(path, key, v)
      if (t !== v) {
        out.push(text.slice(last, i), JSON.stringify(t))
        last = s.end
      }
      return s.end
    }
    let j = i
    while (j < text.length && !',]} \t\r\n'.includes(text[j] as string)) j++
    return j === i ? -1 : j
  }

  const end = value(ws(0), '', '')
  if (end < 0 || ws(end) !== text.length) return null
  if (last === 0) return text
  out.push(text.slice(last))
  return out.join('')
}

/** `s` as it goes between the quotes of a JSON string. */
export function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/**
 * Whether a string under `key` holds JSON text of its own (a tool call's
 * arguments, whole or streamed in pieces), so the vendor reads it after one
 * more unescaping and a value goes back into it escaped.
 */
export function asJSON(key: string, eventType: string): boolean {
  return key === 'arguments' || key === 'partial_json' || (key === 'delta' && eventType.includes('arguments'))
}

/**
 * Keys whose strings the vendor needs as they are: ids, names and kinds, and
 * what is sealed or encoded. magpie json.go `kept`: a tool's name masked is a
 * 400 on every turn that replays the call.
 */
export const KEPT = new Set([
  'signature', 'encrypted_content', 'data', 'thoughtSignature', 'thought_signature',
  'model', 'id', 'tool_use_id', 'call_id', 'item_id', 'type', 'role',
  'name', 'namespace', 'server_label', 'server_name', 'previous_response_id', 'prompt_cache_key', 'media_type', 'mime_type',
  'mimeType', 'url', 'image_url', 'file_id', 'reasoning_effort', 'effort',
  'stop_reason', 'finish_reason', 'status', 'object', 'event',
])

/** Keys whose strings a vendor sealed with a signature: they go back exactly as it wrote them. */
export const SIGNATURE_KEYS = new Set(['signature', 'thoughtSignature', 'thought_signature', 'encrypted_content'])
