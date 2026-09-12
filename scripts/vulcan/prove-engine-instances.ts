import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'

const scratch = mkdtempSync(join(tmpdir(), 'engine-instances-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_WORKERS = '2'

const { vulcanOp } = await import('../../src/utils/vulcan/optable.generated.js')
let failures = 0
function check(label: string, condition: unknown, detail: unknown = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

for (const [name, cls] of [
  ['engine_scene_tree', 'read'], ['engine_node_get', 'read'], ['engine_node_call', 'exec'], ['engine_signal_wait', 'read'],
  ['lease_take', 'mutate'], ['lease_release', 'mutate'], ['lease_list', 'read'],
]) {
  const op = vulcanOp(name)
  check(`${name} has its permission class and Mercury-side dispatch`, op?.cls === cls && op.side === 'mercury')
}

const FIXTURE = join(import.meta.dir, 'fixtures', 'engine-service')
const { EngineJobService } = await import('../../src/services/vulcan/engine/service.js')
const { runEngineOp } = await import('../../src/services/vulcan/engine/ops.js')
const { parseEngineTreeSpec } = await import('../../src/services/vulcan/engine/frozenTree.js')
const { runEngineCheck } = await import('../../src/services/vulcan/engine/compileGate.js')
const { godotEngineCli } = await import('../../src/cli/godotEngineCli.js')
const { VULCAN_ADDON_FILES } = await import('../../src/services/vulcan/addonFiles.generated.js')
const { installVulcanWorkerAddon, injectVulcanWorkerScript } = await import('../../src/services/vulcan/addonInstaller.js')
const { switchSession } = await import('../../src/bootstrap/state.js')
const { engineUserEnv } = await import('../../src/services/vulcan/engine/userDir.js')
const { listVulcanInstances, readVulcanInstanceToken, selectVulcanInstance } = await import('../../src/services/vulcan/instances.js')
const { VulcanClient, resetVulcanClientForTest } = await import('../../src/services/vulcan/vulcanClient.js')
const { projectLeaseHolder, takeProjectLeases, releaseProjectLeases, listProjectLeases } = await import('../../src/services/vulcan/engine/leases.js')
const { compareProofAssertions } = await import('../../src/services/vulcan/engine/proofDrift.js')
const { GodotTool } = await import('../../src/tools/GodotTool/GodotTool.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { resolveGodotExecutable } = await import('../../src/services/vulcan/portabilityDoctor.js')

const godot = process.env.GODOT_BIN ?? (await resolveGodotExecutable({ census: [] })).resolved
const request = (suites: string[], tree: unknown = 'HEAD') => ({
  suites, tree: parseEngineTreeSpec(tree), native: false, capture: false, priority: 'lane-gate',
  budgetMs: null, displayShared: false, keepTree: false, label: null,
})
const git = (root: string, ...args: string[]): string => execFileSync('git', [
  '-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args,
], { encoding: 'utf8' })
function project(name: string): string {
  const root = join(scratch, name)
  cpSync(FIXTURE, root, { recursive: true })
  mkdirSync(join(root, '.mercury'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), '.godot/\n.mercury/\n')
  writeFileSync(join(root, '.mercury', 'engine-suites.json'), JSON.stringify({
    version: 1, executable: godot, suites: [{ name: 'runtime_checks', marker: 'RUNTIME PASS', quitAfter: 1000000, timeoutMs: 120000 }],
  }))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '.gitignore', 'project.godot', 'autoload', 'src', 'tests', 'shaders', 'engine-suites.json')
  const message = join(scratch, `${name}-commit.txt`)
  writeFileSync(message, 'Add the engine fixture\n')
  git(root, 'commit', '-q', '-F', message)
  return root
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 60000): Promise<T> {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    value = await read()
  }
  return value
}
async function op(root: string, name: string, args: Record<string, unknown>): Promise<any> {
  const text = await runEngineOp(name, args, root)
  try { return JSON.parse(text) } catch { return { error: text } }
}

const permissionRead = await GodotTool.checkPermissions!({ op: 'engine_signal_wait' } as never, {} as never, {} as never)
const permissionCall = await GodotTool.checkPermissions!({ op: 'engine_node_call' } as never, {} as never, {} as never)
check('signal observation is read-only and method calls ask', permissionRead.behavior === 'allow' && permissionCall.behavior === 'ask')

const operatorRoot = project('operator-role')
const operatorId = randomBytes(16).toString('hex')
const operatorToken = randomBytes(32).toString('hex')
let operatorConnections = 0
let operatorRequests = 0
let operatorInstance: any
const operatorServer = createServer(socket => {
  operatorConnections++
  let buffer = ''
  socket.on('data', bytes => {
    buffer += bytes.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (frame.op === 'hello') {
        if (frame.token !== operatorToken) { socket.destroy(); return }
        socket.write(JSON.stringify({ ok: true, result: { version: 1 }, instance: operatorInstance }) + '\n')
      } else {
        operatorRequests++
        socket.write(JSON.stringify({ id: frame.id, ok: true, result: { state: 'fixture' }, instance: operatorInstance }) + '\n')
      }
    }
  })
})
await new Promise<void>(resolve => operatorServer.listen(0, '127.0.0.1', resolve))
operatorInstance = { version: 1, id: operatorId, role: 'operator-editor', port: (operatorServer.address() as any).port, pid: process.pid, projectRoot: operatorRoot, ownerPid: 0 }
const operatorDir = join(operatorRoot, '.godot', 'mercury-vulcan', operatorId)
mkdirSync(operatorDir, { recursive: true, mode: 0o700 })
writeFileSync(join(operatorDir, 'token'), operatorToken, { mode: 0o600 })
writeFileSync(join(operatorDir, 'instance.json'), JSON.stringify(operatorInstance), { mode: 0o600 })
try {
  check('operator role is absent from the default selection', !selectVulcanInstance(operatorRoot).ok)
  const implicit = await runWithCwdOverride(operatorRoot, () => GodotTool.call({ op: 'editor_state' } as never, {} as never, {} as never, {} as never)) as any
  check('an unnamed editor call makes no operator connection', operatorConnections === 0 && operatorRequests === 0 && /never selected implicitly/.test(implicit.data.result), implicit.data.result)
  const explicit = await runWithCwdOverride(operatorRoot, () => GodotTool.call({ op: 'editor_state', args: { instance: operatorId } } as never, {} as never, {} as never, {} as never)) as any
  check('an explicitly named operator role is reached and named in the answer', operatorRequests === 1 && explicit.data.result.includes(operatorId) && explicit.data.result.includes('operator-editor'), explicit.data.result)
} finally {
  resetVulcanClientForTest()
  await new Promise<void>(resolve => operatorServer.close(() => resolve()))
}

const raceRoot = project('lease-switch')
const pendingHolder = projectLeaseHolder('pending')
const pendingTake = takeProjectLeases(raceRoot, ['tests/runtime_checks.gd'], pendingHolder).then(value => ({ value }), error => ({ error: String(error) }))
switchSession(randomUUID() as never)
const switchedTake = await pendingTake
check('the first pending lease cannot survive a session switch', 'error' in switchedTake && (await listProjectLeases(raceRoot)).length === 0, switchedTake)

const leasedRoot = project('leases')
const leaseChild = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] })
const leaseChildDone = once(leaseChild, 'close')
await once(leaseChild, 'spawn')
const other = projectLeaseHolder('second')
const holder = { sessionId: 'first-session', agentId: 'first', pid: leaseChild.pid! }
try {
  const taken = await takeProjectLeases(leasedRoot, ['tests/runtime_checks.gd'], holder)
  check('a session without a team takes a project lease', taken.ok, taken)
  const refused = await takeProjectLeases(leasedRoot, ['tests/runtime_checks.gd'], other)
  check('another holder is refused with session and agent named', !refused.ok && refused.conflict.holder.sessionId === holder.sessionId && refused.conflict.holder.agentId === holder.agentId, refused)
  const listed = await op(leasedRoot, 'lease_list', {})
  check('lease_list exposes the live project holder without a team', JSON.stringify(listed).includes(holder.sessionId), listed)
  const wrongRelease = await releaseProjectLeases(leasedRoot, other)
  check('another holder cannot release the lease', wrongRelease.released.length === 0 && (await listProjectLeases(leasedRoot)).length === 1)
  let escaped = false
  symlinkSync(scratch, join(leasedRoot, 'outside-link'), 'dir')
  try { await takeProjectLeases(leasedRoot, ['outside-link/file.gd'], other) } catch { escaped = true }
  check('a lease cannot escape the project through a symbolic link', escaped)
  if (godot) {
    const source = join(leasedRoot, 'tests', 'runtime_checks.gd')
    writeFileSync(source, readFileSync(source, 'utf8') + '\n')
    const denied = await runEngineOp('engine_run', { suites: ['runtime_checks'], tree: 'working', wait: false }, leasedRoot, other)
    check('the engine refuses a run that consumes another holder\'s changed file', /leased by session first-session, agent first/.test(denied), denied)
  }
} finally {
  leaseChild.stdin.end()
  await leaseChildDone
  await EngineJobService.for(leasedRoot).shutdown()
}
check('the lease is released when its holder process ends', (await listProjectLeases(leasedRoot)).length === 0)
const viaTake = await op(leasedRoot, 'lease_take', { paths: ['tests/runtime_checks.gd'] })
check('lease_take is exposed through the Godot operation dispatcher', viaTake.ok === true, viaTake)
const viaRelease = await op(leasedRoot, 'lease_release', {})
check('lease_release drops the calling holder\'s lease', viaRelease.ok === true && viaRelease.released?.includes('tests/runtime_checks.gd'), viaRelease)

