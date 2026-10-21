import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PYTHON } from './runtime.ts'
import * as sdk from '../../sdk/src/index.ts'
import { warmOptions } from '../../sdk/src/client.ts'
import { executableOf } from '../../sdk/src/executable.ts'
import * as testing from '../../sdk/src/testing.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-developer-'))
const guard = setTimeout(() => { console.error('FAIL developer proof deadline'); process.exit(1) }, 120000)
let failures = 0
function example(schema: any): any {
  if ('const' in schema) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf ?? schema.oneOf)[0])
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map((key: string) => [key, example(schema.properties[key])]))
  return schema.type === 'array' ? [] : schema.type === 'string' ? 'fixture' : schema.type === 'boolean' ? false : schema.type === 'null' ? null : Math.max(1, schema.minimum ?? 0)
}
const sessionRow = { ...example(sdk.ROW_SCHEMAS.session), session_id: 'fixture-session' }
const WINDOWS_HOST = process.platform === 'win32'
function runtimeStandIn(path: string): string {
  if (WINDOWS_HOST) { try { linkSync(process.execPath, path) } catch { copyFileSync(process.execPath, path) } }
  else { writeFileSync(path, '#!/bin/sh\nexec node "$@"\n'); chmodSync(path, 0o755) }
  return path
}
const outcome = { ...example(sdk.ROW_SCHEMAS.outcome), status: 'completed', answer: 'ok' }
const init = { result: { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 'fixture-session' } }
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + String(error)) }
}
let promptFixtures = 0
function promptFixture(correlated = false, warm = false) {
  const record = join(scratch, `prompt-${++promptFixtures}.jsonl`)
  writeFileSync(record, '')
  const script = `
    const { createInterface } = require('node:readline')
    const { appendFileSync } = require('node:fs')
    const emit = message => process.stdout.write(JSON.stringify(message) + '\\n')
    let claimed = ${!warm}
    const cancelled = []
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line)
      appendFileSync(${JSON.stringify(record)}, line + '\\n')
      const { id, method, params } = message
      const reply = result => emit({ jsonrpc: '2.0', id, result })
      if (method === 'initialize') reply({ ...${JSON.stringify(init.result)}, session_id: claimed ? 'fixture-session' : null })
      else if (method === 'session/claim') {
        if (params.session_id === 'rejected') emit({ jsonrpc: '2.0', id, error: { code: -32602, message: 'claim rejected' } })
        else { claimed = true; reply({ session_id: 'claimed-session' }) }
      } else if (method === 'queue/withdraw') reply(params.id === 'keep' ? { withdrawn: false, reason: 'taken' } : { withdrawn: true, text: 'queued' })
      else if (method === 'queue/add' && claimed) {
        if (params.content === 'error') { emit({ jsonrpc: '2.0', id, error: { code: -32603, message: 'queue failed' } }); return }
        reply(params.content === 'reject' ? { accepted: false, reason: 'duplicate' } : { accepted: true })
        if (params.content === 'cancel') { cancelled.push(params.id); emit({ jsonrpc: '2.0', method: 'fixture/queued', params: { id: params.id } }) }
        if (params.content === 'resolve') {
          for (const queued of cancelled.splice(0)) {
            if (${correlated}) emit({ jsonrpc: '2.0', method: 'row', params: { ...${JSON.stringify(testing.fixtureTurn()[0])}, turn_id: 'cancelled-turn', message_ids: [queued] } })
            emit({ jsonrpc: '2.0', method: 'row', params: { ...${JSON.stringify(testing.fixtureOutcomeRow({ answer: 'cancelled' }))}, turn_id: 'cancelled-turn' } })
          }
          if (${correlated}) emit({ jsonrpc: '2.0', method: 'row', params: { ...${JSON.stringify(testing.fixtureTurn()[0])}, message_ids: [params.id] } })
          emit({ jsonrpc: '2.0', method: 'row', params: ${JSON.stringify(testing.fixtureOutcomeRow({ answer: 'resolved' }))} })
        }
      }
    })
  `
  return { mercury: ['node', '-e', script, '--'], received: () => readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
try {
  await check('row 1 automatic grants preserve options and servers close on exit', async () => {
    const echo = sdk.defineTool({ name: 'echo', description: 'Echo', inputSchema: {}, execute: () => 'ok' })
    for (const autoAllowTools of [true, false]) {
      const fixture = await testing.startFixtureServer({ rows: [sessionRow, outcome], inputCount: 1 })
      const agent = { description: 'Reader', prompt: 'Read', tools: ['Read'] }
      const task = sdk.run({ mercury: fixture.mercury, tools: [echo], autoAllowTools, input: 'rows', agentDefs: { reader: agent }, allowedTools: ['Read'] })
      try {
        await task.ready
        assert.deepEqual(agent.tools, ['Read'])
        const agents = JSON.parse(task.args[task.args.indexOf('--agent-defs') + 1]!)
        assert.equal(agents.reader.tools.includes('mcp__sdk-tools__echo'), autoAllowTools)
        assert.equal(task.args.includes('mcp__sdk-tools__echo'), autoAllowTools)
        const config = JSON.parse(task.args[task.args.indexOf('--mcp') + 1]!).mcpServers['sdk-tools']
        await task.sendPrompt('finish'); task.closeInput(); await task.outcome
        await assert.rejects(fetch(config.url))
      } finally { await task.close(); await fixture.close() }
    }
    const failed = sdk.run({ tools: [echo, echo] })
    await assert.rejects(failed.outcome, /duplicate tool name/)
    await assert.rejects(failed.ready, /duplicate tool name/)
    await failed.close()
  })
  await check('row 1 inline execution receives MCP cancellation', async () => {
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const server = await sdk.serveTools([sdk.defineTool({ name: 'wait', description: 'Wait', inputSchema: {}, execute: (_input, { signal }) => new Promise<string>(resolve => { began(); signal.addEventListener('abort', () => resolve('cancelled'), { once: true }) }) })])
    if (typeof server.cancel !== 'function') { await server.close(); throw new Error('inline cancellation missing') }
    const post = (body: unknown) => fetch(server.config.url, { method: 'POST', headers: { ...server.config.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const call = post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } })
      await started
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).status, 202)
      assert.equal((await (await call).json() as any).result.content[0].text, 'cancelled')
    } finally { await server.close() }
  })
  await check('row 2 inferred terminal capabilities respect explicit overrides', async () => {
    const handlers = { 'terminal/create': () => ({ terminal_id: 't' }), 'terminal/output': () => ({ output: '', truncated: false }), 'terminal/wait_for_exit': () => ({ exit_code: 0 }), 'terminal/kill': () => {}, 'terminal/release': () => {} }
    for (const capabilities of [undefined, { terminal: false, fs_read_text_file: false }]) {
      const fixture = await testing.startFixtureServer({ methods: { initialize: [init] } })
      const session = await sdk.connect({ mercury: fixture.mercury, handlers, onReadTextFile: () => ({ content: '' }), capabilities })
      try { const caps = (fixture.received[0]!.params as any).capabilities; assert.equal(caps.terminal, capabilities === undefined); assert.equal(caps.fs_read_text_file, capabilities === undefined) }
      finally { await session.close(); await fixture.close() }
    }
  })
  await check('rows 3 and 5 checkpoints asked on initialize, identity validation and an accepted prompt id', async () => {
    for (const [options, asked] of [[{}, true], [{ checkpoints: false }, false], [{ checkpoints: true }, true]] as const) {
      const answered = { ...init, result: { ...init.result, file_checkpoints: { capture: asked, source: asked ? 'initialize' : 'headless' } } }
      const fixture = await testing.startFixtureServer({ methods: { initialize: [answered], 'queue/add': [{ result: { accepted: false, reason: 'duplicate' } }, { result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: outcome }] }] } })
      const session = await sdk.connect({ mercury: fixture.mercury, ...options })
      try {
        assert.equal((fixture.received[0]!.params as { file_checkpoints?: boolean }).file_checkpoints, asked, `connect ${JSON.stringify(options)} asks initialize for file_checkpoints: ${asked}`)
        assert(!session.child.spawnargs.includes('--session-id'), 'no boot identity is pinned for checkpoints')
        assert.deepEqual(session.fileCheckpoints, answered.result.file_checkpoints, 'fileCheckpoints reads the initialize answer')
        await assert.rejects(session.prompt('refused by the queue'), /prompt was not accepted/)
        assert.equal(session.lastPromptId, undefined, 'a prompt the queue refused is not the last accepted prompt')
        assert.equal((await session.prompt('accepted')).status, 'completed')
        assert.equal(typeof session.lastPromptId, 'string')
      } finally { await session.close(); await fixture.close() }
    }
    await assert.rejects(sdk.connect({ mercury: ['node', '-e', 'process.exit(2)', '--'], warm: true, resume: 'saved' }), /warm cannot be combined/)
  })
  await check('row 4 generated concrete replies carry wire field names', () => {
    const wire = readFileSync(join(root, 'sdk/src/wire.ts'), 'utf8')
    for (const name of ['SessionFactsResult', 'SessionRewindResult', 'AgentStopResult', 'AgentResumeResult']) assert(wire.includes('export type ' + name + ' = {'), name)
    for (const field of ['total_cost_usd: number', 'files_changed: string[]', 'file_checkpoints?', 'output_file: string']) assert(wire.includes(field), field)
  })
  await check('row 6 structured run validation and typed decoding', async () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } as const
    writeFileSync(join(scratch, 'schema.json'), JSON.stringify(schema))
    const argv = sdk.argvOf({ mercury: 'fixture', cwd: scratch, schema: 'schema.json' }).args
    assert.deepEqual(JSON.parse(argv[argv.indexOf('--schema') + 1]!), schema)
    const bad = await testing.startFixtureServer({ rows: [sessionRow, { ...outcome, structured: { count: 'bad' } }] })
    try { await assert.rejects(sdk.run({ mercury: bad.mercury, schema }).outcome, e => e instanceof Error && e.name === 'MercurySchemaError' && e.message === 'structured output does not match schema: count' && 'issues' in e && JSON.stringify(e.issues).includes('count')) }
    finally { await bad.close() }
    const good = await testing.startFixtureServer({ rows: [sessionRow, { ...outcome, structured: { count: 7 } }] })
    try {
      const typed = sdk.structuredSchema(schema, value => ({ count: (value as { count: number }).count }))
      assert.equal((await sdk.run({ mercury: good.mercury, schema: typed }).outcome).structured?.count, 7)
    } finally { await good.close() }
  })
  await check('row 6 a per-turn schema travels on the prompt row, the boot schema on initialize, and a refused schema is MercurySchemaError with its path', async () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' } } }
    const fixture = await testing.startFixtureServer({ methods: { initialize: [init], 'queue/add': [{ result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: { ...outcome, structured: { count: 'bad' } } }] }, { error: { code: -32602, message: 'invalid params for queue/add', data: { method: 'queue/add', issues: [{ path: ['schema'], message: 'the prompt row carries a schema that is not a JSON schema — data/type must be equal to one of the allowed values' }] } } }, { result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: { ...outcome, structured: { count: 4 } } }] }] } })
    const session = await sdk.connect({ mercury: fixture.mercury, schema: { type: 'object' } })
    try {
      assert.deepEqual((fixture.received[0]!.params as { schema?: unknown }).schema, { type: 'object' }, 'connect sends its schema on initialize')
      assert.deepEqual(JSON.parse(session.child.spawnargs[session.child.spawnargs.indexOf('--schema') + 1]!), { type: 'object' }, 'the runner door also carries --schema, the road every Mercury version honours')
      await assert.rejects(session.prompt('test', { schema }), e => e instanceof Error && e.name === 'MercurySchemaError' && (e as sdk.MercurySchemaError).outcome !== null)
      assert.deepEqual((fixture.received.find(r => r.method === 'queue/add')!.params as { schema?: unknown }).schema, schema, 'prompt sends the turn schema on its row')
      await assert.rejects(session.prompt('refused', { schema }), e => e instanceof sdk.MercurySchemaError && e.code === -32602 && e.outcome === null && e.issues.length === 1 && e.issues[0]!.path === 'schema' && e.message === e.issues[0]!.message && /not a JSON schema/.test(e.message))
      assert.deepEqual((await session.prompt('again', { schema })).structured, { count: 4 }, 'the session prompts again after a refused schema')
    } finally { await session.close(); await fixture.close() }
  })
  await check('row 11 version floors: a runner below 1.0.0-beta.41 refuses a per-turn schema before sending and reads no file checkpoints; a runner at the floor, or one whose answer carries file_checkpoints, is sent the field', async () => {
    assert.deepEqual(sdk.FEATURE_FLOORS, { perTurnSchema: '1.0.0-beta.41', fileCheckpoints: '1.0.0-beta.41' })
    assert.deepEqual([['1.0.0-beta.40', '1.0.0-beta.41'], ['1.0.0-beta.9', '1.0.0-beta.41'], ['1.0.0-beta.41', '1.0.0'], ['1.0.0-beta.41', '1.0.0-beta.41'], ['1.0.1', '1.0.0-beta.41'], ['1.0.0-rc.1', '1.0.0-beta.41']].map(([a, b]) => sdk.compareVersions(a!, b!)), [-1, -1, -1, 0, 1, 1])
    assert.equal(sdk.compareVersions('fixture', '1.0.0-beta.41'), undefined)
    const schema = { type: 'object', properties: { count: { type: 'integer' } } }
    const words = 'per-turn schema needs Mercury 1.0.0-beta.41 or newer; this runner is 1.0.0-beta.40 — run `mercury update`'
    const answered = (version: string, extra: Record<string, unknown> = {}) => ({ result: { ...init.result, runner: { version, pid: 1 }, ...extra } })
    const refusing = await testing.startFixtureServer({ methods: { initialize: [answered('1.0.0-beta.40')], 'queue/add': [{ result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: outcome }] }] } })
    const old = await sdk.connect({ mercury: refusing.mercury })
    try {
      assert.equal(old.runnerVersion, '1.0.0-beta.40')
      assert.deepEqual(old.supports, { perTurnSchema: false, fileCheckpoints: false })
      assert.equal(old.fileCheckpoints, undefined, 'a runner that answers no file_checkpoints reads undefined, with supports.fileCheckpoints false beside it')
      for (const send of [() => old.prompt('x', { schema }), () => old.steer('x', { schema }), () => old.followUp('x', { schema }), () => old.sendPrompt('x', { schema }), () => old.send({ type: 'prompt', content: 'x', schema })]) await assert.rejects(send(), (e: unknown) => e instanceof sdk.MercuryError && !(e instanceof sdk.MercurySchemaError) && e.message === words && e.code === undefined)
      assert.equal(refusing.received.filter(r => r.method === 'queue/add').length, 0, 'a refused per-turn schema never reaches the wire')
      assert.equal((await old.prompt('plain')).status, 'completed', 'the session still prompts without a per-turn schema')
    } finally { await old.close(); await refusing.close() }
    for (const [label, reply] of [['at the floor', answered('1.0.0-beta.41')], ['below the floor but answering the .41 wire', answered('1.0.0-beta.40', { file_checkpoints: { capture: true, source: 'initialize' } })], ['a release above the floor', answered('1.0.0')]] as const) {
      const fixture = await testing.startFixtureServer({ methods: { initialize: [reply], 'queue/add': [{ result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: { ...outcome, structured: { count: 1 } } }] }] } })
      const session = await sdk.connect({ mercury: fixture.mercury })
      try {
        assert.deepEqual(session.supports, { perTurnSchema: true, fileCheckpoints: true }, label)
        assert.deepEqual((await session.prompt('x', { schema })).structured, { count: 1 }, label)
        assert.deepEqual((fixture.received.find(r => r.method === 'queue/add')!.params as { schema?: unknown }).schema, schema, `${label}: the per-turn schema is sent`)
      } finally { await session.close(); await fixture.close() }
    }
  })
  await check('row 12 a schema that is not a JSON Schema is refused by the package before anything is sent: MercurySchemaError at path schema, outcome null, no code, on prompt, the row roads, connect and run', async () => {
    const malformed = { type: 'banana', properties: 7 } as unknown as sdk.JsonSchema
    const words = 'not a JSON schema — schema.type must be object, array, string, number, integer, boolean, null or an array of them (found "banana")'
    const refused = (error: unknown) => error instanceof sdk.MercurySchemaError && error.message === words && error.outcome === null && error.code === undefined && error.issues.length === 1 && error.issues[0]!.path === 'schema' && error.issues[0]!.message === words
    assert.equal(sdk.schemaProblem(malformed), words)
    assert.equal(sdk.schemaProblem({ type: 'object', properties: 7 }), 'not a JSON schema — schema.properties must be an object of schemas (found number)')
    assert.equal(sdk.schemaProblem({ type: 'object', properties: { a: { type: 'integer', minimum: 'x' } } }), 'not a JSON schema — schema.properties.a.minimum must be a number (found string)')
    assert.equal(sdk.schemaProblem({ type: ['string', 'null'], enum: ['a', null], properties: { b: { items: { type: 'number' } } }, additionalProperties: false }), undefined)
    const fixture = await testing.startFixtureServer({ methods: { initialize: [init], 'queue/add': [{ result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: outcome }] }] } })
    const session = await sdk.connect({ mercury: fixture.mercury })
    try {
      for (const send of [() => session.prompt('x', { schema: malformed }), () => session.prompt('x', { schema: JSON.stringify(malformed) }), () => session.prompt('x', { schema: sdk.structuredSchema(malformed, value => value) }), () => session.steer('x', { schema: malformed }), () => session.followUp('x', { schema: malformed }), () => session.sendPrompt('x', { schema: malformed }), () => session.send({ type: 'prompt', content: 'x', schema: malformed })]) await assert.rejects(send(), refused)
      assert.equal(fixture.received.filter(r => r.method === 'queue/add').length, 0, 'a schema the package refuses never reaches the wire')
      assert.equal((await session.prompt('plain')).status, 'completed', 'the refusal leaves the session free')
    } finally { await session.close() }
    await assert.rejects(sdk.connect({ mercury: fixture.mercury, schema: malformed }), refused)
    assert.equal(fixture.received.filter(r => r.method === 'initialize').length, 1, 'connect refuses the schema before starting a runner')
    await fixture.close()
    assert.throws(() => sdk.run({ mercury: 'mercury-sdk-no-such-binary-proof', prompt: 'x', schema: malformed }), refused)
    assert.throws(() => sdk.argvOf({ mercury: 'fixture', schema: malformed }), refused)
  })
  await check('row 7 blocks and image bytes feed input rows', async () => {
    const fixture = await testing.startFixtureServer({ rows: [sessionRow, outcome], inputCount: 1 })
    try {
      const blocks = [sdk.textBlock('hello'), sdk.imageBlock(Buffer.from('image'), 'image/png')]
      assert.equal((await sdk.run({ mercury: fixture.mercury, prompt: blocks }).outcome).status, 'completed')
      assert.deepEqual(fixture.received[0]!.content, blocks)
      assert.equal(blocks[1]!.type, 'image')
      writeFileSync(join(scratch, 'image.bin'), 'image')
      assert.deepEqual(sdk.imageBlock({ path: join(scratch, 'image.bin') }, 'image/png'), blocks[1])
    } finally { await fixture.close() }
  })
  await check('row 7 asynchronous prompt input and producer errors', async () => {
    const fixture = await testing.startFixtureServer({ rows: [sessionRow, outcome], inputCount: 2 })
    try {
      async function* input() { yield 'first'; yield { type: 'note' as const, to: 'a', content: 'second' } }
      assert.equal((await sdk.run({ mercury: fixture.mercury, prompt: input() }).outcome).status, 'completed')
      assert.deepEqual(fixture.received.map(row => row.type), ['prompt', 'note'])
      async function* broken(): AsyncGenerator<string> { throw new Error('producer failed') }
      await assert.rejects(sdk.run({ mercury: fixture.mercury, prompt: broken() }).outcome, /producer failed/)
    } finally { await fixture.close() }
  })
  await check('row 7 a finished process releases a pending input producer', async () => {
    const fixture = await testing.startFixtureServer({ rows: [sessionRow, outcome] })
    let returned = false
    const input: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true, value: undefined } } }) }
    try { await sdk.run({ mercury: fixture.mercury, prompt: input }).outcome; await new Promise(resolve => setImmediate(resolve)); assert(returned) }
    finally { await fixture.close() }
  })
  await check('row 7 steer and follow up preserve priorities', async () => {
    const fixture = await testing.startFixtureServer({ methods: { initialize: [init], 'queue/add': [{ result: { accepted: true } }, { result: { accepted: true } }] } })
    const session = await sdk.connect({ mercury: fixture.mercury })
    try { await session.steer('now'); await session.followUp('later'); assert.deepEqual(fixture.received.filter(r => r.method === 'queue/add').map(r => (r.params as any).priority), ['now', 'later']) }
    finally { await session.close(); await fixture.close() }
  })
  await check('prompt ids: every accepted send and convenience call is available for withdrawal', async () => {
    const fixture = promptFixture()
    const session = await sdk.connect({ mercury: fixture.mercury })
    try {
      await session.steer('x')
      assert.equal(typeof session.lastPromptId, 'string', 'steer exposes its generated prompt id')
      assert.equal((await session.withdraw(session.lastPromptId!)).withdrawn, true)
      const schema = { type: 'object' }
      await session.steer('now', { id: 'steered', schema })
      assert.equal(session.lastPromptId, 'steered')
      await session.followUp('later', { id: 'followed', schema })
      assert.equal(session.lastPromptId, 'followed')
      await session.sendPrompt('sent', { id: 'sent' })
      assert.equal(session.lastPromptId, 'sent')
      await session.send({ type: 'prompt', content: 'direct', id: 'direct' })
      assert.equal(session.lastPromptId, 'direct')
      assert.equal((await session.sendPrompt('reject', { id: 'rejected' })).accepted, false)
      assert.equal(session.lastPromptId, 'direct', 'a rejected prompt does not replace the accepted id')
      const rows = fixture.received().filter(row => row.method === 'queue/add').map(row => row.params)
      assert.deepEqual(rows.slice(1, 3).map(row => [row.id, row.priority, row.schema]), [['steered', 'now', schema], ['followed', 'later', schema]])
    } finally { await session.close() }
  })
  for (const correlated of [false, true]) {
    await check(`prompt withdrawal: the next ${correlated ? 'correlated' : 'uncorrelated'} turn resolves`, async () => {
      const fixture = promptFixture(correlated)
      const session = await sdk.connect({ mercury: fixture.mercury })
      try {
        await session.steer('x')
        const queued = fixture.received().find(row => row.method === 'queue/add')!.params.id
        assert.equal((await session.withdraw(session.lastPromptId ?? queued)).withdrawn, true)
        assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved', 'a withdrawn prompt cannot block the next outcome')
      } finally { await session.close() }
    })
    await check(`prompt withdrawal: a prompt() waiting on its own withdrawn ${correlated ? 'correlated' : 'uncorrelated'} input rejects and frees the session`, async () => {
      const fixture = promptFixture(correlated)
      const session = await sdk.connect({ mercury: fixture.mercury })
      try {
        const waiting = session.prompt('queued')
        waiting.catch(() => undefined)
        for (let tries = 0; tries < 200 && session.lastPromptId === undefined; tries++) await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal((await session.withdraw(session.lastPromptId!)).withdrawn, true)
        await assert.rejects(Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error('the withdrawn wait never settled')), 500))]), (error: unknown) => error instanceof sdk.MercuryError && error.message === 'prompt: withdrawn')
        assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved', 'the session takes the next prompt')
      } finally { await session.close() }
    })
    await check(`prompt ids: input the runner answers with an error leaves no ${correlated ? 'correlated' : 'uncorrelated'} turn entry behind`, async () => {
      const fixture = promptFixture(correlated)
      const session = await sdk.connect({ mercury: fixture.mercury })
      try {
        for (const send of [() => session.sendPrompt('error'), () => session.steer('error'), () => session.followUp('error'), () => session.send({ type: 'prompt', content: 'error' })]) await assert.rejects(send(), (error: unknown) => error instanceof sdk.MercuryError && error.code === -32603 && error.message === 'queue failed')
        assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved', 'input the runner refused cannot hold the next outcome')
      } finally { await session.close() }
    })
    await check(`prompt cancellation: the cancelled turn still ends first and the next ${correlated ? 'correlated' : 'uncorrelated'} prompt resolves with its own turn`, async () => {
      const fixture = promptFixture(correlated)
      const session = await sdk.connect({ mercury: fixture.mercury })
      const controller = new AbortController()
      session.on('notification', message => { if (message.method === 'fixture/queued') controller.abort() })
      try {
        await assert.rejects(session.prompt('cancel', { signal: controller.signal }), /prompt: cancelled/)
        assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved', 'the cancelled turn\'s outcome is not the next prompt\'s answer')
        assert.equal(fixture.received().some(row => row.method === 'turn/interrupt'), false, 'cancellation still cancels only the wait')
      } finally { await session.close() }
    })
  }
  await check('prompt ids: a schema the package refuses before sending leaves the session free for the next prompt', async () => {
    const fixture = promptFixture()
    const session = await sdk.connect({ mercury: fixture.mercury })
    try {
      await assert.rejects(session.prompt('resolve', { schema: '{not json' }), (error: unknown) => error instanceof sdk.MercuryError && error.message === 'invalid schema JSON')
      await assert.rejects(session.prompt('resolve', { schema: join(scratch, 'no-such-schema.json') }), (error: unknown) => error instanceof sdk.MercuryError && error.message.startsWith('could not read schema file: '))
      assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved', 'a refused schema leaves no prompt pending')
      assert.equal(fixture.received().filter(row => row.method === 'queue/add').length, 1, 'a refused schema never reaches the wire')
    } finally { await session.close() }
  })
  await check('a prompt sent while a turn is running settles: folded into that turn it resolves with the reply it was marked in reply to, queued behind it with its own turn, and one the runner holds neither queued nor in a turn is rejected with the words within the grace', async () => {
    const [turnRow] = testing.fixtureTurn()
    const textRow = { ...example(sdk.ROW_SCHEMAS.text), session_id: 'fixture-session', turn: 1, message_id: 'm2', block: 0, text: 'Folded answer.' }
    const facts = example(sdk.METHODS['session/facts'].result)
    const midTurnFixture = (mode: 'folded' | 'queued' | 'queued-late' | 'swallowed') => ['node', '-e', `
      const { createInterface } = require('node:readline')
      const emit = message => process.stdout.write(JSON.stringify(message) + '\\n')
      const row = params => emit({ jsonrpc: '2.0', method: 'row', params })
      const ids = []
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line)
        const reply = result => emit({ jsonrpc: '2.0', id, result })
        if (method === 'initialize') reply(${JSON.stringify(init.result)})
        else if (method === 'session/facts') reply({ ...${JSON.stringify(facts)}, queue: ${mode === 'queued-late' ? "[{ uuid: ids[1], value: 'second', mode: 'prompt' }]" : '[]'} })
        else if (method === 'queue/add') {
          ids.push(params.id); reply({ accepted: true })
          if (ids.length === 1) row({ ...${JSON.stringify(turnRow)}, turn: 1, turn_id: 'turn-1', message_ids: [params.id] })
          if (ids.length !== 2) return
          const second = () => { row({ ...${JSON.stringify(turnRow)}, seq: 5, turn: 2, turn_id: 'turn-2', message_ids: [params.id] }); row({ ...${JSON.stringify(outcome)}, seq: 6, turn: 2, turn_id: 'turn-2', answer: 'second' }) }
          if (${JSON.stringify(mode)} === 'folded') { row({ ...${JSON.stringify(textRow)}, in_reply_to: [{ id: params.id, at: '2000-01-01T00:00:01.000Z' }] }); row({ ...${JSON.stringify(outcome)}, turn: 1, turn_id: 'turn-1', answer: 'Folded answer.' }) }
          else if (${JSON.stringify(mode)} === 'queued') { row({ ...${JSON.stringify(outcome)}, turn: 1, turn_id: 'turn-1', answer: 'first' }); second() }
          else if (${JSON.stringify(mode)} === 'queued-late') { row({ ...${JSON.stringify(outcome)}, turn: 1, turn_id: 'turn-1', answer: 'first' }); setTimeout(second, 300) }
          else row({ ...${JSON.stringify(outcome)}, turn: 1, turn_id: 'turn-1', status: 'interrupted' })
        }
      })
    `, '--']
    for (const mode of ['folded', 'queued', 'queued-late', 'swallowed'] as const) {
      const session = await sdk.connect({ mercury: midTurnFixture(mode) })
      try {
        await assert.rejects(session.prompt('slow', { timeoutMs: 50 }), /prompt: no answer within 50 ms/)
        const started = performance.now()
        const second = session.prompt('second', { timeoutMs: 15000 })
        if (mode === 'swallowed') {
          await assert.rejects(second, (error: unknown) => error instanceof sdk.MercuryError && error.message === 'prompt: turn 1 ended interrupted and the runner holds this prompt neither queued nor in a turn; a prompt sent while a turn runs can be folded into that turn, so interrupt() it or await its outcome before prompting again')
          const elapsed = performance.now() - started
          assert(elapsed >= 4500 && elapsed < 9000, `the swallowed prompt was rejected after ${elapsed.toFixed(0)} ms, not within the grace`)
        } else {
          const row = await second
          const elapsed = performance.now() - started
          assert.equal(row.answer, mode === 'folded' ? 'Folded answer.' : 'second', mode)
          assert.equal(row.turn, mode === 'folded' ? 1 : 2, mode)
          assert(elapsed < 2000, `${mode} settled after ${elapsed.toFixed(0)} ms`)
        }
        assert.equal((await session.facts()).queue.length, mode === 'queued-late' ? 1 : 0)
      } finally { await session.close() }
    }
  })
  await check('unclaimed warm prompts fail locally within 50 ms and claim updates both identities', async () => {
    const message = 'session is unclaimed; call claim() before prompting'
    for (const open of [sdk.prewarm, (options: sdk.ConnectOptions) => sdk.connect({ ...options, warm: true })]) {
      const fixture = promptFixture(true, true)
      const session = await open({ mercury: fixture.mercury })
      try {
        assert.equal(session.initialized.session_id, null)
        for (const send of [() => session.prompt('unclaimed'), () => session.sendPrompt('unclaimed'), () => session.steer('unclaimed'), () => session.followUp('unclaimed'), () => session.send({ type: 'prompt', content: 'unclaimed' })]) {
          const start = performance.now()
          await assert.rejects(send(), error => error instanceof sdk.MercuryError && error.message === message)
          const elapsed = performance.now() - start
          assert(elapsed < 50, `an unclaimed prompt took ${elapsed} ms`)
          console.log(`PASS warm prompt refused locally in ${elapsed.toFixed(2)} ms`)
        }
        assert.equal(fixture.received().some(row => row.method === 'queue/add'), false, 'unclaimed prompts never enter the wire queue')
        assert.equal(session.lastPromptId, undefined)
        assert.equal(session.sessionId, null)
        await assert.rejects(session.claim({ session_id: 'rejected' }), /claim rejected/)
        assert.equal(session.sessionId, null)
        const receipt = await session.claim({ session_id: 'requested-session', model: 'fixture', mode: 'default', effort: 'high', resume: false })
        assert.equal(session.sessionId, receipt.session_id)
        assert.equal(session.initialized.session_id, 'claimed-session', 'identity comes from the successful claim reply')
        assert.equal((await session.prompt('resolve', { signal: AbortSignal.timeout(500) })).answer, 'resolved')
      } finally { await session.close() }
    }
  })
  await check('row 8 fixture builders return valid rows', async () => {
    const rows = [testing.fixtureSessionRow(), ...testing.fixtureTurn({ answer: 'fixture works' })]
    const fixture = await testing.startFixtureServer({ rows })
    try { assert.equal((await sdk.run({ mercury: fixture.mercury }).outcome).answer, 'fixture works') }
    finally { await fixture.close() }
  })
  await check('row 8 malformed fixture rows fail at setup', async () => {
    let server: Awaited<ReturnType<typeof testing.startFixtureServer>> | undefined
    try { await assert.rejects(async () => { server = await testing.startFixtureServer({ rows: [{ type: 'outcome', status: 'completed' }] }) }, /invalid fixture row/) }
    finally { await server?.close() }
  })
  await check('row 8 malformed RPC results fail at setup', async () => {
    let server: Awaited<ReturnType<typeof testing.startFixtureServer>> | undefined
    try { await assert.rejects(async () => { server = await testing.startFixtureServer({ methods: { initialize: [{ result: { protocol: 9 } }] } }) }, /invalid fixture result/) }
    finally { await server?.close() }
  })
  await check('row 9 run flag parity', () => {
    const args = sdk.argvOf({ mercury: 'fixture', worktree: 'branch', debug: 'rpc', reasoningMode: 'enabled', briefFile: 'brief.txt', briefAddFile: 'extra.txt', replayTo: 'm1', restoreFiles: 'm2' }).args
    const mappings: Record<string, string> = { '--debug': 'debug', '--log-file': 'logFile', '--lean': 'lean', '--input': 'input', '--schema': 'schema', '--partial': 'partial', '--sovereign': 'sovereign', '--allow-sovereign': 'allowSovereign', '--budget': 'budgetUsd', '--max-time': 'maxTime', '--allowed-tools': 'allowedTools', '--toolset': 'toolset', '--block-tools': 'blockTools', '--mcp': 'mcp', '--only-mcp': 'onlyMcp', '--brief': 'brief', '--brief-add': 'briefAdd', '--mode': 'mode', '--continue': 'continue', '--resume': 'resume', '--fork': 'fork', '--ephemeral': 'ephemeral', '--model': 'model', '--advise': 'advise', '--effort': 'effort', '--agent': 'agent', '--provider-preview': 'providerPreview', '--backup-model': 'backupModel', '--project': 'project', '--config': 'config', '--session-id': 'sessionId', '--title': 'title', '--agent-defs': 'agentDefs', '--config-layers': 'configLayers', '--extension': 'extensions', '--no-commands': 'noCommands', '--worktree': 'worktree' }
    const source = readFileSync(join(root, 'sdk/src/client.ts'), 'utf8')
    for (const option of sdk.RUN_OPTIONS.filter(option => !option.hidden && !['-d', '--version', '--format'].includes(option.flag))) assert(mappings[option.flag] && source.includes(mappings[option.flag]! + '?:'), option.flag)
    for (const flag of ['--worktree', '--debug', '--reasoning-mode', '--brief-file', '--brief-add-file', '--replay-to', '--restore-files']) assert(args.includes(flag), flag)
    assert(sdk.argvOf({ mercury: 'fixture', worktree: true, debug: true }).args.includes('--worktree'))
  })
  await check('row 9 executable discovery and safe command shim', async () => {
    const script = join(scratch, 'entry.cjs')
    writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(sessionRow))});console.log(${JSON.stringify(JSON.stringify(outcome))})`)
    const shim = join(scratch, 'mercury.cmd')
    writeFileSync(shim, '@echo off\n"node" "%~dp0\\entry.cjs" %*\n')
    assert(sdk.argvOf({ env: { ...process.env, MERCURY_BIN: shim } }).args.includes(script), 'MERCURY_BIN must select the shim before launch')
    const task = sdk.run({ env: { ...process.env, MERCURY_BIN: shim }, prompt: 'quotes " & % ! | stay data' })
    assert.equal((await task.outcome).status, 'completed')
    const fallback = join(scratch, '.mercury/bin'); mkdirSync(fallback, { recursive: true })
    const binary = join(fallback, 'mercury'); writeFileSync(binary, '#!/bin/sh\nexit 0\n'); chmodSync(binary, 0o755)
    assert.equal(sdk.argvOf({ env: { HOME: scratch, PATH: '' } }).command, binary)
    const installed = sdk.argvOf({ env: { HOME: scratch, PATH: fallback }, project: '/p' })
    assert.equal(installed.command, binary, 'the command found on PATH is named in full')
    assert.deepEqual(installed.args.slice(0, 5), ['--project', '/p', 'run', '--format', 'rows'])
  })
  await check('row 9 a directory is never an executable: a directory named mercury on a PATH entry is walked past to the next rung on every platform, a directory named node is not the runtime, and MERCURY_NODE naming a directory is refused by name', () => {
    const dirs = join(scratch, 'dirs'); const pathdir = join(dirs, 'pathdir'); const home = join(dirs, 'home'); const stable = join(home, '.local', 'bin')
    for (const dir of [join(pathdir, 'mercury'), join(pathdir, 'mercury.cmd'), join(pathdir, 'node'), stable]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(stable, 'mercury'), '#!/bin/sh\nexit 0\n'); chmodSync(join(stable, 'mercury'), 0o755)
    const posix = executableOf(undefined, { HOME: home, PATH: pathdir }, scratch, 'linux')
    assert.deepEqual(posix, [join(stable, 'mercury')], `a directory named mercury on PATH is not the executable, the stable command is; got ${JSON.stringify(posix)}`)
    const windows = executableOf(undefined, { USERPROFILE: home, LOCALAPPDATA: join(dirs, 'nowhere'), PATH: pathdir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, scratch, 'win32')
    assert.deepEqual(windows, ['mercury'], `nor is a directory named mercury.cmd on Path; got ${JSON.stringify(windows)}`)
    const entry = join(dirs, 'entry.mjs'); writeFileSync(entry, '')
    assert.throws(() => executableOf(entry, { HOME: home, PATH: '', MERCURY_NODE: pathdir }), (error: unknown) => error instanceof sdk.MercuryError && error.message.includes(`MERCURY_NODE names no executable file: ${pathdir}`), 'MERCURY_NODE naming a directory is refused by name')
    assert.deepEqual(executableOf(entry, { HOME: home, PATH: pathdir }, scratch, 'linux'), ['node', entry], 'a directory named node on PATH is not the runtime: the bare name is left to the spawn')
  })
  await check('row 9 the managed install resolves to its bundle on its vendored runtime, under a path with a space and a non-ASCII letter: the Windows layout driven on this host, the POSIX layout live', async () => {
    const layout = await import('../../src/services/privateChannel/installLayout.ts')
    const templates = await import('../../scripts/release/launcherTemplates.mjs')
    const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.node
    const stub = `console.log(${JSON.stringify(JSON.stringify(sessionRow))});console.log(${JSON.stringify(JSON.stringify(outcome))})`
    const windows = join(scratch, 'win dows ü'); const profile = join(windows, 'Users', 'Dev'); const localAppData = join(profile, 'AppData', 'Local')
    const bin = join(localAppData, 'Mercury', 'bin'); const versions = join(profile, '.mercury', 'versions'); const version = join(versions, '1.0.0-beta.40')
    for (const dir of [bin, join(version, 'vendor', 'node'), join(windows, 'nodejs')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(versions, 'current.txt'), '1.0.0-beta.40\r\n')
    writeFileSync(join(version, 'mercury.mjs'), stub); writeFileSync(join(windows, 'entry.mjs'), stub)
    writeFileSync(join(version, 'mercury.cmd'), templates.cmdLauncher(templates.parseEnginesNode(engines)))
    for (const runtime of [join(version, 'vendor', 'node', 'node.exe'), join(windows, 'nodejs', 'node.exe')]) runtimeStandIn(runtime)
    writeFileSync(join(bin, 'mercury.cmd'), layout.shimContent(true)); writeFileSync(join(bin, 'mercury'), layout.shimContent(false)); writeFileSync(join(bin, 'mercury.ps1'), layout.powershellEntryContent())
    assert(readFileSync(join(bin, 'mercury.cmd'), 'utf8').includes(layout.SHIM_MARKER_FAMILY) && !/%~dp0/.test(readFileSync(join(bin, 'mercury.cmd'), 'utf8')), 'the managed shim carries its marker and no npm pattern')
    const posix = join(scratch, 'po six ü'); const home = join(posix, 'home'); const stable = join(home, '.local', 'bin'); const active = join(home, '.mercury', 'versions', '1.0.0-beta.40')
    for (const dir of [stable, join(active, 'vendor', 'node', 'bin')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, '.mercury', 'versions', 'current.txt'), '1.0.0-beta.40\n'); writeFileSync(join(active, 'mercury.mjs'), stub)
    runtimeStandIn(join(active, 'vendor', 'node', 'bin', 'node'))
    writeFileSync(join(stable, 'mercury'), layout.shimContent(false)); chmodSync(join(stable, 'mercury'), 0o755)
    process.env.SDK_WINDOWS_FIXTURE = windows; process.env.SDK_POSIX_FIXTURE = posix
    const env = { USERPROFILE: profile, LOCALAPPDATA: localAppData, PATH: ['C:\\Windows\\system32', join(windows, 'nodejs'), bin].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    const resolved = [join(version, 'vendor', 'node', 'node.exe'), join(version, 'mercury.mjs')]
    const discovered = executableOf(undefined, env, scratch, 'win32')
    assert.deepEqual(discovered, resolved, `discovery reads current.txt and runs the bundle on the vendored node.exe; got ${JSON.stringify(discovered)}`)
    for (const shim of ['mercury.cmd', 'mercury', 'mercury.ps1']) assert.deepEqual(executableOf(undefined, { ...env, MERCURY_BIN: join(bin, shim) }, scratch, 'win32'), resolved, `MERCURY_BIN=${shim} resolves the way the managed shim resolves itself`)
    assert.deepEqual(executableOf(join(version, 'mercury.cmd'), env, scratch, 'win32'), resolved, 'the versioned launcher resolves to the bundle beside it')
    const refused = (environment: Record<string, string>, pointer: string) => assert.throws(() => executableOf(undefined, environment, scratch, 'win32'), (error: Error) => error instanceof sdk.MercuryError && error.message.includes('managed command') && error.message.includes(pointer), `the refusal names ${pointer}`)
    const elsewhere = join(windows, 'elsewhere')
    refused({ ...env, MERCURY_CONFIG_DIR: elsewhere }, join(elsewhere, 'versions', 'current.txt'))
    refused({ ...env, MERCURY_VERSIONS_DIR: elsewhere }, join(elsewhere, 'current.txt'))
    refused({ ...env, MERCURY_CONFIG_DIR: elsewhere, PATH: '' }, join(elsewhere, 'versions', 'current.txt'))
    assert.deepEqual(executableOf(undefined, { ...env, MERCURY_CONFIG_DIR: elsewhere, PATH: '', LOCALAPPDATA: elsewhere }, scratch, 'win32'), ['mercury'], 'no install anywhere leaves the bare name for the spawn error and its install hint')
    assert.deepEqual(executableOf(undefined, { ...env, PATH: '' }, scratch, 'win32'), resolved, 'with PATH empty the layout still answers')
    writeFileSync(join(versions, 'current.txt'), '\r\n"1.0.0-beta.40"  \r\nprevious-line-ignored\r\n')
    assert.deepEqual(executableOf(undefined, env, scratch, 'win32'), resolved, 'current.txt is read as the shim reads it: first non-blank line, quotes stripped, trailing space trimmed')
    writeFileSync(join(versions, 'current.txt'), '..\\outside\r\n')
    refused(env, join(versions, 'current.txt'))
    writeFileSync(join(versions, 'current.txt'), '1.0.0-beta.40\r\n')
    const live = sdk.run({ mercury: executableOf(undefined, env, scratch, 'win32'), cwd: windows, prompt: 'x' })
    assert.equal((await live.outcome).status, 'completed'); assert.equal(live.command, resolved[0])
    const entry = join(windows, 'entry.mjs')
    const named = executableOf(entry, { PATH: join(windows, 'nodejs'), PATHEXT: '.COM;.EXE' }, scratch, 'win32')
    assert.equal(named[1], entry); assert.match(named[0]!, /node(\.exe)?$/i, 'node from PATH on Windows is node.exe, compared without regard to case')
    assert.equal(named[0], join(windows, 'nodejs', 'node.exe'))
    if (WINDOWS_HOST) { console.log('SKIP the POSIX layout live: this host is Windows (the Windows layout above ran live here)'); return }
    const { MERCURY_CONFIG_DIR: _config, MERCURY_HOME: _home, MERCURY_VERSIONS_DIR: _versions, ...inherited } = process.env
    const posixEnv = { ...inherited, HOME: home, PATH: `${stable}:${process.env.PATH}` }
    const expected = [join(active, 'vendor', 'node', 'bin', 'node'), join(active, 'mercury.mjs')]
    assert.deepEqual(sdk.argvOf({ env: posixEnv }).command, expected[0]); assert.deepEqual(sdk.argvOf({ env: posixEnv }).args.slice(0, 1), [expected[1]])
    assert.deepEqual(executableOf(undefined, { ...posixEnv, MERCURY_BIN: join(stable, 'mercury') }, scratch), expected, 'the POSIX managed shim resolves the way it resolves itself')
    assert.equal((await sdk.run({ env: posixEnv, cwd: home, prompt: 'x' }).outcome).status, 'completed')
  })
  await check('row 9 a JavaScript entry point runs on the runtime bundled beside it, else node', async () => {
    const entry = join(scratch, 'entry.mjs')
    writeFileSync(entry, `console.log(${JSON.stringify(JSON.stringify(sessionRow))});console.log(${JSON.stringify(JSON.stringify(outcome))})`)
    const named = sdk.argvOf({ env: { ...process.env, MERCURY_BIN: entry } })
    assert.equal(named.args[0], entry, 'MERCURY_BIN may name the entry point itself'); assert.match(named.command, /node(\.exe)?$/i)
    assert.equal((await sdk.run({ env: { ...process.env, MERCURY_BIN: entry }, prompt: 'x' }).outcome).status, 'completed')
    const runtime = join(scratch, 'vendor', 'node', ...(WINDOWS_HOST ? ['node.exe'] : ['bin', 'node'])); mkdirSync(dirname(runtime), { recursive: true })
    runtimeStandIn(runtime)
    assert.equal(sdk.argvOf({ mercury: entry }).command, runtime, 'the bundled runtime beside the entry point is preferred')
    const pinned = runtimeStandIn(join(scratch, WINDOWS_HOST ? 'pinned-node.exe' : 'pinned-node'))
    assert.equal(sdk.argvOf({ mercury: entry, env: { ...process.env, MERCURY_NODE: pinned } }).command, pinned, 'MERCURY_NODE names the runtime first, as the launchers read it')
    assert.equal((await sdk.run({ mercury: entry, prompt: 'x' }).outcome).status, 'completed')
    assert.throws(() => sdk.argvOf({ mercury: join(scratch, 'missing.mjs') }), /JavaScript entry point that does not exist/)
  })
  const child = spawn(PYTHON, [join(root, 'scripts/sdk/python-developer.py')], { env: { ...process.env, PYTHONPATH: join(root, 'sdk-py/src'), PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'inherit' })
  await check('Python developer API mirrors', async () => { assert.equal(await new Promise(r => child.once('close', r)), 0) })
  await check('discovery one layer deeper: Windows env keys are read without regard to case, the Homebrew wrapper resolves to the keg bundle on its vendored node, a relative executable with a slash binds to cwd, a missing MERCURY_NODE refuses by name', async () => {
    const deeper = join(scratch, 'deeper'); mkdirSync(deeper, { recursive: true })
    const stub = `console.log(${JSON.stringify(JSON.stringify(sessionRow))});console.log(${JSON.stringify(JSON.stringify(outcome))})`
    const hermetic = { HOME: deeper, PATH: '' }
    const npm = join(deeper, 'npm'); mkdirSync(npm)
    writeFileSync(join(npm, 'entry.cjs'), stub); writeFileSync(join(npm, 'mercury.cmd'), '@echo off\n"node" "%~dp0\\entry.cjs" %*\n'); runtimeStandIn(join(npm, 'node.exe'))
    const spread = { UserProfile: deeper, Path: ['C:\\Windows\\system32', npm].join(';'), Pathext: '.COM;.EXE;.BAT;.CMD' }
    const viaShim = [join(npm, 'node.exe'), join(npm, 'entry.cjs')]
    assert.deepEqual(executableOf(undefined, spread, deeper, 'win32'), viaShim, `Path and Pathext as a spread of process.env spells them on Windows still find mercury.cmd; got ${JSON.stringify(executableOf(undefined, spread, deeper, 'win32'))}`)
    assert.deepEqual(executableOf(undefined, warmOptions({ env: spread }).env, deeper, 'win32'), viaShim, 'warmOptions spreads the env and keeps it findable')
    assert.deepEqual(executableOf(undefined, { ...spread, Mercury_Bin: join(npm, 'mercury.cmd') }, deeper, 'win32'), viaShim, 'MERCURY_BIN is read the same way')
    assert.deepEqual(executableOf(undefined, { ...spread, PATH: '' }, deeper, 'win32'), ['mercury'], 'an exact-case key wins over its other spelling')
    const entry = join(deeper, 'entry.mjs'); writeFileSync(entry, stub)
    const named = (error: unknown) => error instanceof sdk.MercuryError && error.message.includes('MERCURY_NODE names no executable file: /no/such/node')
    assert.throws(() => executableOf(entry, { ...hermetic, MERCURY_NODE: '/no/such/node' }), named, 'a pinned-but-missing MERCURY_NODE refuses by name, as the launcher does')
    assert.throws(() => executableOf(entry, { ...hermetic, mercury_node: '/no/such/node' }, deeper, 'win32'), named, 'on Windows any spelling of the key is read')
    assert.deepEqual(executableOf(entry, { ...hermetic, mercury_node: '/no/such/node' }, deeper, 'linux'), ['node', entry], 'on POSIX the keys stay case-sensitive (pinned, so a Windows host proves the POSIX rule too)')
    assert.throws(() => sdk.argvOf({ mercury: entry, env: { ...hermetic, MERCURY_NODE: '/no/such/node' } }), named, 'argvOf carries the refusal')
    assert.deepEqual(executableOf(entry, { ...hermetic, MERCURY_NODE: '' }), ['node', entry], 'an empty MERCURY_NODE is unset')
    if (WINDOWS_HOST) { console.log('SKIP the Homebrew keg and the relative executable live: this host is Windows (sh wrappers and symlinks)'); return }
    const node = Bun.which('node'); assert(node, 'node on PATH')
    const keg = join(deeper, 'brew', 'Cellar', 'mercury', '1.0.0-beta.40'); const libexec = join(keg, 'libexec'); const brewBin = join(deeper, 'brew', 'bin')
    for (const dir of [join(libexec, 'vendor', 'node', 'bin'), join(keg, 'bin'), brewBin]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(libexec, 'mercury.mjs'), stub)
    writeFileSync(join(libexec, 'mercury'), `#!/bin/sh\nexec ${JSON.stringify(node)} "$(dirname "$0")/mercury.mjs" "$@"\n`); chmodSync(join(libexec, 'mercury'), 0o755)
    writeFileSync(join(keg, 'bin', 'mercury'), `#!/bin/bash\nexec ${JSON.stringify(join(libexec, 'mercury'))} "$@"\n`); chmodSync(join(keg, 'bin', 'mercury'), 0o755)
    symlinkSync(join('..', 'Cellar', 'mercury', '1.0.0-beta.40', 'bin', 'mercury'), join(brewBin, 'mercury'))
    const prefixed = { HOME: deeper, PATH: '/usr/bin:/bin', HOMEBREW_PREFIX: join(deeper, 'brew') }
    assert.deepEqual(executableOf(undefined, { ...prefixed, PATH: '' }), ['mercury'], 'an empty PATH is a hermetic caller: the Homebrew rung is not tried')
    assert.deepEqual(executableOf(undefined, prefixed), [join(brewBin, 'mercury')], 'a keg without its vendored runtime runs through its wrapper')
    writeFileSync(join(libexec, 'vendor', 'node', 'bin', 'node'), `#!/bin/sh\nexec ${JSON.stringify(node)} "$@"\n`); chmodSync(join(libexec, 'vendor', 'node', 'bin', 'node'), 0o755)
    const bundle = [join(libexec, 'vendor', 'node', 'bin', 'node'), join(libexec, 'mercury.mjs')]
    const { HOMEBREW_COMMANDS } = await import('../../sdk/src/executable.ts') as { HOMEBREW_COMMANDS?: readonly string[] }
    assert.deepEqual(HOMEBREW_COMMANDS && [...HOMEBREW_COMMANDS], ['/opt/homebrew/bin/mercury', '/usr/local/bin/mercury', '/home/linuxbrew/.linuxbrew/bin/mercury'], 'the fixed Homebrew and Linuxbrew commands')
    assert.deepEqual(executableOf(undefined, prefixed), bundle, `on a GUI host's stripped PATH the Homebrew wrapper is found and resolved to the keg bundle on its vendored node; got ${JSON.stringify(executableOf(undefined, prefixed))}`)
    assert.deepEqual(executableOf(undefined, { ...hermetic, PATH: brewBin }), bundle, 'the wrapper found on PATH resolves the same way')
    assert.deepEqual(executableOf(join(brewBin, 'mercury'), hermetic), bundle, 'and the wrapper named outright')
    assert.deepEqual(executableOf(undefined, { ...hermetic, MERCURY_BIN: join(brewBin, 'mercury') }), bundle, 'and MERCURY_BIN naming it')
    assert.throws(() => executableOf(undefined, { ...prefixed, MERCURY_NODE: '/no/such/node' }), named, 'the MERCURY_NODE refusal holds on the discovery road')
    const { MERCURY_CONFIG_DIR: _config, MERCURY_HOME: _home, MERCURY_VERSIONS_DIR: _versions, MERCURY_BIN: _bin, ...inherited } = process.env
    const stripped = sdk.run({ env: { ...inherited, ...prefixed }, prompt: 'x' })
    assert.equal((await stripped.outcome).status, 'completed'); assert.equal(stripped.command, bundle[0])
    const homeBin = join(deeper, '.mercury', 'bin'); mkdirSync(homeBin, { recursive: true }); writeFileSync(join(homeBin, 'mercury'), '#!/bin/sh\nexit 0\n'); chmodSync(join(homeBin, 'mercury'), 0o755)
    assert.equal(executableOf(undefined, prefixed)[0], join(homeBin, 'mercury'), 'the home rungs still come before Homebrew')
    const sub = join(deeper, 'sub'); mkdirSync(sub)
    writeFileSync(join(sub, 'my-mercury'), `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(entry)} "$@"\n`); chmodSync(join(sub, 'my-mercury'), 0o755)
    assert.notEqual(process.cwd(), sub)
    assert.deepEqual(executableOf('./my-mercury', hermetic, sub), [join(sub, 'my-mercury')], `a relative executable with a slash is bound to cwd before the spawn; got ${JSON.stringify(executableOf('./my-mercury', hermetic, sub))}`)
    assert.deepEqual(executableOf('./my-mercury', hermetic, sub, 'win32'), [join(sub, 'my-mercury')], 'on every platform')
    assert.deepEqual(executableOf('my-mercury', hermetic, sub), ['my-mercury'], 'a bare name is left to the PATH search of the spawn')
    const relative = sdk.run({ mercury: './my-mercury', cwd: sub, env: { ...inherited, ...hermetic }, prompt: 'x' })
    assert.equal((await relative.outcome).status, 'completed'); assert.equal(relative.command, join(sub, 'my-mercury'))
  })
} finally { clearTimeout(guard); rmSync(scratch, { recursive: true, force: true }) }
await check('item 9 propertyNames validation and reasoning_output_tokens fold on interruptedOutcome', async () => {
  const { interruptedOutcome } = await import('../../sdk/src/client.ts')
  assert.deepEqual(sdk.validate({ type: 'object', propertyNames: { enum: ['a', 'b'] } }, { a: 1, c: 2 }), [{ path: 'c', message: 'expected one of "a", "b", found "c"' }])
  assert.deepEqual(sdk.validate({ type: 'object', propertyNames: { minLength: 2 } }, { ok: 1, x: 2 }), [{ path: 'x', message: 'string too short' }])
  const [turn] = testing.fixtureTurn({ session_id: 's', turn: 1, turn_id: 't1' })
  const step1: sdk.StepRow = { type: 'step', seq: 2, timestamp: '2000-01-01T00:00:00.000Z', session_id: 's', message_id: 'm1', model: 'm', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 12 } }
  const step2: sdk.StepRow = { type: 'step', seq: 3, timestamp: '2000-01-01T00:00:00.000Z', session_id: 's', message_id: 'm2', model: 'm', usage: { input_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 18 } }
  const folded = interruptedOutcome([testing.fixtureSessionRow({ session_id: 's' }), { ...turn, seq: 1 }, step1, step2], 0, 1000)
  assert.equal(folded.usage.reasoning_output_tokens, 30)
  assert.equal(folded.models.m?.reasoning_output_tokens, 30)
  const asks = [
    { jsonrpc: '2.0', id: 70, method: 'not/a_method', params: {} },
    { jsonrpc: '2.0', id: 71, method: 'fs/read_text_file', params: { path: '/x' } },
    { jsonrpc: '2.0', id: 72, method: 'permission/request', params: { kind: 'tool', tool_use_id: 'u', tool_name: 'Read', input: {} } },
  ]
  const fixture = await testing.startFixtureServer({ validate: false, methods: { initialize: [init], 'session/facts': [{ result: {}, before: asks }] } })
  try {
    const session = await sdk.connect({ mercury: fixture.mercury, onPermissionRequest: (() => ({ outcome: 'wrong' })) as any })
    try { await session.facts() } finally { await session.close() }
    assert.equal((fixture.received.find(m => m.id === 70)?.error as any)?.message, 'unknown host method not/a_method')
    assert.equal((fixture.received.find(m => m.id === 71)?.error as any)?.message, 'no handler for fs/read_text_file')
    assert(String((fixture.received.find(m => m.id === 72)?.error as any)?.message).startsWith('invalid host answer: '))
  } finally { await fixture.close() }
})
if (failures) process.exitCode = 1
