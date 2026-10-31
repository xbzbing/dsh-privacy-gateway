import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import zlib, { gzipSync } from 'node:zlib'

import { Agent, Dispatcher, Dispatcher1Wrapper, getGlobalDispatcher, request, setGlobalDispatcher } from 'undici'

import { defaults } from '../src/config.ts'
import { installGateway, MaskingDispatcher, withContentLength, type InstalledGateway } from '../src/dispatcher.ts'
import { PrivacyEngine, type Exchange, type RedactionEngine, type RequestInfo } from '../src/engine.ts'
import { routeStream } from '../src/providers.ts'

const OPENAI = 'sk-' + 'proj-abcdEFGH1234ijklMNOP5678qrst'
const PLACEHOLDER = /\{\{API_KEY_[a-z2-7]{8}\}\}/

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
  raw: Buffer
}

type Reply = (seen: Seen, res: ServerResponse) => unknown

/** A local origin that records each request and answers with `reply`. */
async function origin(reply: Reply) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw.toString('utf8'), raw }
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

test('a masked request asks for an unencoded reply; one compressed all the same is decoded and restored', async () => {
  let placeholder = ''
  const o = await origin((s, res) => {
    placeholder = PLACEHOLDER.exec(s.body)?.[0] ?? ''
    // an origin that compresses whatever it was asked for
    const body = gzipSync(JSON.stringify({ content: placeholder }))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length })
    res.end(body)
  })
  try {
    const warnings = await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })
      assert.deepEqual(await res.json(), { content: OPENAI })
      assert.equal(res.headers.get('content-encoding'), null)
    })
    assert.ok(placeholder)
    assert.equal(o.seen[0]?.headers['accept-encoding'], 'identity')
    assert.deepEqual(warnings, [])
  } finally {
    await o.close()
  }
})

