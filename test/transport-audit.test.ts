import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, Dispatcher, FormData, getGlobalDispatcher, interceptors, request, setGlobalDispatcher } from 'undici'
import { defaults, resolveConfig } from '../src/config.ts'
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import type { Exchange, RedactionEngine } from '../src/engine.ts'
import { installGateway, MaskingDispatcher } from '../src/dispatcher.ts'
import { ReplyDecoder } from '../src/transport/decoder.ts'
import { PrivacyEngine } from '../src/engine.ts'
import { RecordStore } from '../src/records.ts'

const SECRET = 'sk-' + 'proj-REPROrepro0123456789abcdef'
const chat = JSON.stringify({ messages: [{ role: 'user', content: SECRET }] })

async function localOrigin() {
  const seen: Buffer[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => { seen.push(Buffer.concat(chunks)); res.end('{}') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('R9: release cannot remove the last proxy and repeated disposal safely restores the real global dispatcher', () => {
  const before = getGlobalDispatcher()
  const installed = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0 })
  const base = installed.dispatcher.downstream()
  const route = new Agent()
  try {
    installed.dispatcher.chainTo(route)
    assert.equal(installed.dispatcher.release(base), false, 'the only proxy remains as fallback')
    assert.equal(installed.dispatcher.handback(), before)
    installed.dispose()
    installed.dispose()
    assert.equal(getGlobalDispatcher(), before)
    assert.equal(installed.dispatcher.bypass, true)
    assert.equal(installed.check(), false, 'a disposed gateway cannot reinstall itself')
    assert.equal(getGlobalDispatcher(), before)
  } finally { installed.dispose(); setGlobalDispatcher(before); void route.close() }
})

test('R9: a failed handback keeps protection enabled and disposal remains retryable', () => {
  const before = getGlobalDispatcher()
  const installed = installGateway(new PrivacyEngine(randomBytes(32), defaults), { checkIntervalMs: 0 })
  const handback = installed.dispatcher.handback.bind(installed.dispatcher)
  let attempts = 0
  installed.dispatcher.handback = () => { if (++attempts === 1) throw new Error('synthetic handback failure'); return handback() }
  try {
    assert.throws(() => installed.dispose(), /synthetic handback failure/)
    assert.equal(getGlobalDispatcher(), installed.dispatcher)
    assert.equal(installed.dispatcher.bypass, false, 'failed cleanup does not leave an unprotected global gateway')
    installed.dispose()
    assert.equal(getGlobalDispatcher(), before)
    assert.equal(installed.dispatcher.bypass, true)
  } finally { installed.dispose(); setGlobalDispatcher(before) }
})

test('R9: role changes and closed proxies retain an installation fallback', async () => {
  const base = new Agent()
  const proxy = new Agent()
  const gateway = new MaskingDispatcher(base, new PrivacyEngine(randomBytes(32), defaults))
  try {
    gateway.chainTo(base, { role: 'route' })
    assert.equal(gateway.handback(), base)
    gateway.adopt(proxy)
    await proxy.close()
    assert.equal(gateway.handback(), base)
    assert.equal(gateway.release(base), false)
  } finally { await base.close(); if (!proxy.destroyed) await proxy.close() }
})

for (const type of ['application/json', 'text/event-stream', 'application/x-ndjson', 'text/plain']) {
  for (const terminal of ['end', 'error'] as const) {
    test(`finish exceptions cannot swallow ${type} ${terminal} terminal callbacks`, async () => {
      let finishes = 0
      let ends = 0
      let errors = 0
      const warnings: string[] = []
      const engine: RedactionEngine = { maskRequest: (text) => ({ text, restoring: () => true, restoreBody: (body) => body, streamRestorer: () => ({ push: (b) => b.toString(), end: () => '' }), finish() { finishes++; throw new Error(`record failed ${SECRET}`) } } as Exchange) }
      class Reply extends Dispatcher {
        override dispatch(_opts: Dispatcher.DispatchOptions, h: Dispatcher.DispatchHandler): boolean {
          const c: Dispatcher.DispatchController = { aborted: false, paused: false, reason: null, pause() {}, resume() {}, abort() {} }
          try {
            h.onRequestStart?.(c, null)
            h.onResponseStart?.(c, 200, { 'content-type': type })
            h.onResponseData?.(c, Buffer.from('{"a":1}\n'))
            if (terminal === 'end') h.onResponseEnd?.(c, {})
            else h.onResponseError?.(c, new Error('wire failure'))
          } catch { /* A wire handler may throw before the fixture can deliver another callback. */ }
          return true
        }
      }
      const gateway = new MaskingDispatcher(new Reply(), engine, { logger: { warn(...args) { warnings.push(args.join(' ')); throw new Error('logger failure') } } })
      gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', body: chat }, { onRequestStart() {}, onResponseData() {}, onResponseEnd() { ends++ }, onResponseError() { errors++ } })
      await delay(10)
      assert.equal(ends, terminal === 'end' ? 1 : 0)
      assert.equal(errors, terminal === 'error' ? 1 : 0)
      assert.equal(finishes, 1)
      assert.ok(!warnings.join('\n').includes(SECRET), 'observability exceptions never quote their messages')
    })
  }
}

test('finish failures do not prevent an interception failure from rejecting without dispatch', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  let finishes = 0
  const warnings: string[] = []
  const engine: RedactionEngine = { maskRequest() { return {
    get text(): string { throw new Error(`masking failed ${SECRET}`) }, restoring: () => true,
    restoreBody: (b) => b, streamRestorer: () => ({ push: () => '', end: () => '' }),
    finish() { finishes++; throw new Error(`record failed ${SECRET}`) },
  } as Exchange } }
  const gateway = new MaskingDispatcher(agent, engine, { logger: { warn(...args) { warnings.push(args.join(' ')) } } })
  try {
    await assert.rejects(request(origin.url, { dispatcher: gateway, method: 'POST', body: chat }), (err: Error & { code?: string }) => err.code === 'DSH_PRIVACY_GATEWAY_FAIL_CLOSED')
    assert.equal(finishes, 1)
    assert.equal(origin.seen.length, 0)
    assert.ok(!warnings.join('\n').includes(SECRET))
  } finally { await agent.close(); await origin.close() }
})

