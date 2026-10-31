/**
 * Regions of a model request that must reach the vendor byte for byte
 * (docs/adr/0004): oc2dsh's free-lane gate checks the `<env>` block of the
 * system prompt and the injected tool definitions, and a request whose
 * payload half differs is turned away with a 429.
 */

export interface Range {
  start: number
  end: number
}

const ENV_OPEN = '<env>'
const ENV_CLOSE = '</env>'

/** Every `<env>` … `</env>` block of `s`; one with no closing tag runs to the end of `s`. */
export function envBlockRanges(s: string): Range[] {
  const ranges: Range[] = []
  let from = 0
  for (;;) {
    const start = s.indexOf(ENV_OPEN, from)
    if (start < 0) break
    const close = s.indexOf(ENV_CLOSE, start + ENV_OPEN.length)
    const end = close < 0 ? s.length : close + ENV_CLOSE.length
    ranges.push({ start, end })
    from = end
  }
  return ranges
}

/** The request's own tool definitions: Chat Completions, Responses and Anthropic `tools`, and the legacy `functions`. */
export const TOOL_ROOTS: readonly string[] = ['tools', 'functions']

/** Whether `path` (dotted, from the request's root) is inside one of `roots`. */
export function under(path: string, roots: readonly string[]): boolean {
  for (const r of roots) {
    if (r === '' || path === r || path.startsWith(`${r}.`)) return true
  }
  return false
}
