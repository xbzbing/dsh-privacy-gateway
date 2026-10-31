import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * Never put `.transform()` or any other callback-bearing node in this schema:
 * dsh-settings rebuilds the form from `Config.toJSON()` and serializes it a
 * second time, the callback is lost on that rebuild, and the settings card
 * never leaves its loading state. Validate at the edit and request boundaries.
 */
export interface PrivacyGatewayConfig {
  /** Master switch. */
  enabled?: boolean
}

export const Config: Schema<PrivacyGatewayConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
})

export type ResolvedConfig = Required<PrivacyGatewayConfig>

export const defaults: ResolvedConfig = {
  enabled: true,
}

export function resolveConfig(config: PrivacyGatewayConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}
