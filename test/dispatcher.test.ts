import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway, MaskingDispatcher, type InstalledGateway } from '../src/dispatcher.ts'
import { PrivacyEngine, type RedactionEngine } from '../src/engine.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const PLACEHOLDER = /\{\{API_KEY_[a-z2-7]{8}\}\}/

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

type Reply = (seen: Seen, res: ServerResponse) => unknown

/** A local origin that records each request and answers with `reply`. */
async function origin(reply: Reply) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      void reply(s, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Installs a gateway around `run`, then puts the global dispatcher back exactly as it was. */
async function withGateway(run: (g: InstalledGateway) => Promise<void>, engine: RedactionEngine = new PrivacyEngine(randomBytes(32), defaults), excludeHosts: string[] = []) {
  const before = getGlobalDispatcher()
  const warnings: unknown[][] = []
  const gateway = installGateway(engine, { checkIntervalMs: 0, excludeHosts, logger: { warn: (...a: unknown[]) => warnings.push(a) } })
  try {
    await run(gateway)
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
  }
  return warnings
}

const chat = (content: string) => JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }] })

test("Node's built-in fetch goes through the gateway: body masked, headers untouched, JSON reply restored", async () => {
  const o = await origin((s, res) => {
    const echoed = (JSON.parse(s.body) as { messages: Array<{ content: string }> }).messages[0]?.content ?? ''
    const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: `you said: ${echoed}` } }] })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  try {
    await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-token', 'x-opencode-session': 's1' },
        body: chat(`my key is ${OPENAI}`),
      })
      const reply = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      assert.equal(reply.choices[0]?.message.content, `you said: my key is ${OPENAI}`)
    })
    const s = o.seen[0]
    assert.ok(s)
    assert.ok(!s.body.includes(OPENAI))
    assert.match(s.body, PLACEHOLDER)
    assert.equal(s.headers.authorization, 'Bearer upstream-token')
    assert.equal(s.headers['x-opencode-session'], 's1')
    assert.equal(Number(s.headers['content-length']), Buffer.byteLength(s.body))
  } finally {
    await o.close()
  }
})

test('an event-stream reply is restored line by line while it streams', async () => {
  let release!: () => void
  const firstSeen = new Promise<void>((resolve) => (release = resolve))
  let placeholder = ''
  const o = await origin(async (s, res) => {
    placeholder = PLACEHOLDER.exec(s.body)?.[0] ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'thinking' } }] })}\n\n`)
    await firstSeen
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: `key ${placeholder}` } }] })}\n\n`
    const cut = event.indexOf(placeholder) + 6 // split inside the placeholder
    res.write(`: keep-alive\n\n${event.slice(0, cut)}`)
    setTimeout(() => res.end(`${event.slice(cut)}data: [DONE]\n\n`), 20)
  })
  try {
    await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(`key ${OPENAI}`) })
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.includes('thinking')) release()
      }
      assert.ok(placeholder)
      assert.ok(text.includes(`"content":"key ${OPENAI}"`), text)
      assert.ok(text.includes(': keep-alive\n'))
      assert.ok(text.endsWith('data: [DONE]\n\n'))
      assert.ok(!text.includes(placeholder))
    })
  } finally {
    release()
    await o.close()
  }
})

