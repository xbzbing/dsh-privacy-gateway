#!/usr/bin/env node
/**
 * Asserts an unpacked `pnpm pack` tree carries everything the plugin needs to
 * load, and nothing that would run during install.
 *
 * The unit tests import `src/` directly, so they cannot notice a `files`
 * entry that drops a runtime artifact, or a lifecycle script that only exists
 * to build one. This checks the artifact that actually ships (the npm tarball
 * and the GitHub Release asset are the same file), so such a mistake fails the
 * release instead of the user. See docs/adr/0006.
 *
 * Usage: node scripts/assert-pack.mjs <unpacked-package-dir>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Lifecycle hooks that must never be present (docs/adr/0006). */
const INSTALL_HOOKS = [
  'preinstall', 'install', 'postinstall', 'prepare',
  'prepublish', 'prepublishOnly', 'prepack', 'postpack',
]

/** Artifacts every install needs. */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'locale/en.json',
  'locale/zh.json',
  'assets/icon.svg',
  'LICENSE',
  'README.md',
  'README.en.md',
]

const arg = process.argv[2]
const root = arg ? resolve(arg) : ''
if (!root || !existsSync(root)) {
  console.error(`assert-pack: package directory not found: ${arg ?? '(missing argument)'}`)
  process.exit(2)
}

const problems = []

for (const file of REQUIRED) {
  if (!existsSync(join(root, file))) problems.push(`missing required file: ${file}`)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

for (const hook of INSTALL_HOOKS) {
  if (manifest.scripts?.[hook] !== undefined) {
    problems.push(`install-time lifecycle script declared: scripts.${hook} (docs/adr/0006)`)
  }
}

// Every concrete entry point the loader or Plugin Manager may read must exist.
const targets = [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch]
for (const value of Object.values(manifest.exports ?? {})) {
  if (typeof value === 'string' && !value.includes('*')) targets.push(value)
}
for (const target of new Set(targets)) {
  if (typeof target === 'string' && !existsSync(join(root, target))) {
    problems.push(`manifest points at a file the package does not ship: ${target}`)
  }
}

// Plugin Manager renders each locale's `meta.detail` as the details page, so
// a dropped `docs/details` entry would show an empty page instead of failing.
for (const name of readdirSync(join(root, 'locale')).filter((f) => f.endsWith('.json'))) {
  const detail = JSON.parse(readFileSync(join(root, 'locale', name), 'utf8')).meta?.detail
  if (typeof detail !== 'string') problems.push(`locale/${name} has no meta.detail`)
  else if (!existsSync(join(root, detail))) problems.push(`locale/${name} meta.detail points at a file the package does not ship: ${detail}`)
}

// The client loader only registers a bundle that announces itself under this package's id.
const clientPath = join(root, 'lib/client.js')
if (existsSync(clientPath) && !readFileSync(clientPath, 'utf8').startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}`)) {
  problems.push(`lib/client.js does not register itself as '${manifest.name}'`)
}

// The loader imports the patch row's `name`; it must be this package.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: '${manifest.name}'`)) {
  problems.push(`cordis.patch.yml row name is not the package name '${manifest.name}'`)
}

if (problems.length > 0) {
  console.error(`assert-pack: ${root} does not ship a loadable plugin:\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}

console.log(`assert-pack: ${root} is loadable (${REQUIRED.length} required files, ${targets.length} manifest targets)`)
