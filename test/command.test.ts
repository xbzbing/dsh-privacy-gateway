import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { langOf, runPrivacyCommand, type PrivacyFace } from '../src/command.ts'
import { defaults } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { apply, type CommandsService, type PluginContext } from '../src/index.ts'

const SENTINEL = 'sk-' + 'proj-SENTINELsentinel0123456789abcd'
const chat = (content: string) => JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] })
const info = { host: 'api.example.com', path: '/v1/chat/completions' }

function faceOf(engine: PrivacyEngine): PrivacyFace {
  return {
    get active() {
      return engine.active
    },
    set active(on: boolean) {
      engine.active = on
    },
    secrets: true,
    personal: false,
    get values() {
      return engine.values
    },
    stats: () => engine.records.stats(),
    preview: (t) => engine.preview(t),
  }
}

test('status gives the counts of today, 7 and 30 days, and never a value', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const ex = engine.maskRequest(chat(`key ${SENTINEL}`), info)
  assert.ok(ex)
  const p = /\{\{API_KEY_[a-z2-7]{8}\}\}/.exec(ex.text)?.[0] ?? ''
  ex.restoreBody(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ cmd: `curl -H ${p}` }) } }] } }] }))
  ex.finish()
  for (const lang of ['zh', 'en'] as const) {
    const r = runPrivacyCommand(faceOf(engine), '', lang)
    assert.equal(r.kind, 'success')
    assert.ok(!r.text.includes(SENTINEL))
    assert.ok(!r.text.includes(SENTINEL.slice(3)))
    assert.match(r.text, lang === 'zh' ? /今日：1 次请求，1 次有遮蔽，替换 1 处，还原 1 处（工具参数里 1 处）/ : /Today: 1 requests, 1 masked, 1 places replaced, 1 restored \(1 in tool arguments\)/)
    assert.match(r.text, /API_KEY 1/)
  }
  assert.deepEqual(runPrivacyCommand(faceOf(engine), ' status ', 'en'), runPrivacyCommand(faceOf(engine), '', 'en'))
})

test('off sends requests as written and on masks them again; the config is not touched', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const face = faceOf(engine)
  assert.match(runPrivacyCommand(face, ' off', 'en').text, /Masking is off/)
  assert.equal(engine.maskRequest(chat(SENTINEL), info), null)
  assert.match(runPrivacyCommand(face, 'off', 'en').text, /already off/)
  assert.match(runPrivacyCommand(face, 'status', 'zh').text, /状态：已关闭/)
  assert.match(runPrivacyCommand(face, 'ON', 'zh').text, /脱敏已开启/)
  assert.ok(!engine.maskRequest(chat(SENTINEL), info)?.text.includes(SENTINEL))
})

test('test shows the text as it would go, a hint per value, and remembers nothing', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const r = runPrivacyCommand(faceOf(engine), `test token ${SENTINEL} twice ${SENTINEL}`, 'en')
  assert.equal(r.kind, 'success')
  assert.ok(!r.text.includes(SENTINEL))
  assert.match(r.text, /^Would go as:\ntoken \{\{API_KEY_[a-z2-7]{8}\}\} twice \{\{API_KEY_[a-z2-7]{8}\}\}\n\n1 value:\n\{\{API_KEY_[a-z2-7]{8}\}\} {2}API_KEY · rule · sk-… 38$/)
  assert.equal(engine.values, 0)
  assert.equal(engine.records.recent().length, 0)
  assert.match(runPrivacyCommand(faceOf(engine), 'test nothing secret here', 'en').text, /Nothing in this text/)
  assert.equal(runPrivacyCommand(faceOf(engine), 'test   ', 'zh').kind, 'error')
})

test('an unknown subcommand answers with the usage', () => {
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const r = runPrivacyCommand(faceOf(engine), 'reset', 'zh')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /用法：\/privacy/)
})

test('the answer language follows the locale preference', () => {
  assert.equal(langOf('zh-CN'), 'zh')
  assert.equal(langOf('zh'), 'zh')
  assert.equal(langOf('en-US'), 'en')
  assert.equal(langOf(undefined), 'en')
})

test('apply registers /privacy once dsh-commands is there, with its input kept out of the log', () => {
  const saved = process.env.DSH_PRIVACY_GATEWAY_HOME
  const home = mkdtempSync(join(tmpdir(), 'dpg-cmd-'))
  process.env.DSH_PRIVACY_GATEWAY_HOME = home
  const before = getGlobalDispatcher()
  const disposers: Array<() => void> = []
  const registered: Array<Parameters<CommandsService['register']>[0]> = []
  let unregistered = 0
  const commands: CommandsService = {
    register(def) {
      registered.push(def)
      return () => unregistered++
    },
  }
  const ctx: PluginContext = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => disposers.push(fn()),
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['commands'])
      cb({ ...ctx, commands })
    },
    get: (name) => (name === 'settings' ? { describe: () => [{ ns: 'locale', value: { preference: 'zh-CN' } }] } : undefined),
  }
  try {
    apply(ctx, { record: false })
    assert.equal(registered.length, 1)
    const def = registered[0]
    assert.equal(def?.name, 'privacy')
    assert.equal(def?.recordInput, false)
    assert.match(def?.description ?? '', /隐私网关/)
    const r = def?.handler({ rawInput: ` test ${SENTINEL}` })
    assert.equal(r?.kind, 'success')
    assert.ok(!r?.text?.includes(SENTINEL))
  } finally {
    for (const d of disposers) d()
    setGlobalDispatcher(before)
    if (saved === undefined) delete process.env.DSH_PRIVACY_GATEWAY_HOME
    else process.env.DSH_PRIVACY_GATEWAY_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
  assert.equal(unregistered, 1)
})