test('a compressed event-stream reply is decoded and restored as it streams', async () => {
  let placeholder = ''
  const o = await origin((s, res) => {
    placeholder = PLACEHOLDER.exec(s.body)?.[0] ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'br' })
    const enc = zlib.createBrotliCompress()
    enc.pipe(res)
    enc.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `key ${placeholder}` } }] })}\n\n`)
    enc.flush(zlib.constants.BROTLI_OPERATION_FLUSH, () => enc.end('data: [DONE]\n\n'))
  })
  try {
    await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(`key ${OPENAI}`) })
      const text = await res.text()
      assert.ok(text.includes(`"content":"key ${OPENAI}"`), text)
      assert.ok(!text.includes(placeholder))
      assert.ok(text.endsWith('data: [DONE]\n\n'))
    })
  } finally {
    await o.close()
  }
})

test('a reply in a coding there is no decoder for goes on as it is, with a warning', async () => {
  const o = await origin((_s, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'x-unknown' })
    res.end('{"content":"{{API_KEY_abcdefgh}}"}')
  })
  try {
    const warnings = await withGateway(async () => {
      const res = await request(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })
      assert.equal(await res.body.text(), '{"content":"{{API_KEY_abcdefgh}}"}')
    })
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /x-unknown-encoded/)
  } finally {
    await o.close()
  }
})

test('an x-ndjson reply is restored line by line as it streams', async () => {
  let release!: () => void
  const firstSeen = new Promise<void>((resolve) => (release = resolve))
  let placeholder = ''
  let early = false
  const o = await origin(async (s, res) => {
    placeholder = PLACEHOLDER.exec(s.body)?.[0] ?? ''
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ message: { content: 'thinking' } })}\n`)
    // a reply held whole would never let the client see the first line: give up waiting after a while
    early = await Promise.race([firstSeen.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))])
    const line = `${JSON.stringify({ message: { content: `key ${placeholder}` } })}\n`
    const cut = line.indexOf(placeholder) + 6
    res.write(line.slice(0, cut))
    setTimeout(() => res.end(`${line.slice(cut)}${JSON.stringify({ done: true })}\n`), 20)
  })
  try {
    await withGateway(async () => {
      const res = await fetch(`${o.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(`key ${OPENAI}`) })
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        // the first line arrives before the reply ends: it is not held to the end
        if (text.includes('thinking')) release()
      }
      const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l) as { message?: { content: string } })
      assert.equal(lines.length, 3)
      assert.equal(lines[1]?.message?.content, `key ${OPENAI}`)
      assert.ok(!text.includes(placeholder))
      assert.ok(early, 'the first line came before the reply ended')
    })
  } finally {
    release()
    await o.close()
  }
})

/** A fetch to `url` with `body` sent in coding `encoding`. */
const sendEncoded = (url: string, body: Buffer, encoding: string, type = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': type, 'content-encoding': encoding }, body })

test('a compressed request body is masked and goes as plain text; one with nothing to mask goes as it came', async () => {
  const o = await emptyOrigin()
  try {
    const plain = chat(`key ${OPENAI}`)
    const zstd = (zlib as unknown as { zstdCompressSync(b: string): Buffer }).zstdCompressSync(plain)
    const quiet = gzipSync(chat('nothing secret here'))
    await withGateway(async () => {
      for (const [body, enc] of [[zstd, 'zstd'], [gzipSync(plain), 'gzip'], [zlib.deflateSync(plain), 'deflate'], [zlib.brotliCompressSync(plain), 'br'], [gzipSync(zlib.brotliCompressSync(plain)), 'br, gzip']] as const) {
        await (await sendEncoded(`${o.url}/v1/responses`, body, enc)).text()
      }
      await (await sendEncoded(`${o.url}/v1/responses`, quiet, 'gzip')).text()
    })
    for (const s of o.seen.slice(0, 5)) {
      assert.ok(!s.body.includes(OPENAI))
      assert.match(s.body, PLACEHOLDER)
      assert.equal(s.headers['content-encoding'], undefined)
      assert.equal(Number(s.headers['content-length']), s.raw.length)
    }
    const last = o.seen[5]
    assert.equal(last?.headers['content-encoding'], 'gzip')
    assert.ok(last?.raw.equals(quiet), 'nothing masked: the compressed bytes as they came')
  } finally {
    await o.close()
  }
})

test('a request body in an unknown coding, one not in the coding it names, or JSON that is not UTF-8 is not sent', async () => {
  const o = await emptyOrigin()
  try {
    const warnings = await withGateway(async () => {
      const cases: Array<[Buffer, string | undefined]> = [
        [Buffer.from(chat(OPENAI)), 'compress'],
        [Buffer.from(chat(OPENAI)), 'gzip'],
        [Buffer.concat([Buffer.from(chat(OPENAI)), Buffer.from([0xff, 0xfe])]), undefined],
      ]
      for (const [body, enc] of cases) {
        const err = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(enc ? { 'content-encoding': enc } : {}) }, body }).then(
          () => assert.fail('request was sent'),
          (e: unknown) => e as Error & { cause?: Error & { code?: string } },
        )
        assert.equal(err.cause?.code, 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
        assert.ok(!String(err.cause?.message).includes(OPENAI))
      }
    })
    assert.equal(o.seen.length, 0)
    assert.equal(warnings.length, 3)
    assert.ok(!JSON.stringify(warnings.map((w) => w.map(String))).includes(OPENAI))
  } finally {
    await o.close()
  }
})

/** A WebSocket opened with Node's own WebSocket, which goes through the global dispatcher: whether it opened. */
function openSocket(url: string): Promise<'open' | 'error'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => {
      ws.close()
      resolve('open')
    })
    ws.addEventListener('error', () => resolve('error'))
  })
}

test('a WebSocket is not opened unless the request is let by', async () => {
  let upgrades = 0
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    upgrades++
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `ws://127.0.0.1:${port}/v1/responses`
  const before = getGlobalDispatcher()
  try {
    // masked: refused before any byte goes out
    let warnings: unknown[] = []
    let gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, logger: { warn: (...a: unknown[]) => warnings.push(a) } })
    assert.equal(await openSocket(url), 'error')
    assert.equal(upgrades, 0)
    assert.equal(warnings.length, 1)
    gateway.dispose()
    setGlobalDispatcher(before)
    // an explicit bypass (skip: enabled off, an excluded provider, a session with masking off) opens it
    warnings = []
    gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, skip: () => true })
    assert.equal(await openSocket(url), 'open')
    assert.equal(upgrades, 1)
    gateway.dispose()
    setGlobalDispatcher(before)
    // so does excludeHosts
    gateway = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, excludeHosts: [`127.0.0.1:${port}`] })
    assert.equal(await openSocket(url), 'open')
    assert.equal(upgrades, 2)
    gateway.dispose()
  } finally {
    setGlobalDispatcher(before)
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
    await until(() => getGlobalDispatcher() === gateway.dispatcher)
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

// ---- review regressions -----------------------------------------------------------

/** An origin that answers every request with an empty JSON object. */
const emptyOrigin = () => origin((_s, res) => res.end('{}'))

/** Waits until `cond` holds, failing after `ms`. */
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('Dispatcher1Wrapper.wrapHandler is there: the gateway adapts legacy handlers (fetch, upgrades) with it', () => {
  assert.equal(typeof (Dispatcher1Wrapper as unknown as { wrapHandler?: unknown }).wrapHandler, 'function')
})

test('withContentLength gives flat pairs for every header form, so undici reads iterable headers', async () => {
  const flat = withContentLength(new Map([['content-type', 'application/json'], ['content-length', '1']]) as never, 7)
  assert.deepEqual(flat, ['content-type', 'application/json', 'content-length', '7'])
  assert.deepEqual(withContentLength([['Content-Length', '1'], ['x', 'y']] as never, 3), ['Content-Length', '3', 'x', 'y'])
  assert.deepEqual(withContentLength({ 'content-length': '1', a: ['b', 'c'] }, 2), ['content-length', '2', 'a', ['b', 'c']])
  const same = { a: 'b' }
  assert.equal(withContentLength(same, 2), same, 'no content-length: the headers as they were')

  const o = await emptyOrigin()
  try {
    await withGateway(async () => {
      const body = chat(`key ${OPENAI}`)
      const headers = new Map([['content-type', 'application/json'], ['content-length', String(Buffer.byteLength(body))]])
      const res = await request(`${o.url}/v1/chat/completions`, { method: 'POST', headers: headers as never, body })
      await res.body.text()
      assert.equal(res.statusCode, 200)
    })
    assert.ok(!o.seen[0]?.body.includes(OPENAI))
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
    assert.equal(Number(o.seen[0]?.headers['content-length']), Buffer.byteLength(o.seen[0]?.body ?? ''))
  } finally {
    await o.close()
  }
})

/** An engine that records the info of each request and masks nothing. */
function spyEngine(infos: RequestInfo[]): RedactionEngine {
  return {
    maskRequest(_body, info) {
      infos.push(info)
      return null
    },
  }
}

test('an empty session header does not hide the session the stream names', async () => {
  const o = await emptyOrigin()
  const infos: RequestInfo[] = []
  try {
    await withGateway(async () => {
      async function* adapter() {
        const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', session_id: '' }, body: chat('hi') })
        yield await res.text()
      }
      for await (const _ of routeStream('openai', [], adapter, 'sess-ctx')) void _
    }, spyEngine(infos))
    assert.equal(infos[0]?.session, 'sess-ctx')
  } finally {
    await o.close()
  }
})

test('masking that fails, even past maskRequest, is never sent and nothing reported quotes the body', async () => {
  const o = await emptyOrigin()
  const throwing: RedactionEngine = {
    maskRequest() {
      throw new Error(`cannot mask ${OPENAI}`)
    },
  }
  // an exchange that fails when its text is read: the failure comes after maskRequest returned
  const late: RedactionEngine = {
    maskRequest() {
      return {
        get text(): string {
          throw new TypeError(`late ${OPENAI}`)
        },
        restoring: () => false,
        restoreBody: (t) => t,
        streamRestorer: () => ({ push: (c) => String(c), end: () => '' }),
        finish() {},
      } as Exchange
    },
  }
  const rejections: unknown[] = []
  const onRejection = (e: unknown) => rejections.push(e)
  process.on('unhandledRejection', onRejection)
  try {
    for (const engine of [throwing, late]) {
      const warnings = await withGateway(async () => {
        const err = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) }).then(
          () => assert.fail('request was sent'),
          (e: unknown) => e as Error & { cause?: Error & { code?: string; cause?: unknown } },
        )
        assert.equal(err.cause?.code, 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
        assert.equal(err.cause?.cause, undefined, 'the engine error is not passed on')
        assert.ok(!String(err.cause?.message).includes(OPENAI))
        assert.ok(!String(err.cause?.stack).includes(OPENAI))
      }, engine)
      assert.equal(warnings.length, 1)
      assert.ok(!JSON.stringify(warnings.map((w) => w.map(String))).includes(OPENAI), 'no log line quotes the value')
    }
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(rejections, [])
    assert.equal(o.seen.length, 0)
  } finally {
    process.off('unhandledRejection', onRejection)
    await o.close()
  }
})

