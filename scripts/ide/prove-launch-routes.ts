import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const product = (file: string): Promise<any> => import(pathToFileURL(join(ROOT, 'src', file)).href)
const scratch = mkdtempSync(join(tmpdir(), 'launch-routes-'))
const originalCwd = process.cwd()
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const prompt = `One list of the project's launch profiles: .vscode/launch.json configs, the detected Python tests (and a rerun of the last failures), CMake presets, Godot scenes, package.json/Cargo.toml/go.mod test and build scripts, Unity/Blender headless recipes (printed, never run). Ids (lp-…) are content-stable: a changed source gives a new id, so re-list.

1. op:"list" — every profile, and skipped launch.json configs with why.
2. op:"inspect" (profile) — payload, origin, dropped fields, and the Debug or Test call it runs as.
3. op:"debug" (profile; file + lines for breakpoints) — runs as a Debug launch in Debug's default session "main" (or session), replacing a live session of that name; the rerun profile runs as Test op:"debug" on its first failure.
4. op:"run" (profile) — the same without a debugger; a program still running after 15 s stays in Debug session "launch" (or session).
5. op:"test" (profile) — runs as Test op:"run" (op:"rerunFailed" for the rerun profile).
6. op:"build" (profile) — CMake configure + build, or the runner's build/check script.
7. op:"last" — this session's last Launch action.

debug and test return that tool's own result plus the call they ran as. debug and run need the Debug tool in this session, test the Test tool; without it they refuse.`
const hint = 'launch.json, Python test, CMake, Godot, script profiles: debug via Debug, test via Test, run, build — lp- ids, list/inspect, package.json Cargo.toml go.mod scripts, Unity/Blender recipes'
const fixture = (name: string, test: string) => {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'pyproject.toml'), `[project]\nname = "launch-${name.toLowerCase()}"\nversion = "0.0.1"\n`)
  writeFileSync(join(dir, 'tests/__init__.py'), '')
  writeFileSync(join(dir, 'tests/test_case.py'), test)
  return dir
}
const P = fixture('P', 'import unittest\nclass TestOk(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n')
const Q = fixture('Q', 'import unittest\nclass TestBad(unittest.TestCase):\n    def test_bad(self):\n        self.assertTrue(False)\n    def test_other(self):\n        self.assertTrue(False)\n')
const R = fixture('R', 'import os\nos._exit(3)\n')
const S = fixture('S', 'import time, unittest\nclass TestSlow(unittest.TestCase):\n    def test_slow(self):\n        time.sleep(60)\n')
mkdirSync(join(P, '.vscode'))
mkdirSync(join(P, 'sub'))
writeFileSync(join(P, 'hello.py'), 'import os\nvalue = 21 * 2\nprint("answer:", value)\nprint("cwd:", os.getcwd())\n')
writeFileSync(join(P, 'slow.py'), 'import time\nprint("up", flush=True)\ntime.sleep(60)\n')
writeFileSync(join(P, '.vscode/launch.json'), JSON.stringify({ configurations: [
  { name: 'hello (py)', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', console: 'integratedTerminal' },
  { name: 'slow (py)', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/slow.py' },
  { name: 'cwd (py)', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/hello.py', cwd: '${workspaceFolder}/sub', args: ['one'] },
  { name: 'missing (py)', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/missing.py' },
] }))
writeFileSync(join(P, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'node -e "process.exit(0)"' } }))
writeFileSync(join(P, 'example.test.js'), 'const {test}=require("node:test"); test("works",async()=>{await new Promise(r=>setTimeout(r,2200)); console.log("runner evidence")});\n')
process.env.MERCURY_PYTHON = '/usr/bin/python3'
process.env.MERCURY_DEBUGPY_VENDOR_DIR = join(ROOT, 'dist/vendor/debugpy')
process.chdir(P)
const { enableConfigs } = await product('utils/config.ts')
enableConfigs()
const { runWithCwdOverride } = await product('utils/cwd.ts')
const { _resetPythonProjectForTesting } = await product('services/ide/pythonProject.ts')
const { _resetDebugpyResolverForTesting } = await product('services/dap/debugpyResolver.ts')
_resetDebugpyResolverForTesting()
const { LaunchTool } = await product('tools/LaunchTool/LaunchTool.ts')
const { DebugTool } = await product('tools/DebugTool/DebugTool.ts')
const { TestTool } = await product('tools/TestTool/TestTool.ts')
const { ToolSearchTool } = await product('tools/ToolSearchTool/ToolSearchTool.ts')
const { getEmptyToolPermissionContext } = await product('Tool.ts')
const { discoverLaunchProfiles } = await product('services/ide/launchProfiles.ts')
const { listRuns } = await product('services/ide/pythonTests.ts')
const { getDapSession } = await product('services/dap/dapClient.ts')
const { ownerFromToolUseContext } = await product('services/run/resolveOwner.ts')
const { disposeOwner } = await product('services/run/ownerLifecycle.ts')
const { formatDeferredToolLine } = await product('tools/ToolSearchTool/prompt.ts')
const { zodToJsonSchema } = await product('utils/zodToJsonSchema.ts')
const { classifyEffectStep } = await product('services/ide/txAutoCapture.ts')
const context = (tools = [LaunchTool, DebugTool, TestTool], deny: string[] = []): any => ({
  getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: { cliArg: deny } } }),
  options: { tools, engineModel: 'claude-sonnet-5-5' }, messages: [], abortController: new AbortController(),
})
const ctx = context()
const owner = ownerFromToolUseContext(ctx)
const inProject = async (dir: string, fn: () => Promise<void>) => {
  process.chdir(dir)
  _resetPythonProjectForTesting()
  await runWithCwdOverride(dir, fn)
}
const profiles = async () => (await discoverLaunchProfiles()).profiles
const suite = async () => (await profiles()).find((p: any) => p.test?.selectionLabel === 'all')
const call = (op: string, profile: string, extras = {}, c = ctx, onProgress?: (p: unknown) => void): Promise<any> => LaunchTool.call({ op, profile, ...extras }, c, undefined, undefined, onProgress)
const routeText = (tool: string, input: object, id: string) => `Launch ${id} ran as: ${tool} ${JSON.stringify(input)}`
const withoutRoute = (result: string) => result.split('\n').slice(0, -1).join('\n')
const guard = setTimeout(() => { console.error('FAIL launch routes exceeded the 360s proof wall'); process.exit(1) }, 360_000)
guard.unref()

