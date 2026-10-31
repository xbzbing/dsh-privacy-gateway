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