test('real record key exhaustion does not swallow the second loopback response terminal event', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  let exhausted = false
  const records = new RecordStore({ keepDays: 30, keepBytes: 1000000, keepRecords: 100, now: () => exhausted ? new Date(Math.ceil(Number.MAX_SAFE_INTEGER / 1000)) : new Date() })
  const warnings: string[] = []
  const engine = new PrivacyEngine(randomBytes(32), defaults, { records })
  const gateway = new MaskingDispatcher(agent, engine, { logger: { warn(...args) { warnings.push(args.join(' ')) } } })
  try {
    const first = await request(origin.url, { dispatcher: gateway, method: 'POST', body: chat })
    assert.equal(await first.body.text(), '{}')
    assert.equal(records.recent().length, 1)
    exhausted = true
    const second = await request(origin.url, { dispatcher: gateway, method: 'POST', body: chat })
    assert.equal(await Promise.race([second.body.text(), delay(1000).then(() => assert.fail('record failure swallowed response end'))]), '{}')
    assert.equal(origin.seen.length, 2)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /exchange recording failed \(Error\)/)
    assert.ok(!warnings.join('\n').includes(SECRET))
  } finally { await agent.destroy(); await records.close(); await origin.close() }
})

test('R8: stacked decoder propagates write false/drain while preserving bytes and ending once', async () => {
  const plain = randomBytes(200000)
  const encoded = gzipSync(brotliCompressSync(plain))
  const output: Buffer[] = []
  let drains = 0
  let ends = 0
  let finish!: () => void
  const completed = new Promise<void>((resolve) => { finish = resolve })
  const decoder = ReplyDecoder.for(['br', 'gzip'], (chunk) => output.push(chunk), () => { ends++; finish() }, (err) => { throw err }, () => false, () => { drains++; decoder?.end() })
  assert.ok(decoder)
  assert.equal(decoder.write(encoded), false, 'large encoded input triggers writable backpressure')
  await Promise.race([completed, delay(2000).then(() => assert.fail('drain did not resume the decoder'))])
  assert.ok(drains > 0)
  assert.equal(ends, 1)
  assert.deepEqual(Buffer.concat(output), plain)
  decoder.destroy()
})

