import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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
  // showPanel and excludeProviders are volatile: they come as live references
  assert.equal(liveBool(parsed.showPanel, true), false)
  assert.deepEqual({ ...parsed, showPanel: liveBool(parsed.showPanel, true), excludeProviders: liveStrings(parsed.excludeProviders) }, defaults)
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

    apply({ logger, effect: (fn) => disposers.push(fn()) }, { enabled: false })
    assert.equal(getGlobalDispatcher(), before)
  } finally {
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
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