try {
  check('fixture requires the real vendored debugpy adapter', existsSync(join(process.env.MERCURY_DEBUGPY_VENDOR_DIR!, 'debugpy/adapter/__main__.py')))
  await inProject(P, async () => {
    const all = await profiles()
    const hello = all.find((p: any) => p.label === 'hello (py)')!
    const test = await suite()
    if (!hello || !test) throw new Error('fixture discovery omitted Python profiles')
    const dbg = await call('debug', hello.id, { file: join(P, 'hello.py'), lines: [3] })
    check('L1 debug uses the owner words, frames, route and default session', /^launched .*hello\.py via python \(session 'main'\)\. breakpoints — .*: line 3 verified; first stop: stopped — reason breakpoint/.test(dbg.data.result) && dbg.data.result.includes('\n#0 ') && dbg.data.result.split('\n').at(-1)?.startsWith(`Launch ${hello.id} ran as: Debug {"op":"launch"`) && Boolean(getDapSession(owner, 'main')) && !getDapSession(owner, 'launch') && dbg.data.route?.tool === 'Debug', dbg.data.result)
    check('debug effect preserves launch.debug, the owner stop card and debuggee', dbg.effect.operation === 'launch.debug' && dbg.effect.details?.stopCard?.verifiedBreakpoints === 1 && dbg.effect.details?.debuggee === 'stopped' && dbg.effect.details?.route?.tool === 'Debug')
    const stack = await DebugTool.call({ op: 'stack' }, ctx)
    check('L2 the next Debug call needs no session', stack.data.result.includes('#0 '), stack.data.result)
    await disposeOwner(owner)
    const out = await call('test', test.id)
    const recordId = out.data.result.match(/record: mercury:\/\/test\/run\/([^\s]+)/)?.[1]
    check('L3 test preserves Test summary, record, route and effect details', out.data.result.startsWith('ran: ') && out.data.result.includes('unittest all — 1 passed · 0 failed') && out.data.result.endsWith(routeText('Test', { op: 'run', framework: 'unittest' }, test.id)) && recordId !== undefined && out.effect.details?.testRun?.id === recordId, out.data.result)
    const report = await TestTool.call({ op: 'report', runId: recordId }, ctx)
    check('Test text is byte-identical to its own report of that same record', withoutRoute(out.data.result) === report.data.result)
    check('Transaction still counts launch.test as test and launch.build as build, not debug', classifyEffectStep(out.effect) === 'test' && classifyEffectStep({ ...out.effect, operation: 'launch.build' }) === 'build' && classifyEffectStep(dbg.effect) === null)
    const tAsk = await LaunchTool.checkPermissions({ op: 'test', profile: test.id }, ctx)
    const dAsk = await LaunchTool.checkPermissions({ op: 'debug', profile: hello.id }, ctx)
    check('L6 permission asks reuse each owner’s exact words', tAsk.behavior === 'ask' && tAsk.message === `Launch test ${test.id} (run all tests (unittest)) → Test run (python lane: the shared project interpreter)` && dAsk.behavior === 'ask' && dAsk.message === `Launch debug ${hello.id} (hello (py)) → Debug launch: ${P}/hello.py (adapter python)`)
    for (const op of ['debug', 'run']) {
      const denied = await LaunchTool.checkPermissions({ op, profile: hello.id }, context(undefined, ['Debug']))
      check(`L7 ${op} cannot bypass a Debug deny`, denied.behavior === 'deny' && denied.message === `Launch ${op} runs through the Debug tool, which a deny rule blocks in this session — nothing ran. If the task needs Debug, say so to the user.`)
    }
    const before = listRuns().length
    const absent = await call('test', test.id, {}, context([LaunchTool, DebugTool]))
    check('L8 absent Test refuses without a record', absent.data.outcome === 'failed' && absent.data.result === 'Launch test runs through the Test tool, which is not available in this session — nothing ran. If the task needs Test, say so to the user.' && listRuns().length === before, absent.data.result)
    const noTest = await LaunchTool.checkPermissions({ op: 'test', profile: test.id }, context(undefined, ['Test']))
    check('Test deny also blocks routed tests', noTest.behavior === 'deny')
    const whole = await call('debug', test.id)
    check('L10 a suite debug names the one-test call', whole.data.outcome === 'no-change' && whole.data.result.includes('Test {"op":"debug","node":"<test id>"}'), whole.data.result)
    const runner = all.find((p: any) => p.runnerRef && p.kind === 'test')!
    const inspect = await call('inspect', runner.id)
    check('L11 inspect reveals the runner id and exact Test call', inspect.data.result.includes('test → node-test runner profile rp-') && inspect.data.result.includes('test runs as: Test {"op":"run","profile":"rp-') && !inspect.data.result.includes('(no payload)'), inspect.data.result)
    const progress: unknown[] = []
    const runnerOut = await call('test', runner.id, {}, ctx, row => progress.push(row))
    check('runner route preserves Test progress and exact profile', runnerOut.data.route?.input?.profile === runner.runnerRef.profileId && runnerOut.data.result.startsWith('ran: node --test --test-reporter tap') && progress.length > 0 && LaunchTool.renderToolUseProgressMessage === TestTool.renderToolUseProgressMessage, runnerOut.data.result)
    const bad = await call('test', hello.id)
    check('test kind refusal names debug and run', bad.data.result.endsWith('(use op:"debug" or op:"run")'))
    const badBuild = await call('build', test.id)
    check('build kind refusal names test', badBuild.data.result.endsWith('(use op:"test")'))
    for (const extra of [{ file: 'a.py' }, { lines: [3] }, { file: 'a.py', lines: [] }, { lines: [] }]) {
      const validated = await LaunchTool.validateInput({ op: 'debug', profile: 'lp-x', ...extra }, ctx)
      check(`L12 unpaired breakpoint input ${JSON.stringify(extra)} refuses`, validated.result === false && validated.message === 'debug breakpoints need file and lines together — pass both, or neither to stop at the program\'s first line')
    }
    const slow = all.find((p: any) => p.label === 'slow (py)')!
    const live = await call('run', slow.id)
    check('L13 a live run names exact session-qualified Debug calls', live.data.result === 'slow (py) is RUNNING in Debug session \'launch\' — read its output with Debug {"op":"output","session":"launch"}; stop it with Debug {"op":"disconnect","session":"launch"}', live.data.result)
    const ended = await DebugTool.call({ op: 'disconnect', session: 'launch' }, ctx)
    check('L13 the named session disconnects', ended.data.result.includes('disconnected'))
    const custom = all.find((p: any) => p.label === 'cwd (py)')!
    const customOut = await call('debug', custom.id, { session: 'x' })
    const customAgain = await call('debug', custom.id, { session: 'x' })
    const lastLine = customAgain.data.result.split('\n').at(-1) ?? ''
    check('custom debug carries cwd, args, replacement and session clauses in order', customOut.data.route?.input?.args?.[0] === 'one' && lastLine.endsWith(`; cwd ${P}/sub from the profile; it replaced the live session 'x'; pass session:"x" on every Debug call`), lastLine)
    const cwd = await DebugTool.call({ op: 'evaluate', session: 'x', expression: '__import__("os").getcwd()' }, ctx)
    check('the profile cwd reaches the real debuggee', cwd.data.result.includes(`${P}/sub`), cwd.data.result)
    await disposeOwner(owner)
    const deferredCtx = context([LaunchTool, { ...DebugTool, loadInFullOnCloud: false }, TestTool, ToolSearchTool])
    const unloaded = await call('debug', hello.id, {}, deferredCtx)
    check('L18 an unloaded next owner gets its exact load call', unloaded.data.result.endsWith('; load Debug first: ToolSearch "select:Debug"'), unloaded.data.result)
    await disposeOwner(owner)
    deferredCtx.messages = [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'load-debug', content: [{ type: 'tool_reference', tool_name: 'Debug' }] }] } }]
    const loaded = await call('debug', hello.id, {}, deferredCtx)
    check('L18 loading the owner removes the load clause', loaded.data.route?.tool === 'Debug' && !loaded.data.result.includes('; load Debug first:'))
    await disposeOwner(owner)
    for (const [flag, op, profile, tool] of [['MERCURY_DAP', 'debug', hello.id, 'Debug'], ['MERCURY_DAP', 'run', hello.id, 'Debug'], ['MERCURY_TESTS', 'test', test.id, 'Test']]) {
      process.env[flag] = '0'
      const bare = { getAppState: () => ({}), abortController: new AbortController() }
      const gated = await call(op, profile, {}, bare)
      check(`catalog fallback respects ${flag}=0 for ${op}`, gated.data.outcome === 'failed' && gated.data.result.includes(`${tool} tool, which is not available`), gated.data.result)
      delete process.env[flag]
    }
  })
  await inProject(R, async () => {
    const out = await call('test', (await suite()).id)
    check('L4 evidence-free runs retain Test’s verdict note', out.data.outcome === 'failed' && out.data.result.includes('NOTE: no structured case records arrived (exit 3)'), out.data.result)
  })
  await inProject(S, async () => {
    const c = context()
    const id = (await suite()).id
    const started = Date.now()
    const abort = setTimeout(() => c.abortController.abort(), 1_000)
    const out = await call('test', id, {}, c)
    clearTimeout(abort)
    const elapsed = Date.now() - started
    check('L5 abort reaches the Python runner within 15s', elapsed < 15_000 && out.data.outcome !== 'succeeded', `${elapsed}ms, ${out.data.outcome}`)
  })
  await inProject(Q, async () => {
    await TestTool.call({ op: 'run' }, ctx)
    const rerun = (await profiles()).find((p: any) => p.test?.selectionLabel === 'rerun-failed')!
    check('L9 discovery offers the failed nodes', rerun?.test?.selection.length === 2)
    const out = await call('debug', rerun.id)
    check('L9 rerun debug is Test’s one-test operation in main', out.data.result.startsWith("debugging tests.test_case.TestBad.test_bad (unittest) in Debug session 'main'") && out.data.result.includes('ran as: Test {"op":"debug"') && out.data.route?.input?.session === 'main', out.data.result)
    check('rerun debug counts and names the next failing node', out.data.result.endsWith('; 1 more failing test(s) — Test {"op":"debug","node":"tests.test_case.TestBad.test_other"} debugs another'), out.data.result)
    await disposeOwner(owner)
    for (const blocked of ['Test', 'Debug']) {
      const denied = await LaunchTool.checkPermissions({ op: 'debug', profile: rerun.id }, context(undefined, [blocked]))
      check(`rerun debug requires ${blocked} permission`, denied.behavior === 'deny')
    }
    const run = await call('test', rerun.id)
    check('rerun test routes through Test rerunFailed', run.data.route?.input?.op === 'rerunFailed' && run.effect.operation === 'launch.test' && run.data.result.endsWith(routeText('Test', { op: 'rerunFailed' }, rerun.id)))
  })
  check('L14 the whole Launch description matches the specified words', await LaunchTool.prompt() === prompt)
  check('L15 every stored input shape still parses', [
    { op: 'debug', profile: 'lp-x', session: 'launch', file: 'a.py', lines: [3] },
    { op: 'test', profile: 'lp-x' }, { op: 'run', profile: 'lp-x', session: 's' }, { op: 'last' },
    ...['list', 'inspect', 'build'].map(op => ({ op, profile: 'lp-x' })),
  ].every(input => LaunchTool.inputSchema.safeParse(input).success))
  const definition = { name: LaunchTool.name, description: await LaunchTool.prompt(), input_schema: zodToJsonSchema(LaunchTool.inputSchema), eager_input_streaming: true, defer_loading: true }
  const bytes = Buffer.byteLength(JSON.stringify(definition))
  console.log(`MEASURE Launch definition ${bytes} bytes; description ${Buffer.byteLength(definition.description)}; schema ${Buffer.byteLength(JSON.stringify(definition.input_schema))}`)
  check('L16 definition is at most 2,133 bytes and stays deferred', bytes <= 2133 && LaunchTool.shouldDefer === true)
  check('L17 search hint and announcement line name the routes', LaunchTool.searchHint === hint && formatDeferredToolLine(LaunchTool) === 'Launch — launch.json, Python test, CMake, Godot, script profiles: debug via Debug, test via Test, run, build…')
} catch (error) {
  failures++
  console.error(`FAIL launch route fixture: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  clearTimeout(guard)
  await disposeOwner(owner)
  process.chdir(originalCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL ${failures} launch route checks` : 'PASS all launch route checks')
process.exit(failures ? 1 : 0)
