import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getGlobalDispatcher } from 'undici'

import { Config, defaults, liveBool, liveStrings, resolveConfig } from '../src/config.ts'
import { MaskingDispatcher } from '../src/dispatcher.ts'
import { apply, name } from '../src/index.ts'
import { stateDir } from '../src/paths.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }

test('cordis patch row name equals the package name', () => {
  // The loader imports the row's `name`; a mismatch fails with ERR_MODULE_NOT_FOUND.
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name: '${pkg.name}'`))
  assert.equal(name, pkg.name)
})

test('locale dictionaries ship en + zh meta', () => {
  for (const lang of ['en', 'zh']) {
    const parsed = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf8')) as {
      meta?: { title?: string; description?: string }
    }
    assert.ok(parsed.meta?.title?.trim(), `${lang}: meta.title`)
    assert.ok(parsed.meta?.description?.trim(), `${lang}: meta.description`)
  }
})

test('package icon is a shipped SVG within the 256 KiB limit', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    icon?: string
    files?: string[]
  }
  assert.equal(manifest.icon, './assets/icon.svg')
  assert.ok(manifest.files?.includes('assets'), 'files includes assets')
  const svg = readFileSync(join(root, manifest.icon), 'utf8')
  assert.match(svg, /^<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.ok(Buffer.byteLength(svg) <= 256 * 1024)
})

test('manifest declares no install-time lifecycle scripts', () => {
  // docs/adr/0006: installs never build, so no hook may run during install or pack.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack']) {
    assert.equal(manifest.scripts?.[hook], undefined, `scripts.${hook}`)
  }
})

test('Config defaults and round-trips through toJSON', () => {
  const parsed = Config({}) as Record<string, unknown>
  // the fields the configuration page edits are volatile: they come as live references
  assert.equal(liveBool(parsed.showPanel, true), false)
  assert.deepEqual(liveStrings(parsed.excludeProviders), [])
  assert.deepEqual(resolveConfig(parsed), defaults)
  assert.equal(resolveConfig(Config({ showPanel: true })).showPanel, true)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.doesNotThrow(() => JSON.stringify(Config.toJSON()))
})

test('resolveConfig clamps what the schema cannot', () => {
  assert.equal(resolveConfig({ maxValues: 3 }).maxValues, defaults.maxValues)
  assert.equal(resolveConfig({ maxValues: 1234.9 }).maxValues, 1234)
  assert.deepEqual(resolveConfig({ excludeHosts: [' API.Example.com:443 ', ''] }).excludeHosts, ['api.example.com:443'])
})

test('apply installs the gateway and its disposal puts the previous dispatcher back', () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-apply-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void> = []
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  try {
    apply({ logger, effect: (fn) => disposers.push(fn()) }, {})
    assert.ok(getGlobalDispatcher() instanceof MaskingDispatcher)
    assert.equal(statSync(join(home, 'redact.key')).mode & 0o777, 0o600)
    for (const d of disposers) d()
    assert.equal(getGlobalDispatcher(), before)

    // enabled is volatile: off, the gateway is installed and lets every request by (docs/adr/0021)
    disposers.length = 0
    apply({ logger, effect: (fn) => disposers.push(fn()) }, { enabled: false })
    assert.ok(getGlobalDispatcher() instanceof MaskingDispatcher)
    for (const d of disposers) d()
    assert.equal(getGlobalDispatcher(), before)
  } finally {
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("apply keeps the state in the instance's directory, not in the shared one (docs/adr/0027)", () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const profile = mkdtempSync(join(tmpdir(), 'dpg-profile-'))
  delete process.env.DSH_PRIVACY_GATEWAY_HOME
  const disposers: Array<() => void> = []
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  try {
    apply({ logger, effect: (fn) => disposers.push(fn()), profileContext: { dir: profile } }, {})
    const dir = join(profile, 'plugin-data', 'dsh-privacy-gateway')
    assert.equal(statSync(join(dir, 'redact.key')).mode & 0o777, 0o600)
    for (const d of disposers) d()
    assert.equal(readFileSync(join(dir, 'redact.key')).length, 32)
  } finally {
    for (const d of disposers.splice(0)) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(profile, { recursive: true, force: true })
  }
})

test('stateDir honours DSH_PRIVACY_GATEWAY_HOME', () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  try {
    delete process.env.DSH_PRIVACY_GATEWAY_HOME
    assert.equal(stateDir(), join(homedir(), '.dsh', 'privacy-gateway'))
    process.env.DSH_PRIVACY_GATEWAY_HOME = '/tmp/pg-home'
    assert.equal(stateDir(), '/tmp/pg-home')
  } finally {
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
  }
})

test("stateDir is the instance's own directory, so two instances keep their own data (docs/adr/0027)", () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const web = join(tmpdir(), 'dpg-instance-web')
  const desktop = join(tmpdir(), 'dpg-instance-desktop')
  try {
    delete process.env.DSH_PRIVACY_GATEWAY_HOME
    assert.equal(stateDir({ dir: web }), join(web, 'plugin-data', 'dsh-privacy-gateway'))
    assert.notEqual(stateDir({ dir: web }), stateDir({ dir: desktop }))
    // no profile facts (a run of the SDK or the tests): the home directory still takes it
    assert.equal(stateDir({}), join(homedir(), '.dsh', 'privacy-gateway'))
    assert.equal(stateDir({ dir: '  ' }), join(homedir(), '.dsh', 'privacy-gateway'))
    // the env wins over the instance, as it is how a test or a user moves the state away
    process.env.DSH_PRIVACY_GATEWAY_HOME = '/tmp/pg-home'
    assert.equal(stateDir({ dir: web }), '/tmp/pg-home')
  } finally {
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
  }
})

test('/privacy on does not claim masking is on while the configuration keeps it off', () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-command-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const disposers: Array<() => void> = []
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const config = { enabled: false }
  let run: (invocation: { rawInput: string }) => { kind: string; text?: string } = () => ({ kind: 'error' })
  try {
    apply(
      {
        logger,
        effect: (fn: () => () => void) => disposers.push(fn()),
        inject: (_deps: string[], callback: (child: unknown) => void) =>
          callback({
            logger,
            effect: (fn: () => () => void) => disposers.push(fn()),
            commands: {
              register: (definition: { handler: typeof run }) => {
                run = definition.handler
                return () => {}
              },
            },
          } as never),
      } as never,
      config,
    )
    assert.match(run({ rawInput: 'on' }).text ?? '', /disabled in the configuration/)
    assert.match(run({ rawInput: 'status' }).text ?? '', /Config: masking off/)
    // off clears the run switch even though the effective state was already off:
    // turning the config back on must not turn masking on behind the user's back
    assert.match(run({ rawInput: 'off' }).text ?? '', /already off/)
    config.enabled = true
    assert.match(run({ rawInput: 'status' }).text ?? '', /State: off/)
  } finally {
    for (const d of disposers.splice(0)) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test('the card\'s reset clears the day files and the kept bodies', async () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-reset-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const disposers: Array<() => void> = []
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  let source: { reset(): Promise<{ files: number }> } | undefined
  try {
    apply(
      {
        logger,
        effect: (fn: () => () => void) => disposers.push(fn()),
        plugin: (_plugin: unknown, config: unknown) => {
          source = config as { reset(): Promise<{ files: number }> }
        },
      } as never,
      {},
    )
    // the Remote service is loaded with a dynamic import, after apply returns
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(source, 'the card\'s source was registered')
    const day = join(home, 'masking', '2000-01-01.jsonl')
    mkdirSync(dirname(day), { recursive: true })
    writeFileSync(day, '{}\n')
    const r = await source.reset()
    assert.equal(r.files, 1)
    assert.equal(existsSync(day), false)
  } finally {
    for (const d of disposers.splice(0)) d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})
