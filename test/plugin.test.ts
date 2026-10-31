import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, resolveConfig } from '../src/config.ts'
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

test('Config defaults to enabled and round-trips through toJSON', () => {
  assert.deepEqual(Config({}), { enabled: true })
  assert.deepEqual(resolveConfig({ enabled: false }), { enabled: false })
  assert.doesNotThrow(() => JSON.stringify(Config.toJSON()))
})

test('apply logs and returns without throwing', () => {
  const lines: unknown[][] = []
  const logger = { info: (...a: unknown[]) => lines.push(a), warn: () => {}, error: () => {} }
  apply({ logger }, {})
  apply({ logger }, { enabled: false })
  assert.equal(lines.length, 2)
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