test('R8: decoder input backpressure pauses the wire controller and drain resumes it', async () => {
  const plain = JSON.stringify({ data: randomBytes(100000).toString('hex') })
  const encoded = gzipSync(plain)
  let pauses = 0
  let resumes = 0
  let wireEnded = false
  let finish!: () => void
  const completed = new Promise<void>((resolve) => { finish = resolve })
  class BackpressuredWire extends Dispatcher {
    override dispatch(_opts: Dispatcher.DispatchOptions, h: Dispatcher.DispatchHandler): boolean {
      const c: Dispatcher.DispatchController = {
        aborted: false, paused: false, reason: null,
        pause() { pauses++ },
        resume() { resumes++; if (!wireEnded) { wireEnded = true; h.onResponseEnd?.(c, {}) } },
        abort() {},
      }
      h.onRequestStart?.(c, null)
      h.onResponseStart?.(c, 200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      h.onResponseData?.(c, encoded)
      return true
    }
  }
  const engine: RedactionEngine = { maskRequest: (text) => ({ text, restoring: () => true, restoreBody: (b) => b, streamRestorer: () => ({ push: () => '', end: () => '' }), finish() {} } as Exchange) }
  const gateway = new MaskingDispatcher(new BackpressuredWire(), engine)
  let out = ''
  gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', body: chat }, {
    onRequestStart() {}, onResponseData(_c, b) { out += b.toString() }, onResponseEnd() { finish() }, onResponseError(_c, err) { throw err },
  })
  await Promise.race([completed, delay(2000).then(() => assert.fail('wire never resumed'))])
  assert.ok(pauses > 0)
  assert.ok(resumes > 0)
  assert.equal(wireEnded, true)
  assert.equal(out, plain)
})

const expansion = Buffer.from(Array.from({ length: 4000 }, (_, i) => `data: {"content":"${i} ${'x'.repeat(200)}"}\n\n`).join(''))

for (const encoding of ['gzip', 'br'] as const) {
  for (const action of ['pause', 'abort'] as const) {
    test(`R8: loopback ${encoding} SSE ${action} on first decoded output stops delivery after HTTP input end`, async () => {
      const encoded = encoding === 'gzip' ? gzipSync(expansion) : brotliCompressSync(expansion, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
      if (encoding === 'gzip') { assert.equal(encoded.length, 12442); assert.equal(expansion.length, 906890) }
      const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': encoding, 'content-length': encoded.length }); res.end(encoded) })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const agent = new Agent()
      let inputEnded = false
      const observed = agent.compose((dispatch) => (opts, handler) => dispatch(opts, {
        onRequestStart: (c, context) => handler.onRequestStart?.(c, context),
        onResponseStart: (c, status, headers, message) => handler.onResponseStart?.(c, status, headers, message),
        onResponseData: (c, chunk) => handler.onResponseData?.(c, chunk),
        onResponseEnd: (c, trailers) => { inputEnded = true; handler.onResponseEnd?.(c, trailers) },
        onResponseError: (c, err) => handler.onResponseError?.(c, err),
      }))
      const engine = new PrivacyEngine(randomBytes(32), resolveConfig({ ...defaults, restoreLog: true }))
      const gateway = new MaskingDispatcher(observed, engine)
      let control: Dispatcher.DispatchController | undefined
      let chunks = 0
      let ended = 0
      let errors = 0
      const output: Buffer[] = []
      let first!: () => void
      let finish!: () => void
      const started = new Promise<void>((resolve) => { first = resolve })
      const completed = new Promise<void>((resolve) => { finish = resolve })
      try {
        gateway.dispatch({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, path: '/', method: 'POST', headers: { 'content-type': 'application/json' }, body: chat }, {
          onRequestStart(c) { control = c },
          onResponseData(c, b) {
            assert.equal(c.paused, false); assert.equal(c.aborted, false)
            chunks++; output.push(b)
            if (chunks === 1) { if (action === 'pause') c.pause(); else c.abort(new Error('synthetic abort')); first() }
          },
          onResponseEnd(c) { assert.equal(c.paused, false); ended++; finish() },
          onResponseError() { errors++; finish() },
        })
        await Promise.race([started, delay(2000).then(() => assert.fail('no decoded output'))])
        await delay(40)
        assert.equal(inputEnded, true, 'the raw HTTP response completed before pending decoded output')
        assert.equal(chunks, 1, 'no decoded output after pause/abort')
        assert.equal(ended, 0, 'no normal end while paused or aborted')
        if (action === 'pause') {
          assert.equal(errors, 0)
          control?.resume()
          await Promise.race([completed, delay(2000).then(() => assert.fail('no completion after resume'))])
          assert.deepEqual(Buffer.concat(output), expansion, 'resume loses no bytes')
          assert.equal(ended, 1)
        } else { assert.equal(errors, 1); control?.resume(); await delay(10); assert.equal(chunks, 1) }
      } finally { control?.abort(new Error('cleanup')); await agent.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
    })
  }
}

for (const type of ['application/json', 'application/x-ndjson', 'text/event-stream']) {
  for (const encoding of ['', 'gzip', 'br']) {
    test(`R8: ${type} ${encoding || 'plain'} final output pause/abort has one terminal outcome`, async () => {
      let finishes = 0
      const identity: RedactionEngine = { maskRequest: (text) => ({ text, restoring: () => true, restoreBody: (b) => b, streamRestorer: () => ({ push: (b) => b.toString(), end: () => 'tail' }), finish: () => { finishes++ } } as Exchange) }
      const raw = Buffer.from(type === 'text/event-stream' ? 'data: {"a":1}\n\n' : '{"a":1}\n')
      const encoded = encoding === 'gzip' ? gzipSync(raw) : encoding === 'br' ? brotliCompressSync(raw) : raw
      for (const action of ['pause', 'abort'] as const) {
        let ended = 0
        let errors = 0
        let chunks = 0
        let control: Dispatcher.DispatchController | undefined
        class Immediate extends Dispatcher {
          override dispatch(_o: Dispatcher.DispatchOptions, h: Dispatcher.DispatchHandler): boolean {
            const c = { aborted: false, paused: false, reason: null, pause() { this.paused = true }, resume() { this.paused = false }, abort() { this.aborted = true } }
            h.onRequestStart?.(c, null)
            h.onResponseStart?.(c, 200, { 'content-type': type, 'content-encoding': encoding })
            h.onResponseData?.(c, encoded)
            h.onResponseEnd?.(c, {})
            return true
          }
        }
        const gateway = new MaskingDispatcher(new Immediate(), identity)
        gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', body: chat }, {
          onRequestStart(c) { control = c }, onResponseData(c) { chunks++; if (chunks === 1) { if (action === 'pause') c.pause(); else c.abort(new Error('stop')) } },
          onResponseEnd() { ended++ }, onResponseError() { errors++ },
        })
        await delay(20)
        assert.equal(ended, 0)
        assert.equal(chunks, 1)
        if (action === 'pause') { control?.resume(); await delay(20); assert.equal(ended, 1); assert.equal(errors, 0) }
        else { assert.equal(errors, 1); control?.resume(); await delay(5); assert.equal(ended, 0); assert.equal(chunks, 1) }
      }
      assert.equal(finishes, 2)
    })
  }
}

