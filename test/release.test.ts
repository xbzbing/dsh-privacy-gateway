import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { devNull, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertArtifactIntegrity, assertTagSource } from '../scripts/release-source.mjs'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('the release gate verifies the existing tag source before building an artifact', () => {
  const gate = workflow.indexOf('- name: Gate')
  const source = workflow.indexOf('node scripts/release-source.mjs tag')
  assert.ok(source >= 0 && source < gate, 'an existing tag must be bound to this checkout before Gate')
  assert.match(workflow, /node scripts\/release-source\.mjs artifact/)
  assert.ok(workflow.indexOf('published-tag', gate) < workflow.indexOf('npm publish "${{ steps.state.outputs.tarball }}"'))
  assert.ok(workflow.lastIndexOf('published-tag') < workflow.indexOf('gh release create'))
})

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG = 'refs/tags/v0.3.1'

test('lightweight and annotated release tags bind to the checkout commit, not the tag object', () => {
  assert.equal(assertTagSource(HEAD, `${HEAD}\t${TAG}\n`, '0.3.1'), true)
  assert.equal(assertTagSource(HEAD, `${OTHER}\t${TAG}\n${HEAD}\t${TAG}^{}\n`, '0.3.1'), true)
  assert.throws(() => assertTagSource(HEAD, `${OTHER}\t${TAG}\n`, '0.3.1'), /does not name this checkout/)
  assert.throws(() => assertTagSource(HEAD, `${HEAD}\t${TAG}\n${OTHER}\t${TAG}^{}\n`, '0.3.1'), /does not name this checkout/)
})

test('a missing release tag is allowed only before creating the tag', () => {
  assert.equal(assertTagSource(HEAD, '', '0.3.1'), false)
  assert.throws(() => assertTagSource(HEAD, '', '0.3.1', true), /missing/)
})

test('malformed, duplicate and unrelated remote references fail closed', () => {
  for (const remote of [
    `bad\t${TAG}`,
    `${HEAD}\t${TAG}\n${HEAD}\t${TAG}`,
    `${HEAD}\trefs/heads/main`,
    `${HEAD}\t${TAG}^{}`,
    `${HEAD}\t${TAG}\tunexpected`,
  ]) assert.throws(() => assertTagSource(HEAD, remote, '0.3.1'))
  assert.throws(() => assertTagSource('not-a-commit', '', '0.3.1'))
  assert.throws(() => assertTagSource(HEAD, '', '0.3.1;echo unsafe'))
})

test('a stable release retry rejects bytes that differ from the published npm package', () => {
  const original = Buffer.from('synthetic release A')
  const changed = Buffer.from('synthetic release B')
  const integrity = `sha512-${createHash('sha512').update(original).digest('base64')}`
  assert.doesNotThrow(() => assertArtifactIntegrity(original, integrity))
  assert.throws(() => assertArtifactIntegrity(changed, integrity), /differs/)
  for (const invalid of ['', undefined, { digest: integrity }, 'sha512-invalid', 'unknown-YQ==']) {
    assert.throws(() => assertArtifactIntegrity(original, invalid))
  }
})

test('a weaker integrity token cannot override a mismatched stronger digest', () => {
  const bytes = Buffer.from('synthetic artifact')
  const weak = `sha1-${createHash('sha1').update(bytes).digest('base64')}`
  const strong = `sha512-${createHash('sha512').update('different').digest('base64')}`
  assert.throws(() => assertArtifactIntegrity(bytes, `${weak} ${strong}`), /differs/)
})

test('the CLI rejects a later same-version checkout against a real local annotated tag', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dpg-release-source-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  t.after(() => {
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + sep + 'dpg-release-source-'), true)
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' }
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '--bare', remote])
  git(['init', checkout])
  git(['remote', 'add', 'origin', remote], checkout)
  const commit = () => git(['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], checkout)
  commit()
  git(['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-a', 'v0.3.1', '-m', 'fixture tag'], checkout)
  git(['push', 'origin', 'refs/tags/v0.3.1'], checkout)
  const script = fileURLToPath(new URL('../scripts/release-source.mjs', import.meta.url))
  const verify = () => execFileSync(process.execPath, [script, 'published-tag', '0.3.1'], { cwd: checkout, encoding: 'utf8', stdio: 'pipe' })
  assert.equal(verify().trim(), 'tag=done')
  commit()
  assert.throws(verify, /does not name this checkout/)
})