test('a JSON reply that cannot be restored goes on as it came, with one warning that has no value', async () => {
  const o = await origin((_s, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"content":"{{API_KEY_abcdefgh}}"}')
  })
  const failing: RedactionEngine = {
    maskRequest(body) {
      return {
        text: body.replace(OPENAI, '{{API_KEY_abcdefgh}}'),
        restoring: () => true,
        restoreBody: () => {
          throw new Error(`restore ${OPENAI}`)
        },
        streamRestorer: () => ({ push: (c) => String(c), end: () => '' }),
        finish() {},
      } as Exchange
    },
  }
  try {
    const warnings = await withGateway(async () => {
      const res = await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })
      assert.equal(await res.text(), '{"content":"{{API_KEY_abcdefgh}}"}')
    }, failing)
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0]?.[0]), /could not be restored/)
    assert.ok(!JSON.stringify(warnings.map((w) => w.map(String))).includes(OPENAI))
  } finally {
    await o.close()
  }
})

test('a request whose body fails while it is read is not sent (docs/adr/0005)', async () => {
  const o = await emptyOrigin()
  try {
    await withGateway(async () => {
      async function* body() {
        yield Buffer.from(chat(OPENAI).slice(0, 20))
        throw new Error('caller went away')
      }
      await assert.rejects(request(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Readable.from(body()) }), /caller went away/)
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(o.seen.length, 0)
  } finally {
    await o.close()
  }
})

test('a streamed request body is read whole and masked, a value split across its chunks too', async () => {
  const o = await emptyOrigin()
  try {
    await withGateway(async () => {
      const text = chat(`key ${OPENAI}`)
      const cut = text.indexOf(OPENAI) + 10
      async function* body() {
        yield Buffer.from(text.slice(0, cut))
        await new Promise((r) => setTimeout(r, 1))
        yield text.slice(cut)
      }
      const res = await request(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Readable.from(body()) })
      await res.body.text()
    })
    assert.ok(!o.seen[0]?.body.includes(OPENAI))
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
  } finally {
    await o.close()
  }
})

