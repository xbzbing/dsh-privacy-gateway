import { join } from 'node:path'

import { resolveConfig, type PrivacyGatewayConfig } from './config.ts'
import { installGateway } from './dispatcher.ts'
import { PrivacyEngine } from './engine.ts'
import { stateDir } from './paths.ts'
import { RecordStore } from './records.ts'
import { loadKey } from './redact/key.ts'

/**
 * dsh-privacy-gateway cordis plugin entry: chains a masking dispatcher in
 * front of undici's global dispatcher (docs/adr/0001). Secrets in outgoing
 * model requests go as placeholders; the placeholders in the replies come
 * back as the values. Disposal (plugin reload, unload, shutdown) puts the
 * previous dispatcher back.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  /** cordis: run `execute` now and its returned disposer when the plugin's fiber is disposed. */
  effect(execute: () => () => void): unknown
}

export const name = 'dsh-privacy-gateway'

export { Config } from './config.ts'

export function apply(ctx: PluginContext, config: PrivacyGatewayConfig = {}): void {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info('dsh-privacy-gateway: disabled by config')
    return
  }
  const keyPath = join(stateDir(), 'redact.key')
  const { key, persisted } = loadKey(keyPath)
  if (!persisted) {
    ctx.logger.warn(`dsh-privacy-gateway: could not keep the placeholder key at ${keyPath}; placeholders change on restart`)
  }
  const records = new RecordStore({
    // record: false keeps the statistics in memory only
    ...(cfg.record ? { dir: join(stateDir(), 'masking') } : {}),
    keepDays: cfg.keepDays,
    keepBytes: cfg.keepMegabytes * 1024 * 1024,
    keepRecords: cfg.keepRecords,
    logger: ctx.logger,
  })
  const engine = new PrivacyEngine(key, cfg, { records })
  ctx.effect(() => {
    const gateway = installGateway(engine, { excludeHosts: cfg.excludeHosts, logger: ctx.logger })
    ctx.logger.info('dsh-privacy-gateway: installed in front of the global dispatcher')
    return () => {
      gateway.dispose()
      void records.close()
    }
  })
}