test('requests that are not model requests pass byte for byte', async () => {
  const o = await origin((_s, res) => res.end('ok'))
  try {
    await withGateway(async () => {
      await (await fetch(`${o.url}/search?q=${OPENAI}`)).text()
      await (await fetch(`${o.url}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x', key: OPENAI }) })).text()
      await (await fetch(`${o.url}/upload`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: chat(OPENAI) })).text()
    })
    assert.equal(o.seen[0]?.url, `/search?q=${OPENAI}`)
    assert.equal(o.seen[1]?.body, JSON.stringify({ input: 'x', key: OPENAI }), '`input` that is not an array is no model request')
    assert.equal(o.seen[2]?.body, chat(OPENAI), 'a non-JSON content type is not read')
  } finally {
    await o.close()
  }
})

test('excludeHosts are never rewritten', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  try {
    const host = new URL(o.url).host
    await withGateway(async () => {
      await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
    }, undefined, [host])
    assert.equal(o.seen[0]?.body, chat(OPENAI))
  } finally {
    await o.close()
  }
})

test('masking that throws fails the request and the origin never sees it (fail-closed)', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  const broken: RedactionEngine = {
    maskRequest() {
      throw new Error('boom')
    },
  }
  try {
    const warnings = await withGateway(async () => {
      const err = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) }).then(
        () => assert.fail('request was sent'),
        (e: unknown) => e as Error & { cause?: { code?: string; message?: string } },
      )
      assert.equal(err.cause?.code, 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
      assert.match(err.cause?.message ?? '', /request not sent/)
    }, broken)
    assert.equal(o.seen.length, 0)
    assert.equal(warnings.length, 1)
  } finally {
    await o.close()
  }
})

test('a compressed reply goes on as it is, with a warning', async () => {
  let placeholder = ''
  const o = await origin((s, res) => {
    placeholder = PLACEHOLDER.exec(s.body)?.[0] ?? ''
    const body = gzipSync(JSON.stringify({ content: placeholder }))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length })
    res.end(body)
  })
  try {
    const warnings = await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })
      assert.deepEqual(await res.json(), { content: placeholder })
    })
    assert.equal(warnings.length, 1)
  } finally {
    await o.close()
  }
})

class CountingAgent extends Agent {
  count = 0
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.count++
    return super.dispatch(opts, handler)
  }
}

test('a dispatcher installed over the gateway is chained downstream by check()', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  const proxy = new CountingAgent()
  try {
    await withGateway(async (g) => {
      setGlobalDispatcher(proxy) // dsh-http-proxy installing after us
      assert.equal(g.check(), true)
      assert.equal(getGlobalDispatcher(), g.dispatcher)
      assert.equal(g.check(), false)
      await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
      assert.equal(proxy.count, 1, 'the request went on through the new dispatcher')
    })
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
  } finally {
    await proxy.close()
    await o.close()
  }
})

test('a dispatcher composed from the gateway does not loop', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  try {
    await withGateway(async (g) => {
      let seen = 0
      const composed = g.dispatcher.compose((dispatch) => (opts, handler) => {
        seen++
        return dispatch(opts, handler)
      })
      setGlobalDispatcher(composed)
      g.check()
      await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
      assert.equal(seen, 1)
    })
    assert.equal(o.seen.length, 1)
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
  } finally {
    await o.close()
  }
})

test('dispose with another dispatcher on top leaves the gateway passing everything through', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  const before = getGlobalDispatcher()
  const gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0 })
  const top = gateway.dispatcher.compose((dispatch) => dispatch)
  try {
    setGlobalDispatcher(top)
    gateway.dispose()
    assert.ok(gateway.dispatcher instanceof MaskingDispatcher && gateway.dispatcher.bypass)
    await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
    assert.equal(o.seen[0]?.body, chat(OPENAI))
  } finally {
    setGlobalDispatcher(before)
    await o.close()
  }
})

/** A route layer as oc2dsh's pool would be: it sends each request on to the layer the gateway has after it. */
class RouteLayer extends Dispatcher {
  count = 0
  closed = false
  readonly gateway: MaskingDispatcher
  constructor(gateway: MaskingDispatcher) {
    super()
    this.gateway = gateway
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.count++
    const next = this.gateway.below(this)
    if (!next) throw new Error('no layer after the route layer')
    return next.dispatch(opts, handler)
  }
  override close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
  override destroy(): Promise<void> {
    return this.close()
  }
}

test('layers go by role: route layers before proxy layers, whichever was installed first', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  const proxy = new CountingAgent()
  try {
    await withGateway(async (g) => {
      const base = g.dispatcher.downstream()
      const route = new RouteLayer(g.dispatcher)
      g.dispatcher.chainTo(route) // oc2dsh joins: a route layer by default
      setGlobalDispatcher(proxy) // dsh-http-proxy installs after it
      g.check()
      assert.equal(g.dispatcher.downstream(), route, 'the route layer is still the next hop')
      assert.equal(g.dispatcher.below(route), proxy, 'and the proxy is the one after it')
      assert.deepEqual(g.dispatcher.downstreams().map((l) => [l.dispatcher, l.role]), [[route, 'route'], [proxy, 'proxy'], [base, 'proxy']])
      await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
      assert.equal(route.count, 1)
      assert.equal(proxy.count, 1, 'the user’s proxy policy still applies')
      // a third plugin replacing the slot goes in as a proxy layer: the route layer keeps its place
      const third = new CountingAgent()
      setGlobalDispatcher(third)
      g.check()
      assert.equal(g.dispatcher.downstream(), route)
      assert.equal(g.dispatcher.below(route), third)
      await third.close()
    })
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
  } finally {
    await proxy.close()
    await o.close()
  }
})

test('chaining a layer again puts it first in its role; release takes it out; a closed one is skipped', async () => {
  await withGateway(async (g) => {
    const base = g.dispatcher.downstream()
    const a = new RouteLayer(g.dispatcher)
    const b = new RouteLayer(g.dispatcher)
    g.dispatcher.chainTo(a)
    g.dispatcher.chainTo(b)
    assert.equal(g.dispatcher.downstream(), b)
    g.dispatcher.chainTo(a)
    assert.equal(g.dispatcher.downstream(), a)
    g.dispatcher.chainTo(a, { role: 'proxy' })
    assert.equal(g.dispatcher.downstream(), b)
    assert.equal(g.dispatcher.below(b), a)
    await b.close()
    assert.equal(g.dispatcher.downstream(), a)
    assert.equal(g.dispatcher.release(b), true)
    assert.equal(g.dispatcher.release(b), false)
    assert.equal(g.dispatcher.release(a), true)
    assert.deepEqual(g.dispatcher.downstreams().map((l) => l.dispatcher), [base])
    assert.equal(g.dispatcher.release(base), false, 'the last layer stays')
    assert.equal(g.dispatcher.below(base), undefined)
  })
})

test('a gateway replaced by a dispatcher that sends it nothing is back on top within the check interval', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  const before = getGlobalDispatcher()
  const gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 20, logger: { warn() {} } })
  const other = new CountingAgent()
  try {
    setGlobalDispatcher(other)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(getGlobalDispatcher(), gateway.dispatcher)
    await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
    assert.equal(other.count, 1)
  } finally {
    gateway.dispose()
    setGlobalDispatcher(before)
    await other.close()
    await o.close()
  }
})

test('a request through a layer put on top of the gateway puts the gateway back on top', async () => {
  const o = await origin((_s, res) => res.end('{}'))
  try {
    await withGateway(async (g) => {
      setGlobalDispatcher(g.dispatcher.compose((dispatch) => dispatch))
      await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
      assert.equal(getGlobalDispatcher(), g.dispatcher)
    })
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
  } finally {
    await o.close()
  }
})
