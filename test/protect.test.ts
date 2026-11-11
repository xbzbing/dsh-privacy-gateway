import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { ValueTable } from '../src/redact/known.ts'
import { Masker } from '../src/redact/mask.ts'

// Built from pieces so no literal in the repository reads as a live credential.
const KEY = 'sk-' + 'proj-PROTECTprotect0123456789abcd'
/** An <env> block as raw JSON text, escapes and all, with a key inside it that must stay. */
const ENV = `<env>\\n  Working directory: /Users/caf\\u00e9/${KEY}\\n  \\u003cnote\\u003e \\"quoted\\" a\\\\b c\\/d \\t\\ud83d\\ude00\\n</env>`
const ENV_GO = `\\u003cenv\\u003e\\n  cwd: /tmp/caf\\u00e9 ${KEY}\\n\\u003c/env\\u003e`
const TOOL = `{"type":"function","function":{"name":"bash","description":"run caf\\u00e9 \\u003ccmd\\u003e with ${KEY}","parameters":{"type":"object","properties":{"cmd":{"type":"string","description":"\\u0026 ${KEY}"}}}}}`

const CASES: Array<{ name: string; body: string; kept: string[] }> = [
  {
    name: 'OpenAI chat: system <env> and tools',
    body: `{"model":"m","messages":[{"role":"system","content":"You are an agent.\\n${ENV}\\nkey ${KEY} caf\\u00e9"},{"role":"user","content":"hi"}],"tools":[${TOOL}]}`,
    kept: [ENV, `"tools":[${TOOL}]`],
  },
  {
    name: 'OpenAI legacy functions',
    body: `{"model":"m","messages":[{"role":"user","content":"key ${KEY}"}],"functions":[{"name":"bash","description":"caf\\u00e9 ${KEY}","parameters":{}}]}`,
    kept: [`"functions":[{"name":"bash","description":"caf\\u00e9 ${KEY}","parameters":{}}]`],
  },
  {
    name: 'Anthropic: system as a block array, tools with input_schema',
    body: `{"model":"m","system":[{"type":"text","text":"${ENV}\\nUse ${KEY} \\u003cok\\u003e"}],"messages":[{"role":"user","content":[{"type":"text","text":"key ${KEY}"}]}],"tools":[{"name":"read","description":"caf\\u00e9","input_schema":{"type":"object","properties":{"path":{"type":"string","description":"${KEY} \\u003c"}}}}]}`,
    kept: [ENV, `"tools":[{"name":"read","description":"caf\\u00e9","input_schema":{"type":"object","properties":{"path":{"type":"string","description":"${KEY} \\u003c"}}}}]`],
  },
  {
    name: 'Responses: instructions with <env>, written with Go escapes',
    body: `{"model":"m","instructions":"agent\\n${ENV_GO}\\nkey ${KEY}","input":[{"role":"user","content":[{"type":"input_text","text":"key ${KEY} \\u00e9"}]}],"tools":[{"type":"function","name":"bash","description":"${KEY}","parameters":{}}]}`,
    kept: [ENV_GO, `"tools":[{"type":"function","name":"bash","description":"${KEY}","parameters":{}}]`],
  },
]

test('protected regions reach the vendor byte for byte, and only the masked values change', () => {
  for (const c of CASES) {
    const table = new ValueTable(5000)
    const masker = new Masker(randomBytes(32), table, { secrets: true, protectEnvBlock: true, protectTools: true })
    const out = masker.maskJSON(c.body)
    assert.ok(out, c.name)
    assert.ok(out.n >= 1, c.name)
    for (const k of c.kept) assert.ok(out.text.includes(k), `${c.name}: ${k.slice(0, 40)}…`)
    const p = /\{\{API_KEY_[a-z2-7]{8}\}\}/.exec(out.text)?.[0] ?? ''
    // every key outside the regions became the placeholder; every other byte is the body's
    const kept = c.kept.map((k, i) => [k, `\u0000${i}\u0000`] as const)
    const strip = (t: string): string => kept.reduce((acc, [k, mark]) => acc.split(k).join(mark), t)
    assert.equal(strip(out.text), strip(c.body).split(KEY).join(p), c.name)
    assert.ok(JSON.parse(out.text), c.name)
  }
})

test('an <env> block is protected only in the text the host writes (ADR-0004 supplement)', () => {
  const table = new ValueTable(5000)
  const masker = new Masker(randomBytes(32), table, { secrets: true, protectEnvBlock: true, protectTools: true })
  const env = `<env>\n  cwd: /tmp\n  ${KEY}\n</env>`
  const one = (body: string): string => {
    const out = masker.maskJSON(body)
    assert.ok(out, body.slice(0, 80))
    return out.text
  }
  // the system prompt's block stays byte for byte, key inside included
  const system = one(JSON.stringify({ model: 'm', messages: [{ role: 'system', content: `agent\n${env}` }, { role: 'user', content: 'hi' }] }))
  assert.ok(system.includes(JSON.stringify(env).slice(1, -1)))
  // a user message quoting one is no protected region: the key goes as its placeholder
  for (const body of [
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `<env> oops ${KEY}` }] }),
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', content: `read: <env> ${KEY}` }] }] }),
    JSON.stringify({ model: 'm', messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ cmd: `echo <env> ${KEY}` }) } }] }] }),
  ]) {
    const out = one(body)
    assert.ok(!out.includes(KEY), out)
    assert.match(out, /\{\{API_KEY_[a-z2-7]{8}\}\}/)
  }
  // the Responses instructions stay whole; the user input beside them does not
  const responses = one(JSON.stringify({ model: 'm', instructions: `agent\n${env}`, input: [{ role: 'user', content: [{ type: 'input_text', text: `<env> ${KEY}` }] }] }))
  assert.equal(responses.split(KEY).length - 1, 1, responses)
  assert.match(responses, /\{\{API_KEY_[a-z2-7]{8}\}\}/)
  // Gemini: systemInstruction is the host's, contents are not
  const gemini = one(JSON.stringify({ model: 'm', systemInstruction: { parts: [{ text: `<env>${KEY}</env>` }] }, contents: [{ role: 'user', parts: [{ text: `<env>${KEY}</env>` }] }] }))
  assert.equal(gemini.split(KEY).length - 1, 1, gemini)
})
