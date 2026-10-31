import { join } from 'node:path'

import { langOf, runPrivacyCommand, type PrivacyFace } from './command.ts'
import { liveBool, liveStrings, resolveConfig, type PrivacyGatewayConfig } from './config.ts'
import { installGateway } from './dispatcher.ts'
import { PrivacyEngine } from './engine.ts'
import { stateDir } from './paths.ts'
import { bypassedProvider, routeStream } from './providers.ts'
import { RecordStore } from './records.ts'
import type { OverviewSource } from './remote.ts'
import { ViewStore } from './views.ts'
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
  /** cordis: listen to an event; `llm/stream` is a waterfall around each model call. */
  on?(name: 'llm/stream', listener: (options: { provider?: unknown; sessionId?: unknown }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): unknown
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
  // the vendor view keeps the bodies as they went, in memory only
  const views = cfg.vendorView ? new ViewStore() : undefined
  const optional = (name: string): unknown => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  // a record says which workspace and session the call came from, by name (docs/adr/0020): read from the
  // live session and the workspace registry, both optional so the gateway runs without them
  const names = (session: string): { title?: string; workspace?: string } => {
    const live = optional('sessions') as { get?(id: string): unknown } | undefined
    const titles = optional('sessionTitle') as { get?(s: unknown): { title?: unknown } | undefined } | undefined
    const workspaces = optional('workspaceRegistry') as { list?(): readonly { title?: unknown; sessionIds?: readonly unknown[] }[] } | undefined
    const out: { title?: string; workspace?: string } = {}
    try {
      const session_ = live?.get?.(session)
      const title = session_ === undefined ? undefined : titles?.get?.(session_)?.title
      if (typeof title === 'string' && title !== '') out.title = title.slice(0, 200)
    } catch {
      // a title that cannot be read is no title
    }
    try {
      for (const w of workspaces?.list?.() ?? []) {
        if (!w.sessionIds?.some((id) => String(id) === session)) continue
        if (typeof w.title === 'string' && w.title !== '') out.workspace = w.title.slice(0, 200)
        break
      }
    } catch {
      // a workspace that cannot be read is no workspace
    }
    return out
  }
  const excludedProviders = (): string[] => liveStrings(config.excludeProviders)
  const engine = new PrivacyEngine(key, cfg, { records, logger: ctx.logger, ...(views ? { views } : {}), names })
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
        vendorView: cfg.vendorView,
        views: views?.keys() ?? [],
        // read now: the detail page's switch changes it without remounting the plugin
        showPanel: liveBool(config.showPanel, cfg.showPanel),
        excludeProviders: excludedProviders(),
      }),
      providers: () => {
        const llm = optional('llm') as { listProviders?(): readonly { id?: unknown; name?: unknown }[] } | undefined
        try {
          return (llm?.listProviders?.() ?? []).flatMap((p) => {
            const id = typeof p?.id === 'string' ? p.id : ''
            if (id === '') return []
            return [{ id, name: typeof p.name === 'string' && p.name !== '' ? p.name : id }]
          })
        } catch {
          return []
        }
      },
      vendorView: (key) => {
        const body = views?.get(key)
        return body === undefined ? null : { key, body }
      },
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
  ctx.on?.('llm/stream', (options, next) => routeStream(options?.provider, excludedProviders(), next, options?.sessionId))
  ctx.effect(() => {
    const gateway = installGateway(engine, { excludeHosts: cfg.excludeHosts, skip: () => bypassedProvider() !== undefined, logger: ctx.logger })
    ctx.logger.info('dsh-privacy-gateway: installed in front of the global dispatcher')
    return () => {
      gateway.dispose()
      void records.close()
    }
  })
}