const containmentRoot = project('worker-containment')
const outsideTarget = join(scratch, 'protected-addon')
mkdirSync(outsideTarget, { recursive: true })
writeFileSync(join(outsideTarget, 'plugin.gd'), 'protected bytes')
mkdirSync(join(containmentRoot, 'addons'), { recursive: true })
symlinkSync(outsideTarget, join(containmentRoot, 'addons', 'mercury_vulcan'), 'dir')
let addonRefused = false
try { await installVulcanWorkerAddon(containmentRoot) } catch { addonRefused = true }
check('worker addon installation refuses a tracked-style symlink without writing outside', addonRefused && readFileSync(join(outsideTarget, 'plugin.gd'), 'utf8') === 'protected bytes')
for (const [name, original] of [
  ['trailing', 'extends SceneTree\nfunc _initialize() -> void: # existing header\n\tprint(1)\n'],
  ['inline', 'extends SceneTree\nfunc _initialize(): print(1)\n'],
  ['multiline', 'extends SceneTree\nfunc _initialize(\n) -> void:\n\tprint(1)\n'],
]) {
  const file = join(containmentRoot, 'tests', `${name}.gd`)
  writeFileSync(file, original)
  try { injectVulcanWorkerScript(containmentRoot, `res://tests/${name}.gd`) } catch { void 0 }
  const after = readFileSync(file, 'utf8')
  check('script instrumentation never duplicates an existing initializer', (after.match(/func _initialize\s*\(/g) ?? []).length === 1 && after.includes('print(1)'), name)
}
const estateRoot = project('estate')
{
  const trees = join(estateRoot, '.mercury', 'engine', 'trees')
  const checks = join(estateRoot, '.mercury', 'engine', 'checks')
  const runs = join(estateRoot, '.mercury', 'engine', 'runs')
  for (const dir of [trees, checks, runs]) mkdirSync(dir, { recursive: true })
  const liveOwner = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] })
  await once(liveOwner, 'spawn')
  const liveEngine = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] })
  await once(liveEngine, 'spawn')
  const goneOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(goneOwner, 'close')
  const plant = (tree: string, pid: number, ownerPid: number): void => {
    const id = randomBytes(16).toString('hex')
    const dir = join(tree, '.godot', 'mercury-vulcan', id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'token'), randomBytes(32).toString('hex'), { mode: 0o600 })
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ version: 1, id, role: 'headless-worker', port: 1, pid, projectRoot: realpathSync(tree), ownerPid }), { mode: 0o600 })
  }
  const owned = join(trees, 'owned-tree')
  const orphaned = join(trees, 'orphan-tree')
  const young = join(trees, 'young-tree')
  const old = join(trees, 'old-tree')
  const oldCheck = join(checks, 'old-check')
  const stamped = join(trees, 'stamped-tree')
  for (const dir of [owned, orphaned, young, old, oldCheck, stamped, join(runs, 'stamped-tree')]) mkdirSync(dir, { recursive: true })
  plant(owned, liveEngine.pid!, liveOwner.pid!)
  plant(orphaned, liveEngine.pid!, goneOwner.pid!)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  for (const dir of [old, oldCheck, stamped]) utimesSync(dir, twoHoursAgo, twoHoursAgo)
  try {
    const estate = new EngineJobService(estateRoot, { census: async () => [] })
    await estate.submit(request(['no-such-suite']) as any)
    const removed = estate.jobs().staleTreesRemoved
    check('a tree whose instance descriptor names a live owner is kept', existsSync(owned) && !removed.includes(owned), removed)
    check('a tree whose instance owner is gone is swept at once', !existsSync(orphaned) && removed.includes(orphaned), removed)
    check('a tree with no descriptor inside the grace is kept', existsSync(young) && !removed.includes(young), removed)
    check('a tree and a check tree with no descriptor older than the grace are swept', !existsSync(old) && !existsSync(oldCheck), removed)
    check('an old tree whose run directory was stamped recently is kept', existsSync(stamped) && !removed.includes(stamped), removed)
    process.env.MERCURY_GODOT_ORPHAN_GRACE_MS = '0'
    const zeroGrace = new EngineJobService(estateRoot, { census: async () => [] })
    await zeroGrace.submit(request(['no-such-suite']) as any)
    check('the grace is read from the flag: at zero every unowned tree is swept and the owned one stays', !existsSync(young) && !existsSync(stamped) && existsSync(owned), zeroGrace.jobs().staleTreesRemoved)
  } finally {
    delete process.env.MERCURY_GODOT_ORPHAN_GRACE_MS
    liveOwner.stdin!.end()
    liveEngine.stdin!.end()
    await Promise.all([once(liveOwner, 'close'), once(liveEngine, 'close')])
  }
}

