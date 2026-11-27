import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getGlobalDispatcher } from 'undici'

import { Config, defaults, liveBool, liveStrings, resolveConfig, type PrivacyGatewayConfig } from '../src/config.ts'
import { MaskingDispatcher } from '../src/dispatcher.ts'
import { apply, name, type StreamListener } from '../src/index.ts'
import { stateDir } from '../src/paths.ts'
import type { OverviewSource } from '../src/remote.ts'

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
  // the default layer is the dispatcher (docs/adr/0039): an install without the field changes nothing
  assert.equal(resolveConfig(parsed).intercept, 'dispatcher')
  assert.deepEqual(resolveConfig(parsed), defaults)
  assert.equal(resolveConfig(Config({ showPanel: true })).showPanel, true)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ intercept: 'stream' }).intercept, 'stream')
  assert.equal(resolveConfig({ intercept: 'nope' as never }).intercept, 'dispatcher')
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

    // stream mode never touches the global dispatcher at all
    disposers.length = 0
    apply({ logger, effect: (fn) => disposers.push(fn()) }, { intercept: 'stream' })
    assert.equal(getGlobalDispatcher(), before)
    for (const d of disposers) d()
    assert.equal(getGlobalDispatcher(), before)
  } finally {
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test('intercept defaults to dispatcher and hot-switches the halves in both directions', async () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-modes-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void | Promise<void>> = []
  const config: PrivacyGatewayConfig = {}
  let listener: StreamListener | undefined
  const llm = { stream: () => (async function* () { yield { type: 'finish' } })() }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => () => void | Promise<void>) => disposers.push(fn()),
    on: (event: string, l: unknown) => {
      if (event === 'llm/stream') listener = l as StreamListener
    },
    inject: (deps: string[], cb: (child: unknown) => void) => {
      if (deps.includes('llm')) cb({ ...ctx, llm })
    },
  }
  const run = async (): Promise<void> => {
    assert.ok(listener)
    const next = async function* () { yield { type: 'finish' } }
    for await (const _ of listener({ provider: 'openai' }, next)) void _
  }
  try {
    apply(ctx as never, config)
    assert.ok(getGlobalDispatcher() instanceof MaskingDispatcher, 'the default install is the dispatcher half')
    await run()
    config.intercept = 'stream'
    await run()
    assert.equal(getGlobalDispatcher(), before, 'the old gateway is disposed on the way to stream')
    config.intercept = 'dispatcher'
    await run()
    assert.ok(getGlobalDispatcher() instanceof MaskingDispatcher, 'a switch back installs a live gateway again')
    config.intercept = 'stream'
    await run()
    assert.equal(getGlobalDispatcher(), before, 'the second switch disposes it again')
  } finally {
    for (const d of disposers.splice(0)) await d()
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
    assert.equal(getGlobalDispatcher(), before)
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

for (const action of ['warn', 'block'] as const) test(`the Remote session display reuses the ${action} request's safe audit snapshot`, async () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), `dpg-session-${action}-`))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const key = 'sk-proj-' + 'auditBoundarySENTINEL0123456789abcd'
  const rawSession = `prefix${key}suffix`
  const disposers: Array<() => unknown> = []
  const logs: unknown[][] = []
  const logger = { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }
  let source: OverviewSource | undefined
  let sent = false
  const server = createServer((req, res) => {
    sent = true
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
  })
  try {
    apply({ logger, effect: (fn) => disposers.push(fn()), plugin: (_plugin, value) => { source = value as OverviewSource } }, { record: false, actions: { API_KEY: action } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(source)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    const request = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': rawSession }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `key ${key}` }] }) })
    if (action === 'block') await assert.rejects(request, /fetch failed/)
    else await (await request).text()
    const overview = source.overview(50, rawSession)
    assert.equal(sent, action === 'warn')
    assert.equal(overview.values, 0, 'warned and blocked values never enter the restoration table')
    assert.equal(overview.recent.length, 1)
    assert.equal(overview.stats.today.requests, 1)
    assert.ok(overview.recent[0]?.session && !overview.recent[0].session.includes(key), 'the recorded request snapshot is already safe')
    assert.equal(overview.session, overview.recent[0]?.session)
    assert.ok(!JSON.stringify(overview).includes(key))
    assert.ok(!JSON.stringify(logs).includes(key))
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test('/privacy test applies each volatile change before its first preview without recording any input', async () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-preview-live-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const key = 'sk-proj-' + 'livePreviewSENTINEL0123456789abcd'
  const word = 'private-' + 'launch-project-codename'
  const allowed = 'private-' + 'previously-allowed-codename'
  const email = 'preview-' + 'private@baidu.com'
  let words: string[] = []
  let allow = [allowed]
  let personal = false
  const config = { record: false, words: { get: () => words }, allow: { get: () => allow }, personal: { get: () => personal } }
  const disposers: Array<() => unknown> = []
  const logs: unknown[][] = []
  const logger = { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }
  let run: (invocation: { rawInput: string }) => { kind: string; text?: string } = () => ({ kind: 'error' })
  let source: OverviewSource | undefined
  let recordInput: boolean | undefined
  let sent = ''
  const server = createServer((req, res) => {
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { sent += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}]}')
    })
  })
  try {
    apply({
      logger,
      effect: (fn: () => () => void) => disposers.push(fn()),
      plugin: (_plugin: unknown, value: unknown) => { source = value as OverviewSource },
      inject: (_deps: string[], callback: (child: unknown) => void) => callback({
        logger,
        effect: (fn: () => () => void) => disposers.push(fn()),
        commands: { register: (definition: { handler: typeof run; recordInput?: boolean }) => {
          run = definition.handler
          recordInput = definition.recordInput
          return () => {}
        } },
      }),
    } as never, config as never)
    assert.equal(recordInput, false)
    assert.ok(!run({ rawInput: `test ${key}` }).text?.includes(key))
    words = [word]
    const added = run({ rawInput: `test ${word} ${key}` })
    assert.equal(added.kind, 'success')
    assert.ok(added.text?.includes('DSH_REDACTED:TERM_'))
    assert.ok(!added.text?.includes(word))
    assert.ok(!added.text?.includes(key))
    personal = true
    const personalAdded = run({ rawInput: `test ${email} ${key}` })
    assert.ok(personalAdded.text?.includes('DSH_REDACTED:EMAIL_'))
    assert.ok(!personalAdded.text?.includes(email))
    words = [word, allowed]
    run({ rawInput: `test ${key}` })
    allow = []
    const removed = run({ rawInput: `test ${allowed} ${key}` })
    assert.ok(!removed.text?.includes(allowed))
    assert.ok(!removed.text?.includes(key))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(source)
    assert.equal(source.overview(50).values, 0, 'previews never enter the value table')
    assert.equal(source.overview(50).recent.length, 0, 'previews never create records')
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`
    const sourceSession = `s1-${word}-${key}`
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': sourceSession }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `${word} ${allowed} ${email} ${key}` }] }) })
    assert.equal(response.status, 200)
    await response.text()
    // A raw lookup id remains usable even when audit metadata has to hide a value inside it.
    const overview = source.overview(50, sourceSession)
    assert.equal(overview.recent.length, 1)
    assert.equal(overview.stats.today.requests, 1)
    assert.ok(overview.session && overview.session !== sourceSession)
    words = []
    allow = [word, allowed]
    personal = false
    const changed = source.overview(50, sourceSession)
    assert.equal(changed.recent.length, 1, 'a later rule change does not lose the raw session lookup')
    assert.equal(changed.stats.today.requests, 1)
    for (const secret of [word, allowed, email, key]) {
      assert.ok(!sent.includes(secret))
      assert.ok(!JSON.stringify(overview).includes(secret))
      assert.ok(!JSON.stringify(changed).includes(secret))
      assert.ok(!JSON.stringify(logs).includes(secret))
    }
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})