test('R7: real undici redirect history survives the early stable context for request and legacy handlers', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => { if (req.url === '/a') { res.writeHead(307, { location: '/b' }); res.end() } else res.end('{}') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const agent = new Agent()
  const redirected = agent.compose(interceptors.redirect({ maxRedirections: 3 }))
  const gateway = new MaskingDispatcher(redirected, { maskRequest: () => null })
  try {
    const direct = await request(`${origin}/a`, { dispatcher: redirected, method: 'POST', body: chat })
    await direct.body.text()
    const res = await request(`${origin}/a`, { dispatcher: gateway, method: 'POST', body: chat })
    await res.body.text()
    const history = (context: object | null) => (context as { history?: URL[] } | null)?.history?.map(String)
    assert.deepEqual(history(direct.context), [`${origin}/a`, `${origin}/b`])
    assert.deepEqual(history(res.context), history(direct.context), 'redirect executes and its history remains observable')
    let starts = 0
    let context: { history?: URL[] } | undefined
    await new Promise<void>((resolve, reject) => {
      gateway.dispatch({ origin, path: '/a', method: 'POST', body: chat }, {
        onConnect(_abort: (reason: Error) => void, value: { history?: URL[] }) { starts++; context = value },
        onHeaders() { return true }, onData() { return true }, onComplete() { resolve() }, onError(err: Error) { reject(err) },
      } as never)
    })
    assert.equal(starts, 1, 'legacy onConnect is called once, before buffering')
    assert.deepEqual(context?.history?.map(String), [`${origin}/a`, `${origin}/b`])
  } finally { await agent.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('R7: raw null and primitive contexts remain exactly readable through the stable controller getter', async () => {
  for (const raw of [null, undefined, 'context', 42, false, 1n, Symbol('context')]) {
    let controller: (Dispatcher.DispatchController & { readonly context?: unknown }) | undefined
    let stable: unknown
    let starts = 0
    class ContextWire extends Dispatcher {
      override dispatch(_opts: Dispatcher.DispatchOptions, h: Dispatcher.DispatchHandler): boolean {
        const c: Dispatcher.DispatchController = { aborted: false, paused: false, reason: null, pause() {}, resume() {}, abort() {} }
        h.onRequestStart?.(c, raw)
        h.onResponseStart?.(c, 200, {})
        h.onResponseEnd?.(c, {})
        return true
      }
    }
    const gateway = new MaskingDispatcher(new ContextWire(), { maskRequest: () => null })
    gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', body: '{}' }, {
      onRequestStart(c, context) { starts++; controller = c; stable = context }, onResponseEnd() {},
    })
    await delay(5)
    assert.equal(starts, 1)
    assert.equal(typeof stable, 'object')
    assert.notEqual(stable, null)
    assert.equal(controller?.context, raw)
    assert.equal(Reflect.set(controller as object, 'context', 'overwritten'), false, 'raw context is read-only')
  }
})

test('R7: an already aborted request never pulls its body, and builtin fetch cancellation still rejects', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  let pulls = 0
  const ac = new AbortController()
  ac.abort()
  const body = { *[Symbol.iterator]() { pulls++; yield chat } }
  try {
    await assert.rejects(request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never, signal: ac.signal }))
    assert.equal(pulls, 0)
    const before = getGlobalDispatcher()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const streamed = Readable.from((async function* () { yield chat.slice(0, 10); await wait; yield chat.slice(10) })())
    const cancel = new AbortController()
    setGlobalDispatcher(gateway)
    let result = 'pending'
    const pending = fetch(origin.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: streamed, signal: cancel.signal, duplex: 'half' } as RequestInit).then(() => { result = 'sent' }, (err: Error) => { result = err.name })
    try { await delay(10); cancel.abort(); await delay(30); assert.equal(result, 'AbortError') }
    finally { release(); await pending; setGlobalDispatcher(before) }
    assert.equal(origin.seen.length, 0)
  } finally { await agent.close(); await origin.close() }
})

