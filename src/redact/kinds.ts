/**
 * The kinds a placeholder may name (docs/adr/0033, docs/adr/0039). A kind is
 * the masker's own word for a value, so it is safe to keep; anything a model
 * writes in a marker's place is not, and an unknown marker is therefore
 * recorded as `custom` rather than under the name it gave itself.
 */
export const KNOWN_KINDS = [
  'SECRET',
  'PASSWORD',
  'API_KEY',
  'TOKEN',
  'PRIVATE_KEY',
  'COOKIE',
  'EMAIL',
  'PHONE',
  'ID_CARD',
  'BANK_CARD',
  'TERM',
] as const

/** The kinds the gateway itself writes, as a set for a quick lookup. */
export const KNOWN_KIND_SET: ReadonlySet<string> = new Set(KNOWN_KINDS)

/** What an unknown marker is recorded under: its own kind when it is one of ours. */
export function knownKind(kind: string): string {
  const upper = kind.toUpperCase()
  return KNOWN_KIND_SET.has(upper) ? upper : 'custom'
}