const tokenCollision = compareProofAssertions('tests/token_checks.gd', 'assert(foo and bar)\n', 'assert(fooandbar)\n')
check('assertion tokens cannot collapse distinct conditions into an approved equality', tokenCollision.length > 0, tokenCollision)

const baseline = 'extends Node\nconst EXPECTED_CHECKS := 3\nfunc verify(value: int) -> void:\n\tassert(value >= 6)\n\tassert(value <= 10)\n'
check('an obvious strengthening is not mislabeled as drift', compareProofAssertions('tests/drift_checks.gd', baseline, baseline.replace('>= 6', '>= 7')).length === 0)
const multiline = compareProofAssertions('tests/probe.test.ts', 'expect(\n value\n).toBeGreaterThanOrEqual(6)\n', 'expect(\n value\n).toBeGreaterThanOrEqual(1)\n')
check('a weakened multiline expectation is named', multiline.some(row => row.kind === 'assertion-weakened' && row.line === 1), multiline)

if (!godot) {
  console.log('SKIP: no Godot executable; live instance and compile-gate checks were not run')
} else {
  console.log(`Godot: ${execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim()}`)
  const driftRoot = project('drift')
  const driftFile = join(driftRoot, 'tests', 'drift_checks.gd')
  writeFileSync(driftFile, baseline)
  git(driftRoot, 'add', 'tests/drift_checks.gd')
  git(driftRoot, 'commit', '-q', '-F', join(scratch, 'drift-commit.txt'))
  for (const [label, content, kind] of [
    ['weakened assertion', baseline.replace('>= 6', '>= 1'), 'assertion-weakened'],
    ['removed assertion', baseline.replace('\tassert(value <= 10)\n', ''), 'assertion-removed'],
    ['fallen check count', baseline.replace('EXPECTED_CHECKS := 3', 'EXPECTED_CHECKS := 1'), 'check-count-decreased'],
  ]) {
    writeFileSync(driftFile, content)
    const result = await runEngineCheck(driftRoot, { files: ['tests/drift_checks.gd'], shaders: false }, { executable: godot })
    check(`${label} makes engine_check fail with its row named`, !result.ok && result.drift.some(row => row.kind === kind && row.file === 'tests/drift_checks.gd' && row.line !== null), result.drift)
    const lines: string[] = []
    const code = await godotEngineCli(['check', 'tests/drift_checks.gd', '--no-shaders', '--project', driftRoot], { out: line => lines.push(line), err: line => lines.push(line), cliName: 'mercury' })
    check(`${label} makes mercury godot check exit 1 with JSON drift`, code === 1 && JSON.parse(lines[0]).drift.some((row: any) => row.kind === kind), { code, drift: JSON.parse(lines[0]).drift })
  }
  writeFileSync(driftFile, baseline.replace('>= 6', '>= 1'))
  const overlay = await runEngineCheck(driftRoot, { files: ['tests/drift_checks.gd'], tree: 'working', shaders: false }, { executable: godot })
  check('a weakened assertion in the working overlay still produces its row against the tree\'s own commit', !overlay.ok && overlay.drift.some(row => row.kind === 'assertion-weakened' && row.file === 'tests/drift_checks.gd'), overlay.drift)
  writeFileSync(driftFile, baseline)
  const restored = await runEngineCheck(driftRoot, { files: ['tests/drift_checks.gd'], shaders: false }, { executable: godot })
  check('the original assertions restore a passing check without drift', restored.ok && restored.drift.length === 0, restored.diagnostics)
  const olderRoot = project('older-ref')
  writeFileSync(join(olderRoot, '.mercury', 'engine-suites.json'), JSON.stringify({
    version: 1, executable: godot, suites: [{ name: 'script_checks', marker: 'SCRIPT PASS', script: true, timeoutMs: 60000 }],
  }))
  writeFileSync(join(olderRoot, 'tests', 'extra_checks.gd'), 'extends Node\nfunc verify(value: int) -> void:\n\tassert(value >= 1)\n')
  git(olderRoot, 'add', 'tests/extra_checks.gd')
  git(olderRoot, 'commit', '-q', '-F', join(scratch, 'older-ref-commit.txt'))
  const olderCheck = await runEngineCheck(olderRoot, { files: ['tests/extra_checks.gd'], tree: 'HEAD~1', shaders: false }, { executable: godot })
  check('a check of an older ref carries no drift rows for a test HEAD added later', olderCheck.ok && olderCheck.drift.length === 0, olderCheck.drift)
  const olderRun: string[] = []
  const olderCode = await godotEngineCli(['run', 'script_checks', '--tree', 'HEAD~1', '--project', olderRoot], { out: line => olderRun.push(line), err: line => olderRun.push(line), cliName: 'mercury' })
  const olderRecord = (() => { try { return JSON.parse(olderRun[0]) } catch { return {} } })()
  check('mercury godot run --tree HEAD~1 runs the suite and exits 0 with no drift rows', olderCode === 0 && olderRecord.allPass === true && Array.isArray(olderRecord.drift) && olderRecord.drift.length === 0, { code: olderCode, drift: olderRecord.drift, error: olderRecord.error })
  const errorRoot = project('error-under-pass')
  const errorFile = join(errorRoot, 'tests', 'error_checks.gd')
  writeFileSync(errorFile, 'extends SceneTree\nfunc _initialize() -> void:\n\tcall_deferred("verify")\nfunc broken() -> void:\n\tvar values: Array = []\n\tvar value = values[2]\n\tprint(value)\nfunc verify() -> void:\n\tbroken()\n\tprint("ERROR PASS")\n\tquit()\n')
  git(errorRoot, 'add', 'tests/error_checks.gd')
  git(errorRoot, 'commit', '-q', '-F', join(scratch, 'error-under-pass-commit.txt'))
  writeFileSync(join(errorRoot, '.mercury', 'engine-suites.json'), JSON.stringify({
    version: 1, executable: godot, unclean: '^NEVER$', suites: [{ name: 'error_checks', script: true, marker: 'ERROR PASS', timeoutMs: 15000 }],
  }))
  const errorService = EngineJobService.for(errorRoot, { executable: godot })
  try {
    const errorJob = await errorService.submit(request(['error_checks']) as any)
    if ('refused' in errorJob) throw new Error(errorJob.refused)
    await errorService.wait(errorJob.id, 120000)
    const errorRecord = errorService.result(errorJob.id)!
    check('a real SCRIPT ERROR under PASS fails the engine run despite a permissive log rule', errorRecord.allPass === false && errorRecord.results.some((row: any) => row.name === 'error_checks' && row.marker === true && row.exitCode === 0) && errorRecord.drift.some((row: any) => row.kind === 'script-error-under-pass'), errorRecord.drift)
    const evidence = await runEngineCheck(errorRoot, { files: ['tests/error_checks.gd'], shaders: false, run: errorJob.id }, { executable: godot })
    check('named matching suite evidence makes engine_check fail with SCRIPT ERROR under PASS', !evidence.ok && evidence.drift.some(row => row.kind === 'script-error-under-pass' && row.runId === errorJob.id), evidence.drift)
    const automatic = await runEngineCheck(errorRoot, { files: ['tests/error_checks.gd'], shaders: false }, { executable: godot })
    check('every gate inspects the latest matching completed suite without a run argument', !automatic.ok && automatic.drift.some(row => row.kind === 'script-error-under-pass'), automatic.drift)
    const errorCli: string[] = []
    const errorCode = await godotEngineCli(['check', 'tests/error_checks.gd', '--run', errorJob.id, '--no-shaders', '--project', errorRoot], { out: line => errorCli.push(line), err: line => errorCli.push(line), cliName: 'mercury' })
    check('SCRIPT ERROR under PASS makes the CLI check exit 1 with its row named', errorCode === 1 && JSON.parse(errorCli[0]).drift.some((row: any) => row.kind === 'script-error-under-pass'), { code: errorCode, drift: JSON.parse(errorCli[0]).drift })
    writeFileSync(errorFile, readFileSync(errorFile, 'utf8') + '\n')
    const stale = await runEngineCheck(errorRoot, { files: ['tests/error_checks.gd'], shaders: false, run: errorJob.id }, { executable: godot })
    check('evidence from another tree is refused rather than reused', !stale.ok && stale.drift.some(row => row.kind === 'evidence-mismatch'), stale.drift)
  } finally { await errorService.shutdown() }

  const root = project('workers')
  const service = EngineJobService.for(root, { workers: 2, executable: godot })
  try {
    const first = await service.submit(request(['runtime_checks']) as any)
    const second = await service.submit(request(['runtime_checks']) as any)
    check('two headless jobs are accepted', !('refused' in first) && !('refused' in second), [first.id, second.id])
    const workers = await until(async () => await listVulcanInstances(root), rows => rows.filter(row => row.role === 'headless-worker').length === 2)
    const live = workers.filter(row => row.role === 'headless-worker')
    check('two headless instances publish distinct identities and ports', live.length === 2 && live[0].id !== live[1].id && live[0].port !== live[1].port, live)
    for (const worker of live) {
      const tree = await op(root, 'engine_scene_tree', { instance: worker.id, depth: 3 })
      check('engine_scene_tree names the reached worker and reads the fixture tree', tree.ok === true && tree.instance?.id === worker.id && tree.result?.name === 'RuntimeFixture' && tree.result?.children?.some((n: any) => n.name === 'Probe'), tree)
      const props = await op(root, 'engine_node_get', { instance: worker.id, node: '/root/RuntimeFixture', properties: ['score'] })
      check('engine_node_get reads score from the live scene', props.ok === true && props.result?.properties?.score === 42, props)
      const called = await op(root, 'engine_node_call', { instance: worker.id, node: '/root/RuntimeFixture', method: 'describe', args: [7] })
      check('engine_node_call returns the method result as JSON', called.ok === true && JSON.stringify(called.result).includes('"argument":7') && JSON.stringify(called.result).includes('"score":42'), called)
    }
    if (live.length === 2) {
      const firstToken = readVulcanInstanceToken(live[0])
      const secondToken = readVulcanInstanceToken(live[1])
      check('each worker has its own token file and private token', /^[a-f0-9]{64}$/.test(firstToken) && /^[a-f0-9]{64}$/.test(secondToken) && firstToken !== secondToken)
      const wrongToken = new VulcanClient({ port: live[1].port, token: firstToken, connectTimeoutMs: 1000, helloTimeoutMs: 1000 })
      try {
        const rejected = await wrongToken.request('engine_scene_tree', {}, 2000)
        check('a worker refuses the other worker\'s token', rejected.ok === false, rejected)
      } finally { wrongToken.close() }
      const timed = await op(root, 'engine_signal_wait', { instance: live[0].id, node: '/root/RuntimeFixture', signal: 'never', timeout_ms: 100 })
      check('engine_signal_wait fails with the signal and timeout named', timed.ok === false && /never/.test(JSON.stringify(timed)) && /timed out|timeout/i.test(JSON.stringify(timed)), timed)
    }
  } finally {
    await service.shutdown()
    check('worker shutdown leaves no discoverable instance', (await listVulcanInstances(root)).length === 0)
  }

  const outside = project('outside')
  for (const file of VULCAN_ADDON_FILES) {
    const dest = join(outside, 'addons', 'mercury_vulcan', file.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.content)
  }
  const projectFile = join(outside, 'project.godot')
  writeFileSync(projectFile, readFileSync(projectFile, 'utf8').replace('[autoload]', '[autoload]\n\nMercuryVulcanRuntimeBridge="*res://addons/mercury_vulcan/core/runtime_bridge.gd"'))
  const userDir = join(scratch, 'outside-user')
  mkdirSync(userDir, { recursive: true })
  const external = spawn(godot, ['--headless', '--path', outside, 'tests/runtime_checks.tscn'], {
    cwd: outside, env: { ...process.env, ...engineUserEnv(userDir) }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let externalLog = ''
  external.stdout.on('data', b => { externalLog += b.toString() })
  external.stderr.on('data', b => { externalLog += b.toString() })
  const externalDone = once(external, 'close')
  try {
    const outsideInstances = await until(async () => await listVulcanInstances(outside), rows => rows.length > 0 || external.exitCode !== null)
    check('an instance outside the service publishes its bridge', outsideInstances.length === 1, externalLog)
    if (outsideInstances.length === 1) {
      const props = await op(outside, 'engine_node_get', { instance: outsideInstances[0].id, node: '/root/RuntimeFixture', properties: ['score'] })
      check('the outside instance answers a property query', props.ok === true && props.result?.properties?.score === 42, props)
    }
  } finally {
    external.kill('SIGTERM')
    await externalDone
  }
  check('the outside instance reports no script errors or port collision', !/SCRIPT ERROR|Already in use/.test(externalLog), externalLog)
}

resetVulcanClientForTest()
console.log(`engine instance proof: ${failures} failures; scratch ${scratch}`)
process.exitCode = failures > 0 ? 1 : 0
