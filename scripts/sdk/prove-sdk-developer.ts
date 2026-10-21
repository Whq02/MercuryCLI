import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
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
const outcome = { ...example(sdk.ROW_SCHEMAS.outcome), status: 'completed', answer: 'ok' }
const init = { result: { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 'fixture-session' } }
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + String(error)) }
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
  await check('rows 3 and 5 checkpoint opt out and identity validation', async () => {
    const fixture = await testing.startFixtureServer({ methods: { initialize: [init] } })
    const session = await sdk.connect({ mercury: fixture.mercury, checkpointFiles: false })
    try { assert(!session.child.spawnargs.includes('--session-id')) } finally { await session.close(); await fixture.close() }
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
  await check('row 6 prompt validation is local and sends no schema field', async () => {
    const fixture = await testing.startFixtureServer({ methods: { initialize: [init], 'queue/add': [{ result: { accepted: true }, after: [{ jsonrpc: '2.0', method: 'row', params: { ...outcome, structured: { count: 'bad' } } }] }] } })
    const session = await sdk.connect({ mercury: fixture.mercury })
    try { await assert.rejects(session.prompt('test', { schema: { type: 'object', properties: { count: { type: 'integer' } } } }), e => e instanceof Error && e.name === 'MercurySchemaError'); assert(!('schema' in (fixture.received.find(r => r.method === 'queue/add')!.params as object))) }
    finally { await session.close(); await fixture.close() }
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
    assert.equal(installed.command, 'mercury')
    assert.deepEqual(installed.args.slice(0, 5), ['--project', '/p', 'run', '--format', 'rows'])
  })
  const child = spawn('python3', [join(root, 'scripts/sdk/python-developer.py')], { env: { ...process.env, PYTHONPATH: join(root, 'sdk-py/src'), PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'inherit' })
  await check('Python developer API mirrors', async () => { assert.equal(await new Promise(r => child.once('close', r)), 0) })
} finally { clearTimeout(guard); rmSync(scratch, { recursive: true, force: true }) }
if (failures) process.exitCode = 1
