import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'engine-query-boot-'))
Object.assign(process.env, { MERCURY_CONFIG_DIR: join(scratch, 'config'), MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_GODOT_TOOLS: '1', MERCURY_GODOT_WORKERS: '1' })
delete process.env.MERCURY_GODOT_TOOLS_LITE
const { EngineJobService } = await import('../../src/services/vulcan/engine/service.js')
const { runEngineOp } = await import('../../src/services/vulcan/engine/ops.js')
const { parseEngineTreeSpec } = await import('../../src/services/vulcan/engine/frozenTree.js')
const { parseEngineMediaRequest } = await import('../../src/services/vulcan/engine/media.js')
const { liveEngines } = await import('../../src/services/vulcan/engine/spawn.js')
const { listVulcanInstances } = await import('../../src/services/vulcan/instances.js')
const { resolveVulcanClientForTest } = { resolveVulcanClientForTest: (await import('../../src/services/vulcan/vulcanClient.js')).resetVulcanClientForTest }
const { resolveGodotExecutable } = await import('../../src/services/vulcan/portabilityDoctor.js')

let checks = 0
const evidence: Array<{ label: string; value: unknown }> = []
function check(label: string, condition: unknown, value?: unknown): void {
  assert.ok(condition, `${label}${value === undefined ? '' : ': ' + JSON.stringify(value)}`)
  checks++
  console.log(`PASS ${label}`)
  if (value !== undefined) evidence.push({ label, value })
}
const git = (project: string, ...args: string[]): string => execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim()
function project(name: string, suites?: unknown[]): string {
  const dir = join(scratch, name)
  cpSync(join(import.meta.dir, 'fixtures/engine-service'), dir, { recursive: true })
  mkdirSync(join(dir, '.mercury'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(dir, 'engine-suites.json'), 'utf8')) as Record<string, unknown>
  if (suites) manifest.suites = suites
  writeFileSync(join(dir, '.mercury/engine-suites.json'), JSON.stringify(manifest))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', 'project.godot', 'engine-suites.json', '.gitignore', 'autoload', 'src', 'tests', 'shaders')
  writeFileSync(join(scratch, `${name}-message.txt`), 'The fixture project\n')
  git(dir, 'commit', '-q', '-F', join(scratch, `${name}-message.txt`))
  return dir
}
const IMPORT_MS = 1500
const PUBLISH_MS = 2500
function fakeEngine(): string {
  const script = join(scratch, 'fake-engine.ts')
  writeFileSync(script, [
    "const { mkdirSync, writeFileSync } = await import('node:fs')",
    "const { createServer } = await import('node:net')",
    "const { join } = await import('node:path')",
    'const args = process.argv.slice(2)',
    `if (args.includes('--import')) { await new Promise(resolve => setTimeout(resolve, ${IMPORT_MS})); process.exit(0) }`,
    "if (args.some(arg => arg.endsWith('driver.gd')) || !process.env.MERCURY_VULCAN_INSTANCE) { setInterval(() => {}, 1000) } else {",
    '  const launch = JSON.parse(process.env.MERCURY_VULCAN_INSTANCE)',
    `  await new Promise(resolve => setTimeout(resolve, ${PUBLISH_MS}))`,
    '  const identity = { version: 1, id: launch.id, role: launch.role, port: launch.port, pid: process.pid, projectRoot: launch.projectRoot, ownerPid: launch.ownerPid }',
    '  const server = createServer(socket => {',
    "    let buffer = ''",
    '    let authed = false',
    "    socket.on('data', data => {",
    '      buffer += data.toString()',
    '      let newline',
    "      while ((newline = buffer.indexOf('\\n')) >= 0) {",
    '        const frame = JSON.parse(buffer.slice(0, newline))',
    '        buffer = buffer.slice(newline + 1)',
    '        if (!authed) {',
    "          if (frame.op !== 'hello' || frame.token !== launch.token || frame.instance !== launch.id) { socket.destroy(); return }",
    '          authed = true',
    "          socket.write(JSON.stringify({ ok: true, result: { version: 1 }, instance: identity }) + '\\n')",
    '          continue',
    '        }',
    "        if (frame.op === 'ping') socket.write(JSON.stringify({ id: frame.id, ok: true, result: 'pong', instance: identity }) + '\\n')",
    "        else if (frame.op === 'engine_scene_tree') socket.write(JSON.stringify({ id: frame.id, ok: true, result: { name: 'FakeRoot', type: 'Node', children: [{ name: 'Bridged', type: 'Node' }] }, instance: identity }) + '\\n')",
    "        else socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: 'UNKNOWN_OP', message: 'the fake worker serves the scene tree only' }, instance: identity }) + '\\n')",
    '      }',
    '    })',
    '  })',
    "  server.listen(launch.port, '127.0.0.1', () => {",
    "    const dir = join(launch.projectRoot, '.godot', 'mercury-vulcan', launch.id)",
    '    mkdirSync(dir, { recursive: true, mode: 0o700 })',
    "    writeFileSync(join(dir, 'token'), launch.token, { mode: 0o600 })",
    "    writeFileSync(join(dir, 'instance.json'), JSON.stringify(identity), { mode: 0o600 })",
    '  })',
    '  setInterval(() => {}, 1000)',
    '}',
    '',
  ].join('\n'))
  const wrapper = join(scratch, 'fake-engine.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}
async function query(dir: string, op: string, args: Record<string, unknown>): Promise<any> {
  const text = await runEngineOp(op, args, dir)
  try { return JSON.parse(text) } catch { return { text } }
}
async function until<T>(read: () => T, ready: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (!ready(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40))
    value = read()
  }
  return value
}
function submitted<T extends object>(job: T | { refused: string }): Exclude<T, { refused: string }> {
  assert.ok(!('refused' in job), JSON.stringify(job))
  return job as Exclude<T, { refused: string }>
}
const suiteRequest = () => ({ suites: ['scene_checks'], tree: parseEngineTreeSpec('HEAD') as ReturnType<typeof parseEngineTreeSpec> & { ref: string }, native: false, capture: false, priority: 'lane-gate' as const, budgetMs: null, displayShared: false, keepTree: false, label: null })
const mediaRequest = (dir: string, kind: 'capture' | 'profile', values: Record<string, unknown>) => ({ suites: [], tree: parseEngineTreeSpec('HEAD') as ReturnType<typeof parseEngineTreeSpec> & { ref: string }, native: false, capture: false, priority: 'profile' as const, budgetMs: 120_000, displayShared: false, keepTree: false, label: null, media: parseEngineMediaRequest(kind, { tour: { script: 'res://tests/media_fixture.gd', steps: [{ name: 'front' }] }, ...values }, dir) })

const fake = fakeEngine()
const suites = project('suites', [{ name: 'scene_checks', marker: 'FIXTURE PASS', quitAfter: 1000000, timeoutMs: 120000 }])
const service = EngineJobService.for(suites, { workers: 1, executable: fake })
try {
  const first = submitted(await service.submit(suiteRequest()))
  const second = submitted(await service.submit(suiteRequest()))
  const importing = await query(suites, 'engine_scene_tree', { instance: first.id })
  check('a job in its import pass says so, naming the worker kind, instead of INSTANCE_NOT_FOUND', importing.ok === false && importing.error?.code === 'ENGINE_BOOTING' && /running its import pass; the suite worker has not booted yet/.test(importing.error.message) && importing.job?.id === first.id, importing)
  const queued = await query(suites, 'engine_scene_tree', { instance: second.id })
  check('a queued job says it is queued, with the running and queued jobs ahead of it', queued.ok === false && queued.error?.code === 'ENGINE_BOOTING' && /queued \(1 running, 0 queued ahead of it, 1 worker\(s\)\)/.test(queued.error.message), queued)
  const engine = await until(() => liveEngines().find(live => live.label === `${first.id}:scene_checks`), Boolean, 20_000)
  assert.ok(engine?.bridge, JSON.stringify(liveEngines()))
  const bridgeId = engine!.bridge!.id
  const byInstance = await query(suites, 'engine_scene_tree', { instance: bridgeId, depth: 2 })
  check('a worker whose bridge has not published yet is named as booting, with its job, instead of INSTANCE_NOT_FOUND', byInstance.ok === false && byInstance.error?.code === 'BRIDGE_BOOTING' && byInstance.error.message.includes(bridgeId) && byInstance.error.message.includes(`${first.id}:scene_checks`), byInstance)
  const byJob = await query(suites, 'engine_scene_tree', { instance: first.id, depth: 2 })
  check('the same worker asked by its job id gets the same booting answer, with the job named', byJob.ok === false && byJob.error?.code === 'BRIDGE_BOOTING' && byJob.job?.id === first.id, byJob)
  await until(() => listVulcanInstances(suites).some(row => row.id === bridgeId), Boolean, 20_000)
  const published = await query(suites, 'engine_scene_tree', { instance: first.id, depth: 2 })
  check('once the bridge publishes, the job id reaches it and the answer names the instance reached', published.ok === true && published.result?.name === 'FakeRoot' && published.instance?.id === bridgeId, published)
  const direct = await query(suites, 'engine_scene_tree', { instance: bridgeId, depth: 2 })
  check('the instance id road is unchanged', direct.ok === true && direct.result?.name === 'FakeRoot' && direct.instance?.id === bridgeId)
  const other = await query(suites, 'engine_node_get', { instance: first.id, node: '/root' })
  check('the other queries by job id reach the same bridge', other.ok === false && other.error?.code === 'UNKNOWN_OP' && other.instance?.id === bridgeId, other)
  await service.cancel(first.id)
  const cancelled = await query(suites, 'engine_scene_tree', { instance: first.id })
  check('a cancelled suite job answers that nothing runs for it', cancelled.ok === false && cancelled.error?.code === 'NO_QUERY_ROAD' && /is cancelled/.test(cancelled.error.message), cancelled)
  await service.cancel(second.id)
} finally {
  resolveVulcanClientForTest()
  await service.shutdown()
}

const media = project('media')
const mediaService = EngineJobService.for(media, { workers: 1, executable: fake })
try {
  const capture = submitted(await mediaService.submit(mediaRequest(media, 'capture', {})))
  await until(() => liveEngines().some(live => live.label === `${capture.id}:capture-single`), Boolean, 20_000)
  const noRoad = await query(media, 'engine_scene_tree', { instance: capture.id })
  check('a capture boot says it has no bridge and no debugger connection, and points at the record', noRoad.ok === false && noRoad.error?.code === 'NO_QUERY_ROAD' && /capture boot: it has no bridge and no engine debugger connection/.test(noRoad.error.message) && /engine_result/.test(noRoad.error.hint ?? ''), noRoad)
  await mediaService.cancel(capture.id)
  const projectSource = submitted(await mediaService.submit(mediaRequest(media, 'profile', { source: 'project', settleFrames: 1, sampleFrames: 2, quiet: 'flag' })))
  await until(() => liveEngines().some(live => live.label === `${projectSource.id}:profile`), Boolean, 20_000)
  const noDebugger = await query(media, 'engine_scene_tree', { instance: projectSource.id })
  check('a project-source profile boot says the same, since it opened no debugger connection', noDebugger.ok === false && noDebugger.error?.code === 'NO_QUERY_ROAD' && /project-source profile boot/.test(noDebugger.error.message), noDebugger)
  await mediaService.cancel(projectSource.id)
} finally {
  await mediaService.shutdown()
}
check('every proof-owned fake engine is gone and no instance is discoverable', liveEngines().length === 0 && listVulcanInstances(suites).length === 0 && listVulcanInstances(media).length === 0)

const executable = process.env.GODOT_BIN ? { resolved: process.env.GODOT_BIN } : await resolveGodotExecutable({ census: [] })
if (!executable.resolved) {
  console.log('SKIP real engine boot answers: no Godot executable is available')
  evidence.push({ label: 'real engine', value: 'SKIP: no Godot executable' })
} else {
  const real = project('real', [{ name: 'runtime_checks', marker: 'RUNTIME PASS', quitAfter: 1000000, timeoutMs: 120000 }])
  const realService = EngineJobService.for(real, { workers: 1, executable: executable.resolved })
  try {
    const job = submitted(await realService.submit({ ...suiteRequest(), suites: ['runtime_checks'] }))
    const early = await query(real, 'engine_scene_tree', { instance: job.id })
    check('the real job answers its stage before its worker is up', early.ok === false && (early.error?.code === 'ENGINE_BOOTING' || early.error?.code === 'BRIDGE_BOOTING'), early)
    const engine = await until(() => liveEngines().find(live => live.label === `${job.id}:runtime_checks`), Boolean, 90_000)
    assert.ok(engine?.bridge, JSON.stringify(liveEngines()))
    const atOnce = await query(real, 'engine_scene_tree', { instance: engine!.bridge!.id, depth: 2 })
    check('the real worker asked at spawn is named as booting or already answers; never the operator-editor refusal', (atOnce.ok === false && atOnce.error?.code === 'BRIDGE_BOOTING') || (atOnce.ok === true && atOnce.result?.name === 'RuntimeFixture'), atOnce)
    await until(() => listVulcanInstances(real).some(row => row.id === engine!.bridge!.id), Boolean, 60_000)
    const byJob = await query(real, 'engine_scene_tree', { instance: job.id, depth: 2 })
    check('the real worker asked by its job id answers its live tree and names the instance reached', byJob.ok === true && byJob.result?.name === 'RuntimeFixture' && byJob.instance?.id === engine!.bridge!.id, byJob)
    await realService.cancel(job.id)
  } finally {
    resolveVulcanClientForTest()
    await realService.shutdown()
    check('every proof-owned worker is gone', liveEngines().length === 0)
  }
}
writeFileSync(join(scratch, 'evidence.json'), JSON.stringify({ checks, evidence }, null, 2))
console.log(`PASS ${checks} engine query boot checks; evidence ${join(scratch, 'evidence.json')}`)
