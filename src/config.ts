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

/** showPanel's description: the client half also knows this plugin's settings by it. */
/** excludeProviders' description. */
export const EXCLUDE_PROVIDERS_DESCRIPTION = '不脱敏的 provider / Providers whose requests are not masked'

export const SHOW_PANEL_DESCRIPTION = '在会话右侧栏显示「隐私保护」面板 / Show the Privacy panel in the right sidebar'

/** A volatile config field as cordis hands it over (cosmokit `Volatile`): its current value on each get(). */
export interface LiveValue<T> {
  get(): T | undefined
}

/** A field's value now, whether it came as a value or as a live reference. */
export function live(v: unknown): unknown {
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { get?: unknown }).get === 'function') {
    try {
      return (v as LiveValue<unknown>).get()
    } catch {
      return undefined
    }
  }
  return v
}

/** A boolean field's value now, whether it came as a value or as a live reference. */
export function liveBool(v: unknown, fallback: boolean): boolean {
  const now = live(v)
  return typeof now === 'boolean' ? now : fallback
}

/** A string list field's entries now, trimmed, the empty ones dropped. */
export function liveStrings(v: unknown): string[] {
  return strings(live(v))
}

/**
 * The fields the configuration page edits are volatile (docs/adr/0021): cordis
 * hands each one over as a live reference and does not remount the plugin when
 * it changes; `resolveConfig` reads them as they are now, and the plugin applies
 * a change from the next request. The others remount the plugin as usual.
 */
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
  /**
   * Provider ids (deepseek, oc2dsh, …) whose model requests go on unmasked and
   * whose replies are not restored (docs/adr/0018). Volatile: the detail
   * page's list edits it live.
   */
  excludeProviders?: string[] | LiveValue<string[]>
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
  /** Each value in a record keeps where it was and about 32 characters each side, as sent (docs/adr/0024). */
  recordContext?: boolean
  /**
   * Offer a Privacy tab in the session's right sidebar (docs/adr/0017).
   * Volatile: cordis hands it over as a live reference the detail page's
   * switch updates without remounting the plugin.
   */
  showPanel?: boolean | LiveValue<boolean>
}

// the cast: a volatile field's input is a boolean and its output a live reference, which Schema<T> has one type for
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  secrets: Schema.boolean().default(true).volatile(),
  personal: Schema.boolean().default(false).volatile(),
  words: Schema.array(Schema.string()).default([]).volatile(),
  allow: Schema.array(Schema.string()).default([]).volatile(),
  actions: Schema.dict(Schema.union(['mask', 'warn', 'block'] as const)).default({}),
  toolGuard: Schema.union(['off', 'warn', 'block'] as const).default('off').volatile(),
  shape: Schema.boolean().default(false).volatile(),
  cookieNames: Schema.array(Schema.string()).default([]),
  cookieKeep: Schema.array(Schema.string()).default(['lang', 'locale', 'theme', 'tz']),
  protectEnvBlock: Schema.boolean().default(true),
  protectTools: Schema.boolean().default(true),
  excludeHosts: Schema.array(Schema.string()).default([]),
  excludeProviders: Schema.array(Schema.string()).default([]).volatile().description(EXCLUDE_PROVIDERS_DESCRIPTION),
  maxValues: Schema.number().step(1).min(100).default(5000),
  record: Schema.boolean().default(true).volatile(),
  keepDays: Schema.number().step(1).min(1).default(30).volatile(),
  keepMegabytes: Schema.number().step(1).min(1).default(100),
  keepRecords: Schema.number().step(1).min(10).default(500),
  vendorView: Schema.boolean().default(false).volatile(),
  recordContext: Schema.boolean().default(true).volatile(),
  // volatile: the configuration page edits these live, without remounting the gateway (docs/adr/0017, 0021)
  showPanel: Schema.boolean().default(false).volatile().description(SHOW_PANEL_DESCRIPTION),
}) as unknown as Schema<PrivacyGatewayConfig>

export type ResolvedConfig = Required<Omit<PrivacyGatewayConfig, 'showPanel' | 'excludeProviders'>> & { showPanel: boolean; excludeProviders: string[] }

/** The volatile fields the gateway rebuilds its rules and stores from (showPanel and excludeProviders are read where they are used). */
export const LIVE_FIELDS = ['enabled', 'secrets', 'personal', 'words', 'allow', 'toolGuard', 'shape', 'record', 'keepDays', 'vendorView', 'recordContext'] as const

/** A string that changes when one of LIVE_FIELDS does. */
export function liveMark(cfg: ResolvedConfig): string {
  return JSON.stringify(LIVE_FIELDS.map((k) => cfg[k]))
}

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
  excludeProviders: [],
  maxValues: 5000,
  record: true,
  keepDays: 30,
  keepMegabytes: 100,
  keepRecords: 500,
  vendorView: false,
  recordContext: true,
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
  // a volatile field comes as a live reference: read each one as it is now
  const c: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) c[k] = live(v)
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
    excludeProviders: strings(c.excludeProviders),
    maxValues: int(c.maxValues, 100, defaults.maxValues),
    record: bool(c.record, defaults.record),
    keepDays: int(c.keepDays, 1, defaults.keepDays),
    keepMegabytes: int(c.keepMegabytes, 1, defaults.keepMegabytes),
    keepRecords: int(c.keepRecords, 10, defaults.keepRecords),
    vendorView: bool(c.vendorView, defaults.vendorView),
    recordContext: bool(c.recordContext, defaults.recordContext),
    showPanel: bool(c.showPanel, defaults.showPanel),
  }
}
