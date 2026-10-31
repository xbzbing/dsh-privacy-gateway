import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * Never put `.transform()` or any other callback-bearing node in this schema:
 * dsh-settings rebuilds the form from `Config.toJSON()` and serializes it a
 * second time, the callback is lost on that rebuild, and the settings card
 * never leaves its loading state. Validate at the edit and request boundaries
 * (`resolveConfig`).
 */
/** What is done with a value a finder found. */
export type Action = 'mask' | 'warn' | 'block'

export const ACTIONS: readonly Action[] = ['mask', 'warn', 'block']

export type ToolGuard = 'off' | 'warn' | 'block'

export interface PrivacyGatewayConfig {
  /** Master switch. */
  enabled?: boolean
  /** Mask secrets: API keys, tokens, passwords, private keys, cookies. */
  secrets?: boolean
  /** Mask personal data: emails, mainland phone, ID card and bank card numbers. */
  personal?: boolean
  /** Your own words (a project's code name, a customer's name), masked wherever they are, as written. */
  words?: string[]
  /** Values never masked, whichever rule finds them: each a whole value, in any case. */
  allow?: string[]
  /**
   * What is done with a value of a kind (API_KEY, EMAIL, COOKIE, …): mask it
   * (the default), warn (send it as written and record it), or block (do not
   * send the request).
   */
  actions?: Record<string, Action>
  /**
   * A tool call whose arguments would have a value put back and name a host
   * off this machine: off counts it only, warn logs and records it, block
   * leaves the placeholders in those arguments (docs/adr/0014).
   */
  toolGuard?: ToolGuard
  /** A secret goes as a made-up key of its own form (same prefix, length, kinds of character) instead of a placeholder, where it can (docs/adr/0015). */
  shape?: boolean
  /** Cookie names masked wherever NAME=value is written, beside the built-in list (BDUSS, JSESSIONID, …). */
  cookieNames?: string[]
  /** Cookie names never masked. */
  cookieKeep?: string[]
  /** Leave every `<env>` … `</env>` block byte for byte (oc2dsh's free-lane gate checks it). */
  protectEnvBlock?: boolean
  /** Leave the request's `tools` array byte for byte (the gate checks the injected tool definitions). */
  protectTools?: boolean
  /** Extra `host` or `host:port` entries whose requests are never rewritten. */
  excludeHosts?: string[]
  /** How many values the in-memory table holds before the half used longest ago is dropped. */
  maxValues?: number
  /** Write a record of each masked request to disk; off keeps the statistics in memory only. */
  record?: boolean
  /** Days of records kept on disk. */
  keepDays?: number
  /** Megabytes of records kept on disk. */
  keepMegabytes?: number
  /** Records kept in memory for the command and the settings card. */
  keepRecords?: number
  /** Keep in memory what the vendor got for the latest recorded requests, for the side-by-side view (docs/adr/0016). */
  vendorView?: boolean
  /** Offer a Privacy tab in the session's right sidebar (docs/adr/0017). */
  showPanel?: boolean
}

export const Config: Schema<PrivacyGatewayConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  secrets: Schema.boolean().default(true),
  personal: Schema.boolean().default(false),
  words: Schema.array(Schema.string()).default([]),
  allow: Schema.array(Schema.string()).default([]),
  actions: Schema.dict(Schema.union(['mask', 'warn', 'block'] as const)).default({}),
  toolGuard: Schema.union(['off', 'warn', 'block'] as const).default('off'),
  shape: Schema.boolean().default(false),
  cookieNames: Schema.array(Schema.string()).default([]),
  cookieKeep: Schema.array(Schema.string()).default(['lang', 'locale', 'theme', 'tz']),
  protectEnvBlock: Schema.boolean().default(true),
  protectTools: Schema.boolean().default(true),
  excludeHosts: Schema.array(Schema.string()).default([]),
  maxValues: Schema.number().step(1).min(100).default(5000),
  record: Schema.boolean().default(true),
  keepDays: Schema.number().step(1).min(1).default(30),
  keepMegabytes: Schema.number().step(1).min(1).default(100),
  keepRecords: Schema.number().step(1).min(10).default(500),
  vendorView: Schema.boolean().default(false),
  showPanel: Schema.boolean().default(false),
})

export type ResolvedConfig = Required<PrivacyGatewayConfig>

export const defaults: ResolvedConfig = {
  enabled: true,
  secrets: true,
  personal: false,
  words: [],
  allow: [],
  actions: {},
  toolGuard: 'off',
  shape: false,
  cookieNames: [],
  cookieKeep: ['lang', 'locale', 'theme', 'tz'],
  protectEnvBlock: true,
  protectTools: true,
  excludeHosts: [],
  maxValues: 5000,
  record: true,
  keepDays: 30,
  keepMegabytes: 100,
  keepRecords: 500,
  vendorView: false,
  showPanel: false,
}

function int(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback
}

function strings(v: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(v)) return fallback
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

/** The actions by kind, the kind in upper case; anything but warn and block is the default, mask. */
function actions(v: unknown): Record<string, Action> {
  const out: Record<string, Action> = {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [k, a] of Object.entries(v as Record<string, unknown>)) {
    const kind = k.trim().toUpperCase()
    if (kind !== '' && (a === 'warn' || a === 'block')) out[kind] = a
  }
  return out
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** The config as the plugin runs it: every field present, each one checked (the schema has no callbacks to do it). */
export function resolveConfig(config: PrivacyGatewayConfig = {}): ResolvedConfig {
  const c = config as Record<string, unknown>
  return {
    enabled: bool(c.enabled, defaults.enabled),
    secrets: bool(c.secrets, defaults.secrets),
    personal: bool(c.personal, defaults.personal),
    words: strings(c.words),
    allow: strings(c.allow),
    actions: actions(c.actions),
    toolGuard: c.toolGuard === 'warn' || c.toolGuard === 'block' ? c.toolGuard : 'off',
    shape: bool(c.shape, defaults.shape),
    cookieNames: strings(c.cookieNames),
    cookieKeep: strings(c.cookieKeep, defaults.cookieKeep),
    protectEnvBlock: bool(c.protectEnvBlock, defaults.protectEnvBlock),
    protectTools: bool(c.protectTools, defaults.protectTools),
    excludeHosts: strings(c.excludeHosts).map((h) => h.toLowerCase()),
    maxValues: int(c.maxValues, 100, defaults.maxValues),
    record: bool(c.record, defaults.record),
    keepDays: int(c.keepDays, 1, defaults.keepDays),
    keepMegabytes: int(c.keepMegabytes, 1, defaults.keepMegabytes),
    keepRecords: int(c.keepRecords, 10, defaults.keepRecords),
    vendorView: bool(c.vendorView, defaults.vendorView),
    showPanel: bool(c.showPanel, defaults.showPanel),
  }
}
