import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { defaults } from '../src/config.ts'
import { PrivacyEngine } from '../src/engine.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const PLACEHOLDER = /\{\{API_KEY_[a-z2-7]{8}\}\}/

test('a Gemini request is masked in contents; its env block and tool declarations go byte for byte', () => {
  const env = `<env>\n  token: ${OPENAI}\n</env>`
  const tools = `[{"functionDeclarations":[{"name":"run","description":"uses ${OPENAI}","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}]}]`
  const body =
    `{"contents":[{"role":"user","parts":[{"text":"key ${OPENAI}"}]},` +
    `{"role":"model","parts":[{"functionCall":{"name":"run","args":{"cmd":"echo ${OPENAI}"}}}]}],` +
    `"systemInstruction":{"parts":[{"text":${JSON.stringify(`sys ${env} after ${OPENAI}`)}}]},` +
    `"tools":${tools},"generationConfig":{"temperature":0}}`
  const engine = new PrivacyEngine(randomBytes(32), defaults)
  const ex = engine.maskRequest(body, { host: 'generativelanguage.googleapis.com', path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent' })
  assert.ok(ex, 'a contents request is a model request')
  const doc = JSON.parse(ex.text) as {
    contents: Array<{ parts: Array<{ text?: string; functionCall?: { args: { cmd: string } } }> }>
    systemInstruction: { parts: Array<{ text: string }> }
  }
  assert.match(doc.contents[0]?.parts[0]?.text ?? '', PLACEHOLDER)
  assert.ok(!(doc.contents[0]?.parts[0]?.text ?? '').includes(OPENAI))
  assert.match(doc.contents[1]?.parts[0]?.functionCall?.args.cmd ?? '', PLACEHOLDER)
  const sys = doc.systemInstruction.parts[0]?.text ?? ''
  assert.ok(sys.includes(env), 'the env block of systemInstruction goes as it was')
  assert.match(sys.slice(sys.indexOf('</env>')), PLACEHOLDER, 'the text after it is masked')
  assert.ok(ex.text.includes(`"tools":${tools}`), 'tools[].functionDeclarations go byte for byte')
  ex.finish()
})