test('R7: a non-model buffered request drops callbacks after cancellation', async () => {
  let control: Dispatcher.DispatchController | undefined
  let actual: Dispatcher.DispatchHandler | undefined
  let output = 0
  let errors = 0
  class Late extends Dispatcher {
    override dispatch(_opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      actual = handler
      handler.onRequestStart?.({ aborted: false, paused: false, reason: null, pause() {}, resume() {}, abort() {} }, null)
      return true
    }
  }
  const gateway = new MaskingDispatcher(new Late(), { maskRequest: () => null })
  gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', body: '{}' }, { onRequestStart(c) { control = c }, onResponseData() { output++ }, onResponseEnd() { output++ }, onResponseError() { errors++ } })
  await delay(5)
  control?.abort(new Error('cancel'))
  const c = control as Dispatcher.DispatchController
  actual?.onResponseData?.(c, Buffer.from('late'))
  actual?.onResponseEnd?.(c, {})
  assert.equal(errors, 1)
  assert.equal(output, 0)
})

test('R7: request cancellation rejects immediately and destroys a stalled body before dispatch', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  let release!: () => void
  let consumed = false
  const stalled = new Promise<void>((resolve) => { release = resolve })
  const body = Readable.from((async function* () { yield chat.slice(0, 10); await stalled; consumed = true; yield chat.slice(10) })())
  const ac = new AbortController()
  let result = 'pending'
  const pending = request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal }).then(() => { result = 'sent' }, (err: Error) => { result = err.name })
  try {
    await delay(10)
    ac.abort()
    await delay(30)
    assert.equal(result, 'AbortError')
    assert.equal(body.destroyed, true)
    assert.equal(consumed, false)
    assert.equal(origin.seen.length, 0)
  } finally { release(); await pending; await agent.close(); await origin.close() }
})