test('dispose hands the global slot to a proxy layer, never to a route layer, and the gateway passes through from then on', async () => {
  const o = await emptyOrigin()
  const before = getGlobalDispatcher()
  const proxy = new CountingAgent()
  try {
    // a route layer chained, nothing on top: the dispatcher it was installed on is global again
    let g = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0 })
    g.dispatcher.chainTo(new RouteLayer(g.dispatcher))
    g.dispose()
    assert.equal(getGlobalDispatcher(), before)
    // a proxy found on top and adopted: it stays global
    g = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, logger: { warn() {} } })
    g.dispatcher.chainTo(new RouteLayer(g.dispatcher))
    setGlobalDispatcher(proxy)
    g.check()
    const held = g.dispatcher.compose((dispatch) => dispatch) // a layer that holds the gateway
    g.dispose()
    assert.equal(getGlobalDispatcher(), proxy)
    assert.equal(g.dispatcher.bypass, true)
    await new Promise<void>((resolve, reject) => {
      held.dispatch(
        { origin: o.url, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) },
        { onRequestStart() {}, onResponseStart() {}, onResponseData() {}, onResponseEnd: () => resolve(), onResponseError: (_c, e) => reject(e) },
      )
    })
    assert.equal(o.seen[0]?.body, chat(OPENAI), 'a disposed gateway masks nothing')
  } finally {
    setGlobalDispatcher(before)
    await proxy.close()
    await o.close()
  }
})

test('a new gateway goes on top of what a disposed one handed back, so reloads do not stack gateways', async () => {
  const o = await emptyOrigin()
  const before = getGlobalDispatcher()
  try {
    const g1 = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0 })
    const top = g1.dispatcher.compose((dispatch) => dispatch)
    setGlobalDispatcher(top)
    g1.dispose()
    // the dispatcher on top goes away and puts back the one it was installed on: the disposed gateway
    setGlobalDispatcher(g1.dispatcher)
    const g2 = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0, logger: { warn() {} } })
    assert.deepEqual(g2.dispatcher.downstreams().map((l) => l.dispatcher), [before])
    // one found on top later is unwrapped the same way
    setGlobalDispatcher(g1.dispatcher)
    g2.check()
    assert.deepEqual(g2.dispatcher.downstreams().map((l) => l.dispatcher), [before])
    await (await fetch(`${o.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chat(OPENAI) })).text()
    assert.match(o.seen[0]?.body ?? '', PLACEHOLDER)
    g2.dispose()
    assert.equal(getGlobalDispatcher(), before)
  } finally {
    setGlobalDispatcher(before)
    await o.close()
  }
})
