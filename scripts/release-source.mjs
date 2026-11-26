#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/i
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * A remote tag must name this checkout, including an annotated tag's peeled commit.
 * @param {string} head
 * @param {string} remote
 * @param {string} version
 * @param {boolean} required
 */
export function assertTagSource(head, remote, version, required = false) {
  if (!SHA.test(head) || !VERSION.test(version)) throw new Error('invalid release source identity')
  const ref = `refs/tags/v${version}`
  /** @type {Map<string, string>} */
  const found = new Map()
  for (const line of remote.trim().split('\n')) {
    if (line === '') continue
    const parts = line.split(/\s+/)
    const [sha, name] = parts
    if (parts.length !== 2 || !sha || !name || !SHA.test(sha) || ![ref, `${ref}^{}`].includes(name) || found.has(name)) {
      throw new Error('invalid remote release tag response')
    }
    found.set(name, sha.toLowerCase())
  }
  if (found.has(`${ref}^{}`) && !found.has(ref)) throw new Error('release tag has no tag reference')
  const commit = found.get(`${ref}^{}`) ?? found.get(ref)
  if (!commit) {
    if (required) throw new Error('release tag is missing; no artifact may be published')
    return false
  }
  if (commit !== head.toLowerCase()) throw new Error('release tag does not name this checkout; refusing a different-source artifact')
  return true
}

/**
 * A resumed stable release must attach the exact bytes already published to npm.
 * @param {Uint8Array} bytes
 * @param {unknown} integrity
 */
export function assertArtifactIntegrity(bytes, integrity) {
  if (typeof integrity !== 'string' || integrity.trim() === '') throw new Error('published package integrity is missing')
  const tokens = integrity.trim().split(/\s+/)
  const strongest = ['sha512', 'sha384', 'sha256', 'sha1'].find((algorithm) => tokens.some((token) => token.startsWith(`${algorithm}-`)))
  for (const token of tokens) {
    const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(token)
    if (!match || !match[1] || !match[2] || match[1] !== strongest) continue
    const expected = Buffer.from(match[2], 'base64')
    const actual = createHash(match[1]).update(bytes).digest()
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return
  }
  throw new Error('release artifact differs from the package already published to npm')
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  // Fixed argv keeps registry output and version strings out of shell expansion.
  return execFileSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** @param {string[]} args */
function main(args) {
  const [mode, target, spec] = args
  if (mode === 'tag' || mode === 'published-tag') {
    if (!target || !VERSION.test(target) || spec !== undefined) throw new Error('usage: release-source.mjs tag|published-tag <version>')
    const ref = `refs/tags/v${target}`
    const head = run('git', ['rev-parse', 'HEAD'])
    // A successful empty lookup means absent; transport failures must not look absent.
    const remote = run('git', ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`])
    if (assertTagSource(head, remote, target, mode === 'published-tag')) process.stdout.write('tag=done\n')
    return
  }
  if (mode === 'artifact' && target && spec && args.length === 3) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (spec !== `${pkg.name}@${pkg.version}`) throw new Error('artifact identity does not match package.json')
    const integrity = JSON.parse(run('npm', ['view', spec, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org']))
    assertArtifactIntegrity(readFileSync(resolve(target)), integrity)
    return
  }
  throw new Error('usage: release-source.mjs artifact <tarball> <name@version>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`release-source: ${err instanceof Error ? err.message : 'source verification failed'}\n`)
    process.exitCode = 1
  }
}