test('R7: buffering exposes one start, cancellation calls iterator.return, and later abort reaches the actual controller', async () => {
  let returned = 0
  let starts = 0
  let errors = 0
  let dispatches = 0
  const body = { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<string>>(() => {}), return: async () => { returned++; return { done: true, value: undefined } } } } }
  class Sink extends Dispatcher {
    override dispatch(_opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      dispatches++
      handler.onRequestStart?.({ aborted: false, paused: false, reason: null, pause() {}, resume() {}, abort() { errors++ } }, null)
      return true
    }
  }
  const gateway = new MaskingDispatcher(new Sink(), new PrivacyEngine(randomBytes(32), defaults))
  let control: Dispatcher.DispatchController | undefined
  gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never }, {
    onRequestStart(c) { starts++; control = c }, onResponseError() { errors++ },
  })
  await delay(5)
  control?.abort(new Error('cancel'))
  await delay(5)
  assert.equal(starts, 1)
  assert.equal(errors, 1)
  assert.equal(returned, 1)
  assert.equal(dispatches, 0)
  starts = 0; errors = 0
  gateway.dispatch({ origin: 'http://127.0.0.1', path: '/', method: 'POST', headers: { 'content-type': 'application/json' }, body: chat }, {
    onRequestStart(c) { starts++; control = c }, onResponseError() { errors++ },
  })
  await delay(5)
  control?.abort(new Error('late cancel'))
  assert.equal(starts, 1)
  assert.equal(dispatches, 1)
  assert.equal(errors, 2, 'actual abort plus exactly one error callback')
})

test('R1: equivalent JSON body representations are masked, including offset views and split sync iterables', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  const bytes = Buffer.from(chat)
  const padded = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')])
  const offset = padded.byteOffset + 6
  const split = chat.indexOf(SECRET) + 9
  function* syncBody() { yield chat.slice(0, split); yield Buffer.from(chat.slice(split)) }
  const bodies: Array<[string, unknown]> = [
    ['string', chat], ['Blob', new Blob([bytes])], ['ArrayBuffer', Uint8Array.from(bytes).buffer],
    ['spoofed FormData tag', { [Symbol.toStringTag]: 'FormData', *[Symbol.iterator]() { yield chat } }],
    ['DataView', new DataView(padded.buffer, offset, bytes.length)],
    ['Uint8Array offset', new Uint8Array(padded.buffer, offset, bytes.length)],
    ['Int8Array offset', new Int8Array(padded.buffer, offset, bytes.length)], ['sync iterable', syncBody()],
  ]
  try {
    for (const [name, body] of bodies) {
      const res = await request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never })
      await res.body.text()
      const wire = origin.seen.at(-1)?.toString() ?? ''
      assert.ok(!wire.includes(SECRET), `${name} leaked the secret`)
      assert.match(wire, /⟦DSH_REDACTED:API_KEY_[a-z2-7]{8}⟧/, name)
      assert.ok(!wire.includes('prefix') && !wire.includes('suffix'), name)
    }
  } finally { await agent.close(); await origin.close() }
})

for (const [name, Form] of [['undici', FormData], ['builtin', globalThis.FormData]] as const) {
  test(`R1: ${name} FormData prototypes and mutated instances do not bypass JSON masking`, async () => {
    const origin = await localOrigin()
    const agent = new Agent()
    const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
    const fake = Object.assign(Object.create(Form.prototype), { append: undefined, *[Symbol.iterator]() { yield chat } })
    const spoofed = Object.assign(Object.create(Form.prototype), {
      append() {}, delete() {}, get() { return null }, getAll() { return [] }, has() { return false }, set() {},
      *[Symbol.iterator]() { yield chat },
    })
    const mutated = Object.assign(new Form(), { append: undefined, *[Symbol.iterator]() { yield chat } })
    try {
      for (const [kind, body] of [['fake prototype', fake], ['spoofed native methods', spoofed], ['mutated genuine instance', mutated]] as const) {
        const res = await request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never })
        await res.body.text()
        const wire = origin.seen.at(-1)?.toString() ?? ''
        assert.ok(!wire.includes(SECRET), `${kind} leaked the secret`)
        assert.match(wire, /⟦DSH_REDACTED:API_KEY_[a-z2-7]{8}⟧/, kind)
      }
    } finally { await agent.close(); await origin.close() }
  })
}

