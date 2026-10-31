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
export interface PrivacyGatewayConfig {
  /** Master switch. */
  enabled?: boolean
  /** Mask secrets: API keys and tokens. */
  secrets?: boolean
  /** Leave every `<env>` … `</env>` block byte for byte (oc2dsh's free-lane gate checks it). */
  protectEnvBlock?: boolean
  /** Leave the request's `tools` array byte for byte (the gate checks the injected tool definitions). */
  protectTools?: boolean
  /** Extra `host` or `host:port` entries whose requests are never rewritten. */
  excludeHosts?: string[]
  /** How many values the in-memory table holds before the oldest half is dropped. */
  maxValues?: number
}

export const Config: Schema<PrivacyGatewayConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  secrets: Schema.boolean().default(true),
  protectEnvBlock: Schema.boolean().default(true),
  protectTools: Schema.boolean().default(true),
  excludeHosts: Schema.array(Schema.string()).default([]),
  maxValues: Schema.number().step(1).min(100).default(5000),
})

export type ResolvedConfig = Required<PrivacyGatewayConfig>

export const defaults: ResolvedConfig = {
  enabled: true,
  secrets: true,
  protectEnvBlock: true,
  protectTools: true,
  excludeHosts: [],
  maxValues: 5000,
}

export function resolveConfig(config: PrivacyGatewayConfig = {}): ResolvedConfig {
  const merged = { ...defaults, ...config }
  const maxValues =
    typeof merged.maxValues === 'number' && Number.isFinite(merged.maxValues) && merged.maxValues >= 100
      ? Math.floor(merged.maxValues)
      : defaults.maxValues
  const excludeHosts = Array.isArray(merged.excludeHosts)
    ? merged.excludeHosts
        .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
        .map((h) => h.trim().toLowerCase())
    : []
  return { ...merged, maxValues, excludeHosts }
}
