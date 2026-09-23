import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'engine-scene-tree-'))
Object.assign(process.env, { MERCURY_CONFIG_DIR: join(scratch, 'config'), MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_GODOT_TOOLS: '1', MERCURY_GODOT_WORKERS: '1' })
delete process.env.MERCURY_GODOT_TOOLS_LITE
const { decodeGodotSceneTree, findGodotSceneTreeNode, viewGodotSceneTree } = await import('../../src/services/vulcan/engine/debuggerProfile.js')
const { EngineJobService } = await import('../../src/services/vulcan/engine/service.js')
const { runEngineOp } = await import('../../src/services/vulcan/engine/ops.js')
const { parseEngineTreeSpec } = await import('../../src/services/vulcan/engine/frozenTree.js')
const { parseEngineMediaRequest } = await import('../../src/services/vulcan/engine/media.js')
const { liveEngines } = await import('../../src/services/vulcan/engine/spawn.js')
const { resolveGodotExecutable } = await import('../../src/services/vulcan/portabilityDoctor.js')
const { GodotTool } = await import('../../src/tools/GodotTool/GodotTool.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

let checks = 0
const evidence: Array<{ label: string; value: unknown }> = []
function check(label: string, condition: unknown, value?: unknown): void {
  assert.ok(condition, `${label}${value === undefined ? '' : ': ' + JSON.stringify(value)}`)
  checks++
  console.log(`PASS ${label}`)
  if (value !== undefined) evidence.push({ label, value })
}
const CAPTURED_TREE: unknown[] = [2, 'root', 'Window', 25887245740, '', 0, 0, 'Events', 'res://autoload/events.gd', 26407339447, '', 0, 1, 'RuntimeFixture', 'res://tests/runtime_checks.gd', 26910655930, 'res://tests/runtime_checks.tscn', 0, 0, 'Probe', 'Node', 26927433148, '', 0]

const tree = decodeGodotSceneTree(CAPTURED_TREE)
check('the captured Godot 4.6.1 answer decodes depth first: a Window root with two children', tree.name === 'root' && tree.type === 'Window' && tree.id === 25887245740 && tree.children.map(n => n.name).join(',') === 'Events,RuntimeFixture')
check('a scripted node carries its script path, an instanced node its scene, an engine node its class', tree.children[0]!.script === 'res://autoload/events.gd' && tree.children[0]!.type === undefined && tree.children[1]!.scene === 'res://tests/runtime_checks.tscn' && tree.children[1]!.children[0]!.type === 'Node' && tree.children[1]!.children[0]!.scene === undefined)
check('a global class name reads as the type and the view flags read as visibility', (() => {
  const named = decodeGodotSceneTree([1, 'root', 'Window', 1, '', 0, 0, 'Hero', 'Player', 2, '', 3])
  const hidden = decodeGodotSceneTree([0, 'Hero', 'Sprite2D', 5, '', 1])
  const plain = decodeGodotSceneTree([0, 'Hero', 'Sprite2D', 5, '', 0])
  return named.children[0]!.type === 'Player' && named.children[0]!.visible === true && hidden.visible === false && plain.visible === undefined
})())
for (const [label, data, words] of [
  ['a node short of its six values', [2, 'root', 'Window', 1, ''], /6 values per node/],
  ['a child count the values cannot fill', [1, 'root', 'Window', 1, '', 0], /truncated/],
  ['values left after the tree', [0, 'root', 'Window', 1, '', 0, 0, 'x', 'Node', 2, '', 0], /trailing values/],
  ['a name that is not a string', [0, 7, 'Window', 1, '', 0], /name must be a string/],
  ['an id that is not an integer', [0, 'root', 'Window', 1.5, '', 0], /id must be an integer/],
] as const) {
  assert.throws(() => decodeGodotSceneTree([...data]), words)
  check(`${label} refuses with words`, true)
}
const shallow = viewGodotSceneTree(tree, 1)
check('the view cuts at the depth, counts the children it leaves out, and reads at least one level as the bridge does', shallow.children!.length === 2 && shallow.children![1]!.children === undefined && shallow.children![1]!.children_count === 1 && viewGodotSceneTree(tree, 0).children!.length === 2)
check('a root path resolves from /root, absolute or relative, and a missing path is null', findGodotSceneTreeNode(tree, '/root/RuntimeFixture/Probe')?.name === 'Probe' && findGodotSceneTreeNode(tree, 'RuntimeFixture')?.name === 'RuntimeFixture' && findGodotSceneTreeNode(tree, '')?.name === 'root' && findGodotSceneTreeNode(tree, '/root')?.name === 'root' && findGodotSceneTreeNode(tree, 'Nowhere') === null)
check('a large object id survives as a decimal string in the view', viewGodotSceneTree(decodeGodotSceneTree([0, 'root', 'Window', 9007199254740993n, '', 0])).id === '9007199254740993')

const git = (project: string, ...args: string[]): string => execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim()
function project(name: string): string {
  const dir = join(scratch, name)
  cpSync(join(import.meta.dir, 'fixtures/engine-service'), dir, { recursive: true })
  mkdirSync(join(dir, '.mercury'), { recursive: true })
  cpSync(join(dir, 'engine-suites.json'), join(dir, '.mercury/engine-suites.json'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', 'project.godot', 'engine-suites.json', '.gitignore', 'autoload', 'src', 'tests', 'shaders')
  writeFileSync(join(scratch, `${name}-message.txt`), 'The fixture project\n')
  git(dir, 'commit', '-q', '-F', join(scratch, `${name}-message.txt`))
  return dir
}
function fakeEngine(name: string, connectAfterMs: number): string {
  const script = join(scratch, `${name}.ts`)
  writeFileSync(script, [
    `const transportModule = ${JSON.stringify(join(root, 'src/services/vulcan/engine/debuggerTransport.ts'))}`,
    `const tree = ${JSON.stringify(CAPTURED_TREE)}`,
    "const { readFileSync } = await import('node:fs')",
    "const { connect } = await import('node:net')",
    'const args = process.argv.slice(2)',
    "if (args.includes('--import')) process.exit(0)",
    "const at = args.indexOf('--remote-debug')",
    'if (at < 0) { setInterval(() => {}, 1000) } else {',
    '  const { encodeGodotPacket, GodotPacketDecoder } = await import(transportModule)',
    "  const config = JSON.parse(readFileSync(args[args.indexOf('--') + 1], 'utf8'))",
    "  const port = Number(/:(\\d+)$/.exec(args[at + 1])[1])",
    '  setTimeout(() => {',
    "    const socket = connect(port, '127.0.0.1')",
    '    const decoder = new GodotPacketDecoder()',
    "    socket.on('connect', () => {",
    "      socket.write(encodeGodotPacket(['set_pid', 1, [process.pid]]))",
    "      socket.write(encodeGodotPacket(['mercury_profile:hello', 1, [config.debuggerConnection.token, { major: 4, minor: 6, patch: 1, hex: 263681, status: 'stable', build: 'official', hash: 'fixture', timestamp: 0, string: '4.6.1-stable (official)' }]]))",
    '    })',
    "    socket.on('data', bytes => decoder.push(bytes, message => {",
    "      if (Array.isArray(message) && message[0] === 'scene:request_scene_tree') socket.write(encodeGodotPacket(['scene:scene_tree', 1, tree]))",
    '    }))',
    `  }, ${connectAfterMs})`,
    '  setInterval(() => {}, 1000)',
    '}',
    '',
  ].join('\n'))
  const wrapper = join(scratch, `${name}.sh`)
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}
const tour = { script: 'res://tests/debugger_hot.gd', steps: [{ name: 'steady' }] }
const profileRequest = (dir: string, values: Record<string, unknown>) => ({ suites: [], tree: parseEngineTreeSpec('HEAD') as ReturnType<typeof parseEngineTreeSpec> & { ref: string }, native: false, capture: false, priority: 'profile' as const, budgetMs: 120_000, displayShared: false, keepTree: false, label: null, media: parseEngineMediaRequest('profile', { tour, source: 'engine', settleFrames: 1, sampleFrames: 2, quiet: 'flag', ...values }, dir) })
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

check('no engine service is created by looking for one', EngineJobService.peek(join(scratch, 'never')) === undefined)
const prompt = project('prompt')
const stray = await query(prompt, 'engine_scene_tree', { instance: 'no-such-instance' })
check('an instance no job and no engine knows still answers the bridge road refusal', stray.ok === false && stray.error?.code === 'INSTANCE_NOT_FOUND', stray)

const fixture = project('fixture')
const service = EngineJobService.for(fixture, { workers: 1, executable: fakeEngine('connects-now', 0) })
try {
  const job = submitted(await service.submit(profileRequest(fixture, {})))
  const road = await until(() => service.queryRoad(job.id), r => r?.kind === 'debugger' || r?.kind === 'none', 20_000)
  check('a running profile job whose worker said hello over the debugger has the debugger road', road?.kind === 'debugger', road && { kind: road.kind, state: road.job.state })
  const answer = await query(fixture, 'engine_scene_tree', { instance: job.id, depth: 2 })
  check('the scene tree is read over the engine debugger by the job id, naming the job, the source and the port', answer.ok === true && answer.job === job.id && answer.source === 'engine debugger' && Number.isInteger(answer.port) && answer.result?.name === 'root' && answer.result.type === 'Window' && answer.result.children?.map((n: any) => n.name).join(',') === 'Events,RuntimeFixture' && answer.result.children[1].children?.[0]?.name === 'Probe' && answer.result.children[1].children[0].children === undefined, answer)
  const sub = await query(fixture, 'engine_scene_tree', { instance: job.id, root: '/root/RuntimeFixture', depth: 3 })
  check('a root path narrows the answer to that subtree', sub.ok === true && sub.result?.name === 'RuntimeFixture' && sub.result.script === 'res://tests/runtime_checks.gd' && sub.result.scene === 'res://tests/runtime_checks.tscn' && sub.result.children?.[0]?.name === 'Probe', sub)
  const relative = await query(fixture, 'engine_scene_tree', { instance: job.id, root: 'RuntimeFixture/Probe' })
  check('a relative root path resolves from the root window', relative.ok === true && relative.result?.name === 'Probe' && relative.result.children === undefined, relative)
  const missing = await query(fixture, 'engine_scene_tree', { instance: job.id, root: 'Nowhere' })
  check('a root path no node answers to is named with the root children', missing.ok === false && missing.error?.code === 'NODE_NOT_FOUND' && /Events, RuntimeFixture/.test(missing.error.hint ?? ''), missing)
  const pair = await Promise.all([query(fixture, 'engine_scene_tree', { instance: job.id, depth: 1 }), query(fixture, 'engine_scene_tree', { instance: job.id, depth: 1 })])
  check('two queries in flight at once both answer', pair.every(a => a.ok === true && a.result?.name === 'root'))
  for (const [op, args] of [['engine_node_get', { node: '/root', properties: ['name'] }], ['engine_signal_wait', { node: '/root', signal: 'ready', timeout_ms: 10 }]] as const) {
    const refused = await query(fixture, op, { instance: job.id, ...args })
    check(`${op} by a profile job id says only the scene tree crosses the debugger`, refused.ok === false && refused.error?.code === 'NOT_OVER_DEBUGGER' && refused.job?.id === job.id, refused)
  }
  const viaTool = (await runWithCwdOverride(fixture, () => GodotTool.call({ op: 'engine_scene_tree', args: { instance: job.id, depth: 1 } } as never, {} as never, {} as never, {} as never))) as { data: { result: string } }
  const toolAnswer = JSON.parse(viaTool.data.result)
  check('the Godot tool itself answers the job-id query over the debugger', toolAnswer.ok === true && toolAnswer.source === 'engine debugger' && toolAnswer.result?.name === 'root', toolAnswer)
  const queued = submitted(await service.submit(profileRequest(fixture, {})))
  const waiting = await query(fixture, 'engine_scene_tree', { instance: queued.id })
  check('a queued job says it is queued, with the jobs ahead and the workers, instead of INSTANCE_NOT_FOUND', waiting.ok === false && waiting.error?.code === 'ENGINE_BOOTING' && /queued \(1 running, 0 queued ahead of it, 1 worker\(s\)\)/.test(waiting.error.message) && waiting.job?.state === 'queued', waiting)
  await service.cancel(queued.id)
  await service.cancel(job.id)
  const gone = await query(fixture, 'engine_scene_tree', { instance: job.id })
  check('a cancelled job answers that nothing runs for it and points at its record', gone.ok === false && gone.error?.code === 'NO_QUERY_ROAD' && /is cancelled/.test(gone.error.message) && /engine_result/.test(gone.error.hint ?? ''), gone)
} finally {
  await service.shutdown()
}

const late = project('late')
const lateService = EngineJobService.for(late, { workers: 1, executable: fakeEngine('connects-late', 2500) })
try {
  const job = submitted(await lateService.submit(profileRequest(late, {})))
  await until(() => liveEngines().some(engine => engine.label === `${job.id}:profile`), Boolean, 20_000)
  const booting = await query(late, 'engine_scene_tree', { instance: job.id })
  check('a profile worker that has not connected yet says so instead of INSTANCE_NOT_FOUND', booting.ok === false && booting.error?.code === 'ENGINE_BOOTING' && /has not connected to the engine debugger yet/.test(booting.error.message) && booting.job?.id === job.id, booting)
  await until(() => lateService.queryRoad(job.id)?.kind, kind => kind === 'debugger' || kind === 'none', 20_000)
  const answered = await query(late, 'engine_scene_tree', { instance: job.id, depth: 1 })
  check('the same query answers once the worker connected', answered.ok === true && answered.result?.name === 'root', answered)
  await lateService.cancel(job.id)
} finally {
  await lateService.shutdown()
}
check('every proof-owned fake engine is gone', liveEngines().length === 0)

const executable = process.env.GODOT_BIN ? { resolved: process.env.GODOT_BIN } : await resolveGodotExecutable({ census: [] })
if (!executable.resolved) {
  console.log('SKIP real engine scene tree: no Godot executable is available')
  evidence.push({ label: 'real engine', value: 'SKIP: no Godot executable' })
} else {
  const real = project('real')
  const realService = EngineJobService.for(real, { workers: 1, executable: executable.resolved })
  try {
    const job = submitted(await realService.submit(profileRequest(real, { settleFrames: 600, sampleFrames: 6000 })))
    const road = await until(() => realService.queryRoad(job.id)?.kind, kind => kind === 'debugger' || kind === 'none', 90_000)
    check('the real headless profile worker connects and says hello', road === 'debugger', road)
    const subjectOf = (tree: Awaited<ReturnType<typeof query>>) => tree.result?.children?.find((n: any) => n.script === 'res://tests/debugger_hot.gd')
    let answer = await query(real, 'engine_scene_tree', { instance: job.id, depth: 3 })
    const subjectDeadline = Date.now() + 8000
    while (subjectOf(answer) === undefined && Date.now() < subjectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      answer = await query(real, 'engine_scene_tree', { instance: job.id, depth: 3 })
    }
    const subject = subjectOf(answer)
    check('the real engine answers its live scene tree during the measurement boot: the root window, the tour subject with its script, and the bodies it made', answer.ok === true && answer.source === 'engine debugger' && answer.result?.name === 'root' && answer.result.type === 'Window' && subject !== undefined && (subject.children?.some((n: any) => n.type === 'RigidBody2D') || subject.children_count > 0), { root: answer.result?.name, subject: subject && { name: subject.name, script: subject.script, children: subject.children?.length ?? subject.children_count } })
    const version = realService.queryRoad(job.id)
    check('the connected engine is named with its version', version?.kind === 'debugger' && (version.profile.engine as { major?: number })?.major === 4, version?.kind === 'debugger' ? version.profile.engine : version)
    await realService.cancel(job.id)
    const gone = await query(real, 'engine_scene_tree', { instance: job.id })
    check('after the cancel the job id answers that nothing runs for it', gone.ok === false && gone.error?.code === 'NO_QUERY_ROAD', gone)
  } finally {
    await realService.shutdown()
    check('every proof-owned worker is gone', liveEngines().length === 0)
  }
}
writeFileSync(join(scratch, 'evidence.json'), JSON.stringify({ checks, evidence }, null, 2))
console.log(`PASS ${checks} engine scene tree checks; evidence ${join(scratch, 'evidence.json')}`)