for (const [name, Form] of [['undici', FormData], ['builtin', globalThis.FormData]] as const) {
  test(`R1: ${name} stateful FormData classification accessors never execute or bypass masking`, async () => {
    const origin = await localOrigin()
    const agent = new Agent()
    const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
    try {
      for (const key of ['append', 'delete', 'get', 'getAll', 'has', 'set', Symbol.toStringTag, 'pipe', 'on']) {
        const body = new Form()
        let reads = 0
        const native = (Form.prototype as unknown as Record<PropertyKey, unknown>)[key]
        Object.defineProperty(body, key, { get() { reads++; return reads === 1 ? native : undefined } })
        Object.assign(body, { *[Symbol.iterator]() { yield chat } })
        const res = await request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never })
        await res.body.text()
        const wire = origin.seen.at(-1)?.toString() ?? ''
        assert.ok(!wire.includes(SECRET), `${String(key)} leaked the secret`)
        assert.match(wire, /⟦DSH_REDACTED:API_KEY_[a-z2-7]{8}⟧/, String(key))
        assert.equal(reads, 0, `${String(key)} classification getter executed`)
      }
    } finally { await agent.destroy(); await origin.close() }
  })
}

test('R1: proxied FormData cannot qualify for the multipart exemption', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  try {
    for (const form of [new FormData(), new globalThis.FormData()]) {
      let classificationReads = 0
      const classificationKeys = new Set<PropertyKey>(['append', 'delete', 'get', 'getAll', 'has', 'set', Symbol.toStringTag, 'pipe', 'on'])
      const body = new Proxy(form, { get(target, key, receiver) { if (classificationKeys.has(key)) classificationReads++; if (key === Symbol.iterator) return function* () { yield chat }; return Reflect.get(target, key, receiver) } })
      const res = await request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: body as never })
      await res.body.text()
      const wire = origin.seen.at(-1)?.toString() ?? ''
      assert.ok(!wire.includes(SECRET))
      assert.match(wire, /⟦DSH_REDACTED:API_KEY_[a-z2-7]{8}⟧/)
      assert.equal(classificationReads, 0, 'multipart classification never invokes proxy property traps')
    }
    const before = origin.seen.length
    const unreadable = new Proxy(new FormData(), { get() { throw new Error('proxy read failed') } })
    await assert.rejects(request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: unreadable }), /proxy read failed/)
    assert.equal(origin.seen.length, before, 'an unreadable proxy is never transmitted')
  } finally { await agent.destroy(); await origin.close() }
})

test('R1: genuine multipart remains exempt with an overridden entry iterator', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  const form = new FormData()
  form.set('file', new Blob([chat]), 'chat.json')
  Object.assign(form, { *[Symbol.iterator]() { yield ['entry', chat] } })
  try {
    const res = await request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: form })
    await res.body.text()
    assert.ok(origin.seen[0]?.toString().includes(SECRET), 'genuine multipart remains exempt, even with a caller-provided JSON content type')
    assert.ok(origin.seen[0]?.toString().includes('Content-Disposition: form-data; name="entry"'), 'undici encoded multipart entries rather than a raw JSON iterable')
  } finally { await agent.close(); await origin.close() }
})

test('R1: builtin fetch multipart remains exempt', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  const before = getGlobalDispatcher()
  const form = new globalThis.FormData()
  form.set('file', new Blob([chat]), 'chat.json')
  try {
    setGlobalDispatcher(gateway)
    const res = await fetch(origin.url, { method: 'POST', body: form })
    await res.text()
    assert.ok(origin.seen[0]?.toString().includes(SECRET))
    assert.ok(origin.seen[0]?.toString().includes('Content-Disposition: form-data'))
  } finally { setGlobalDispatcher(before); await agent.destroy(); await origin.close() }
})

test('R1: explicit JSON normalization failures are fail-closed and multipart FormData remains exempt', async () => {
  const origin = await localOrigin()
  const agent = new Agent()
  const gateway = new MaskingDispatcher(agent, new PrivacyEngine(randomBytes(32), defaults))
  try {
    const broken = { *[Symbol.iterator]() { yield chat.slice(0, 10); throw new Error('producer failed') } }
    await assert.rejects(request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: broken as never }), /producer failed/)
    const invalid = { *[Symbol.iterator]() { yield 42 } }
    await assert.rejects(request(origin.url, { dispatcher: gateway, method: 'POST', headers: { 'content-type': 'application/json' }, body: invalid as never }))
    assert.equal(origin.seen.length, 0)
    const form = new FormData()
    form.set('file', new Blob([chat]), 'chat.json')
    const res = await request(origin.url, { dispatcher: gateway, method: 'POST', body: form })
    await res.body.text()
    assert.ok(origin.seen[0]?.toString().includes(SECRET), 'multipart exemption is unchanged')
  } finally { await agent.close(); await origin.close() }
})
