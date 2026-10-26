import assert from 'node:assert/strict'
import ts from 'typescript'
import { execSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUN, PYTHON, resolvePython } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-build-'))
const STRICT_CONSUMER = String.raw`import { run, connect, prewarm, textBlock, imageBlock, allowPermission, denyPermission, structuredSchema, defineAgent, defineTool, serveTools, MercuryRefusal, argvOf, rowOf, parseRow, validate, isOutcome, isSessionRow, turnOpened, turnWaiting, mainThreadStep, isMainThread, outcomeFailed, outcomeErrorText, isRetryableOutcome, assertCompleted, isRowType, isInputRowType, FEATURE_FLOORS, compareVersions, parseVersion, runnerSupport, type RunnerFeature, type RunnerSupport, type StreamRow, type OutcomeRow, type SessionRow, type RunOptions, type ConnectOptions, type HostHandlers, type PermissionHandler, type ElicitationHandler, type ReadTextFileHandler, type WriteTextFileHandler, type MercuryRun, type MercurySession } from 'mercury-cli-sdk'
import { startFixtureServer } from 'mercury-cli-sdk/testing'

const descriptor = structuredSchema({ type: 'object' }, value => ({ count: (value as { count: number }).count }))
const typedRun = run({ prompt: [textBlock('hello'), imageBlock(new Uint8Array([1]), 'image/png')], schema: descriptor })
console.log((await typedRun.outcome).structured?.count satisfies number | undefined)
const floors: RunnerSupport = runnerSupport(undefined)
const feature: RunnerFeature = 'perTurnSchema'
console.log(floors.perTurnSchema satisfies boolean, floors[feature], FEATURE_FLOORS.fileCheckpoints satisfies '1.0.0-beta.41', compareVersions('1.0.0', '1.0.1') satisfies number | undefined, parseVersion('1.0.0-beta.41')?.release satisfies number[] | undefined)
const options: RunOptions = { tools: [defineTool({ name: 'echo', description: 'Echo', inputSchema: {}, execute: (_input, { signal }) => String(signal.aborted) })], debug: true, worktree: 'branch', reasoningMode: 'enabled', briefFile: 'brief.txt', briefAddFile: 'extra.txt', replayTo: 'm1', restoreFiles: 'm2', prompt: 'Explain', mode: 'default', partial: true, mercury: ['ssh', 'host', 'mercury'], schema: { type: 'object' } }
const task: MercuryRun = run(options)
task.on('text', row => process.stdout.write(row.text))
task.on('row', (row: StreamRow) => { if (row.type === 'unknown_row') console.log(row.original_type, row.seq) })
for await (const row of task) {
  if (row.type === 'tool_call') console.log(row.tool, row.input)
  if (row.type === 'outcome') console.log(row.status satisfies string)
}
const outcome: OutcomeRow = await task.outcome
console.log(outcome.status, outcome.answer ?? outcome.error?.message)
const sessionRow: SessionRow = await task.session
console.log(sessionRow.model, (await task.exit).code, argvOf(options).args)
const handlers: HostHandlers = { 'fs/write_text_file': async () => {}, 'permission/request': () => ({ outcome: 'deny', message: 'no' }) }
const connectOptions: ConnectOptions = { handlers, partial: true, checkpoints: false, schema: { type: 'object' }, onElicitation: () => ({ action: 'decline' }) }
const session: MercurySession = await connect(connectOptions)
console.log(session.fileCheckpoints?.capture satisfies boolean | undefined, session.fileCheckpoints?.source satisfies 'interactive' | 'seat' | 'initialize' | 'setting' | 'headless' | undefined, session.initialized.file_checkpoints?.source)
console.log(session.supports.perTurnSchema satisfies boolean, session.supports.fileCheckpoints satisfies boolean, session.runnerVersion satisfies string | undefined, runnerSupport(session.initialized).perTurnSchema)
try {
  console.log((await session.prompt('typed', { schema: descriptor })).structured?.count satisfies number | undefined)
  await session.steer('now'); await session.followUp('later')
  console.log(session.lastPromptId satisfies string | undefined)
  const first = await session.prompt('Inspect')
  console.log(first.status, first.denials.length)
  const facts = await session.facts()
  console.log(facts.queue, facts.usage.total_cost_usd satisfies number, facts.work?.[0]?.tool_uses, facts.file_checkpoints?.restorable)
  const rewind = await session.rewind({ user_message_id: 'id', mode: 'code' })
  console.log(rewind.code?.files_changed satisfies string[] | undefined, facts.file_checkpoints?.source satisfies 'interactive' | 'seat' | 'initialize' | 'setting' | 'headless' | undefined)
  console.log((await session.stopAgent('a')).receipt satisfies 'applied')
  const resumed = await session.resumeAgent('a')
  console.log('queued' in resumed ? resumed.queued : resumed.output_file)
  const receipt = await session.sendPrompt('more', { id: 'abc', priority: 'next' })
  console.log(receipt.accepted)
  await session.mcpTools('s'); await session.mcpAction('s', 'reconnect'); await session.pauseGate(false); await session.quiesce('prepare', 't'); await session.leave(); await session.setSpawnSwitch('subagents', true); await session.backgroundShell(); session.notifyCredentialsChanged()
  console.log(allowPermission(), denyPermission('no'), isRetryableOutcome(first), assertCompleted(first).status)
  const permHandler: PermissionHandler = () => allowPermission()
  const elicitHandler: ElicitationHandler = () => ({ action: 'decline' })
  const readHandler: ReadTextFileHandler = () => ({ content: '' })
  const writeHandler: WriteTextFileHandler = () => {}
  console.log(typeof permHandler, typeof elicitHandler, typeof readHandler, typeof writeHandler)
  await session.request('session/pause_gate', { paused: false })
  session.on('notification', n => console.log(n.method, n.params))
} catch (error) {
  if (error instanceof MercuryRefusal) console.log(error.outcome?.status, error.errorClass, error.detail, error.code)
} finally { await session.close() }
const tools = await serveTools([defineTool({ name: 'greeting', description: 'Return a greeting', inputSchema: { type: 'object', properties: {} }, execute: () => 'Hello' }), defineTool({ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: (input: { text: string }) => ({ content: [{ type: 'text', text: input.text }] }) })])
try {
  const agent = defineAgent({ description: 'Reviewer', prompt: 'Review.', tools: ['Read'] })
  console.log(run({ prompt: 'Review', agent: 'reviewer', agentDefs: { reviewer: agent }, mcp: [tools.mcp] }).args)
} finally { await tools.close() }
const fixture = await startFixtureServer({ rows: task.rows })
try { console.log((await run({ mercury: fixture.mercury, prompt: 'test' }).outcome).status, fixture.received.length) } finally { await fixture.close() }
const read = parseRow('{}')
if (read.ok) {
  console.log(read.row.type, isMainThread(read.row), isOutcome(read.row), isSessionRow(read.row), turnOpened(read.row), turnWaiting(read.row), mainThreadStep(read.row))
  if (isOutcome(read.row)) console.log(outcomeFailed(read.row), outcomeErrorText(read.row))
}
else console.log(read.reason, read.issues)
console.log(rowOf({ type: 'x' }).ok, validate({ type: 'string' }, 1), isRowType('session'), isInputRowType('prompt'))
await using disposable = await connect()
console.log(disposable.initialized.protocol)
`
const command = (cmd: string, args: string[], cwd: string, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 180000 })
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result.stdout
}
try {
  for (const dir of ['sdk', 'sdk-py']) cpSync(join(root, dir), join(scratch, dir), { recursive: true, filter: path => !/[\\/](dist|node_modules|__pycache__)([\\/]|$)/.test(path) })
  const pkg = JSON.parse(readFileSync(join(scratch, 'sdk/package.json'), 'utf8'))
  assert.equal(pkg.name, 'mercury-cli-sdk'); assert.equal(pkg.version, '0.1.0'); assert.equal(pkg.license, 'Apache-2.0'); assert.notEqual(pkg.private, true)
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0)
  assert(pkg.exports['./testing'].types)
  symlinkSync(join(root, 'node_modules'), join(scratch, 'sdk/node_modules'), 'junction')
  command('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'sdk/tsconfig.json')], scratch)
  execSync(pkg.scripts.build.split(' && ')[1], { cwd: join(scratch, 'sdk'), stdio: 'inherit' })
  rmSync(join(scratch, 'sdk/node_modules'))
  const docLead = '/' + '** '
  for (const [file, symbols] of [['index.d.ts', ['run', 'connect', 'prewarm', 'defineTool']], ['client.d.ts', ['run', 'MercuryRun', 'RunOptions']], ['runner.d.ts', ['connect', 'prewarm', 'MercurySession']]] as const) {
    const dts = readFileSync(join(scratch, 'sdk/dist', file), 'utf8')
    for (const sym of symbols) assert(dts.includes(docLead) && new RegExp(`\\/\\*\\* .+ \\*\\/\\nexport (?:\\{ (?:type )?${sym} \\}|(?:declare (?:function|class)|interface) ${sym}\\b)`).test(dts), `${file} missing JSDoc on ${sym}`)
  }
  for (const name of readdirSync(join(root, 'sdk/src')).filter(n => n.endsWith('.ts'))) assert(!readFileSync(join(root, 'sdk/src', name), 'utf8').includes(docLead), `sdk/src/${name} must carry no JSDoc comment bytes`)
  const retryableDoc = /\/\*\* ([^\n]*)\*\/\nexport declare const isRetryableOutcome\b/.exec(readFileSync(join(scratch, 'sdk/dist/parse.d.ts'), 'utf8'))
  assert(retryableDoc, 'parse.d.ts carries JSDoc on isRetryableOutcome')
  const documentedClasses = /\(([^)]*)\)/.exec(retryableDoc[1]!)?.[1]?.split(/,\s*|\s+or\s+/).map(word => word.trim()).filter(Boolean).sort() ?? []
  const retryableClasses = command('node', ['--input-type=module', '-e', `import {isRetryableOutcome,ERROR_CLASSES} from ${JSON.stringify(join(scratch, 'sdk/dist/index.js'))}; console.log(JSON.stringify(ERROR_CLASSES.filter(c => isRetryableOutcome({ type: 'outcome', status: 'failed', error: { message: 'x', class: c } })).sort()))`], scratch).trim()
  assert.deepEqual(documentedClasses, JSON.parse(retryableClasses), `the JSDoc on isRetryableOutcome names the classes the built function treats as retryable: ${retryableDoc[1]}`)
  const pythonRetryable = command(PYTHON, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(scratch, 'sdk-py/src'))}); import json, mercury_cli_sdk as s; from mercury_cli_sdk.parse import is_retryable_outcome; print(json.dumps(sorted(c for c in s.ERROR_CLASSES if is_retryable_outcome({'type': 'outcome', 'status': 'failed', 'error': {'message': 'x', 'class': c}})), separators=(',', ':')), (is_retryable_outcome.__doc__ or '').replace(chr(10), ' '))`], scratch, { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }).trim()
  assert.equal(pythonRetryable.split(' ', 1)[0], retryableClasses, 'the Python package treats the same classes as retryable')
  const pythonDocClasses = /\(([^)]*)\)/.exec(pythonRetryable.slice(retryableClasses.length))?.[1]?.split(/,\s*|\s+or\s+/).map(word => word.trim()).filter(Boolean).sort() ?? []
  assert.deepEqual(pythonDocClasses, JSON.parse(retryableClasses), `the is_retryable_outcome docstring names the same classes: ${pythonRetryable}`)
  const loaded = command('node', ['--input-type=module', '-e', `import {run,connect,ROW_TYPES} from ${JSON.stringify(join(scratch, 'sdk/dist/index.js'))}; if(typeof run!=='function'||typeof connect!=='function'||!ROW_TYPES.length)process.exit(1)`], scratch)
  for (const name of readdirSync(join(scratch, 'sdk/src')).filter(n => n.endsWith('.ts'))) {
    assert(readdirSync(join(scratch, 'sdk/dist')).includes(name.replace('.ts', '.d.ts')))
    const declaration = ts.createSourceFile(name, readFileSync(join(scratch, 'sdk/dist', name.replace('.ts', '.d.ts')), 'utf8'), ts.ScriptTarget.Latest, true)
    const checkType = (node: ts.Node): void => {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${name} exports any in its declarations`)
      ts.forEachChild(node, checkType)
    }
    checkType(declaration)
    const source = readFileSync(join(scratch, 'sdk/dist', name.replace('.ts', '.js')), 'utf8')
    for (const m of source.matchAll(/from ['"]([^'"]+)['"]/g)) assert(m[1]!.startsWith('node:') || m[1]!.startsWith('./'), m[1])
  }
  const pyright = [join(root, 'vendor/pyright/extracted/index.js'), join(root, 'vendor/pyright/index.js')].find(existsSync)
  assert(pyright, 'the vendored Python type checker must be installed')
  command('node', [pyright, '--pythonversion', '3.11', '--level', 'error', join(scratch, 'sdk-py/src/mercury_cli_sdk')], scratch)
  cpSync(join(root, 'scripts/sdk/python-types.py'), join(scratch, 'consumer.py'))
  writeFileSync(join(scratch, 'pyrightconfig.json'), JSON.stringify({ extraPaths: [join(scratch, 'sdk-py/src')], include: ['consumer.py'], pythonVersion: '3.11' }))
  command('node', [pyright, '--project', join(scratch, 'pyrightconfig.json'), '--level', 'error'], scratch)
  console.log('PASS Python consumer types: session/exit futures, fifteen convenience methods and generated constants')
  cpSync(join(root, 'scripts/sdk/python-strict.py'), join(scratch, 'strict.py'))
  writeFileSync(join(scratch, 'pyrightconfig.json'), JSON.stringify({ extraPaths: [join(scratch, 'sdk-py/src')], include: ['strict.py'], pythonVersion: '3.11', typeCheckingMode: 'strict' }))
  command('node', [pyright, '--project', join(scratch, 'pyrightconfig.json')], scratch)
  console.log('PASS a pyright-strict consumer of the whole public Python surface reports nothing')
  cpSync(join(root, 'scripts/sdk/python-strict-negative.py'), join(scratch, 'negative.py'))
  writeFileSync(join(scratch, 'pyrightconfig.json'), JSON.stringify({ extraPaths: [join(scratch, 'sdk-py/src')], include: ['negative.py'], pythonVersion: '3.11', typeCheckingMode: 'strict' }))
  const negative = spawnSync('node', [pyright, '--project', join(scratch, 'pyrightconfig.json')], { cwd: scratch, encoding: 'utf8', timeout: 180000 })
  assert.equal(negative.status, 1, negative.stdout)
  for (const expected of ['"Literal[\'yolo\']" cannot be assigned to parameter "mode"', 'No overloads for "run" match', 'No parameter named "prompt"', '"Literal[\'extreme\']" cannot be assigned to parameter "effort"', 'No parameter named "warm"', 'cannot be assigned to parameter "max_turns"', 'cannot be assigned to parameter "mercury"']) assert(negative.stdout.includes(expected), `pyright must report ${expected}:\n${negative.stdout}`)
  assert(negative.stdout.includes('7 errors'), negative.stdout)
  command(PYTHON, [join(scratch, 'negative.py')], scratch, { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(scratch, 'sdk-py/src') })
  assert.equal(BUN, process.execPath)
  if (process.platform !== 'win32') {
    const fakeBin = join(scratch, 'fake-bin'); mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(fakeBin, 'python3'), '#!/bin/sh\nexit 9009\n'); chmodSync(join(fakeBin, 'python3'), 0o755)
    writeFileSync(join(fakeBin, 'python'), '#!/bin/sh\nexit 0\n'); chmodSync(join(fakeBin, 'python'), 0o755)
    assert.equal(resolvePython({ ...process.env, PATH: fakeBin }), 'python')
  }
  console.log('PASS pyright strict refuses seven wrong keyword options on run, run_sync, connect, connect_sync and prewarm')
  mkdirSync(join(scratch, 'consumer/node_modules'), { recursive: true })
  cpSync(join(scratch, 'sdk'), join(scratch, 'consumer/node_modules/mercury-cli-sdk'), { recursive: true, filter: p => !/[\\/]src[\\/]/.test(p) })
  symlinkSync(join(root, 'node_modules/@types'), join(scratch, 'consumer/node_modules/@types'), 'junction')
  symlinkSync(join(root, 'node_modules/undici-types'), join(scratch, 'consumer/node_modules/undici-types'), 'junction')
  writeFileSync(join(scratch, 'consumer/package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(scratch, 'consumer/consumer.ts'), STRICT_CONSUMER)
  for (const resolution of ['Node16', 'NodeNext', 'Bundler']) {
    writeFileSync(join(scratch, 'consumer/tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: resolution === 'Bundler' ? 'ESNext' : resolution, moduleResolution: resolution, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true }, files: ['consumer.ts'] }))
    command('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'consumer/tsconfig.json')], scratch)
  }
  console.log('PASS a strict TypeScript consumer of the whole public surface compiles under Node16, NodeNext and Bundler with exactOptionalPropertyTypes')
  command(PYTHON, ['-I', '-S', join(scratch, 'sdk-py/build_backend.py'), join(scratch, 'artifacts')], scratch)
  const wheel = readdirSync(join(scratch, 'artifacts')).find(f => f.endsWith('.whl'))!
  command(PYTHON, ['-I', '-S', '-c', `import sys,zipfile;from typing import NotRequired;sys.path.insert(0,${JSON.stringify(join(scratch, 'artifacts', wheel))});import mercury_cli_sdk as s;assert s.__version__=='0.1.0';assert len(s.ROW_SCHEMAS)==25;assert callable(s.connect_sync);assert s.is_row_type('session') and not s.is_row_type('nope');assert s.is_input_row_type('prompt') and not s.is_input_row_type('session');assert s.is_outcome({'type':'outcome'}) and s.is_session_row({'type':'session'}) and s.turn_opened({'type':'turn','state':'started'}) and s.turn_waiting({'type':'turn','state':'waiting'}) and s.main_thread_step({'type':'step'});assert s.outcome_failed({'status':'failed'}) and s.outcome_error_text({'status':'failed','error':{'message':'m'}})=='m';assert s.define_tool('t','d',{'q':str,'n':NotRequired[int]},lambda _:'ok').input_schema['required']==['q'];z=zipfile.ZipFile(sys.path[0]);assert 'mercury_cli_sdk/py.typed' in z.namelist();assert b'Requires-Dist:' not in z.read('mercury_cli_sdk-0.1.0.dist-info/METADATA')`], scratch)
  const sdist = readdirSync(join(scratch, 'artifacts')).find(f => f.endsWith('.tar.gz'))!
  mkdirSync(join(scratch, 'unpack'))
  command(PYTHON, ['-I', '-S', '-c', `import tarfile;tarfile.open(${JSON.stringify(join(scratch, 'artifacts', sdist))}).extractall(${JSON.stringify(join(scratch, 'unpack'))},**({'filter':'data'} if hasattr(tarfile,'data_filter') else {}))`], scratch)
  command(PYTHON, ['-I', '-S', join(scratch, 'unpack/mercury_cli_sdk-0.1.0/build_backend.py'), join(scratch, 'rebuilt')], scratch)
  assert.deepEqual(readFileSync(join(scratch, 'artifacts', wheel)), readFileSync(join(scratch, 'rebuilt', wheel)))
  assert(!loaded.includes('error'))
  console.log('PASS clean-copy TypeScript build; dependency-free Node import; Python stdlib-only wheel, sdist and identical rebuild; py.typed')
} finally { rmSync(scratch, { recursive: true, force: true }) }
