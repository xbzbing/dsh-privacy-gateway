import { resolveConfig, type PrivacyGatewayConfig } from './config.ts'

/**
 * dsh-privacy-gateway cordis plugin entry. Design: docs/local/privacy-gateway-design.md
 * (not tracked). The undici dispatcher, the redaction engine and the
 * `/privacy` command are not implemented yet.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

export const name = 'dsh-privacy-gateway'

export { Config } from './config.ts'

export function apply(ctx: PluginContext, config: PrivacyGatewayConfig = {}): void {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info('dsh-privacy-gateway: disabled by config')
    return
  }
  ctx.logger.info('dsh-privacy-gateway: loaded (masking not implemented yet)')
}
