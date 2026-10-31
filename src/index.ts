import { join } from 'node:path'

import { langOf, runPrivacyCommand, type PrivacyFace } from './command.ts'
import { resolveConfig, type PrivacyGatewayConfig } from './config.ts'
import { installGateway } from './dispatcher.ts'
import { PrivacyEngine } from './engine.ts'
import { stateDir } from './paths.ts'
import { RecordStore } from './records.ts'
import type { OverviewSource } from './remote.ts'
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
  /** cordis: run `callback` with a child context once every named service is there (and dispose it when one goes). */
  inject?(deps: string[], callback: (child: PluginContext & { commands: CommandsService }) => void): unknown
  /** cordis: the named service, or undefined. */
  get?(name: string): unknown
  /** cordis: load a plugin (here the card's Remote service) under this one. */
  plugin?(plugin: unknown, config?: unknown): unknown
}

/** The slice of dsh-commands the plugin uses. */
export interface CommandsService {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    recordInput?: boolean
    handler(invocation: { rawInput: string }): { kind: 'success'; text?: string } | { kind: 'error'; text: string }
  }): () => void
}

/** The user's locale preference, through dsh-settings; English when it cannot be read. */
function localeOf(ctx: PluginContext): unknown {
  try {
    const settings = ctx.get?.('settings') as { describe?(o: { redactSecrets: boolean }): Array<{ ns: string; value?: Record<string, unknown> }> } | undefined
    return settings?.describe?.({ redactSecrets: true }).find((e) => e.ns === 'locale')?.value?.preference
  } catch {
    return undefined
  }
}

const COMMAND_TEXT = {
  zh: { description: '隐私网关：状态、开关与脱敏预览', hint: 'status | on | off | test <文本>' },
  en: { description: 'Privacy gateway: status, on/off and a masking preview', hint: 'status | on | off | test <text>' },
} as const

export const name = 'dsh-privacy-gateway'

export { Config } from './config.ts'
/** The composition contract other dispatcher plugins rely on (docs/adr/0012). */
export type { ChainOptions, LayerInfo, LayerRole, MaskingDispatcher } from './dispatcher.ts'

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
  const face: PrivacyFace = {
    get active() {
      return engine.active
    },
    set active(on: boolean) {
      engine.active = on
      ctx.logger.info(`dsh-privacy-gateway: masking turned ${on ? 'on' : 'off'} by /privacy`)
    },
    secrets: cfg.secrets,
    personal: cfg.personal,
    get values() {
      return engine.values
    },
    stats: () => records.stats(),
    preview: (text) => engine.preview(text),
  }
  // the command is there when dsh-commands is; the gateway runs either way
  ctx.inject?.(['commands'], (child) => {
    child.effect(() => {
      const text = COMMAND_TEXT[langOf(localeOf(ctx))]
      return child.commands.register({
        name: 'privacy',
        description: text.description,
        input: { hint: text.hint },
        // `test <text>` may hold the very secrets the gateway keeps from the log
        recordInput: false,
        handler: (invocation) => runPrivacyCommand(face, invocation.rawInput, langOf(localeOf(ctx))),
      })
    })
  })
  // the settings card's Remote service; the gateway does not depend on it
  if (ctx.plugin) {
    const source: OverviewSource = {
      overview: (limit) => ({
        active: engine.active,
        secrets: cfg.secrets,
        personal: cfg.personal,
        record: cfg.record,
        values: engine.values,
        stats: records.stats(),
        recent: records.recent(limit),
      }),
    }
    let disposed = false
    ctx.effect(() => () => {
      disposed = true
    })
    import('./remote.ts').then(
      ({ PrivacyGatewayService }) => {
        if (!disposed) ctx.plugin?.(PrivacyGatewayService, source)
      },
      (err: unknown) => ctx.logger.warn('dsh-privacy-gateway: the settings card has no data (typert is not there)', err),
    )
  }
  ctx.effect(() => {
    const gateway = installGateway(engine, { excludeHosts: cfg.excludeHosts, logger: ctx.logger })
    ctx.logger.info('dsh-privacy-gateway: installed in front of the global dispatcher')
    return () => {
      gateway.dispose()
      void records.close()
    }
  })
}
