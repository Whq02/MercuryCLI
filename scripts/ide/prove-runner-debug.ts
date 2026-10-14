#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'runner-debug-home-'))
process.env.MERCURY_BARE = '1'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const JS_DEBUG = path.join(ROOT, 'dist', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')

const plans = await import('../../src/services/ide/testDebugPlans.ts')
const runners = await import('../../src/services/ide/projectRunners.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — runner debug proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const scratch = (label: string): string => mkdtempSync(path.join(tmpdir(), `runner-debug-${label}-`))
const ctx = { getAppState: () => ({}) } as never

const VITEST_TEST = [
  "import { describe, it, expect } from 'vitest'",
  '',
  'function add(a, b) { return a - b }',
  '',
  "describe('calc', () => {",
  "  it('adds two numbers', () => {",
  '    const result = add(2, 3)',
  '    expect(result).toBe(5)',
  '  })',
  "  it('keeps zero (0+0)', () => { expect(add(0, 0)).toBe(0) })",
  '  it(',
  "    'spans lines',",
  '    () => {',
  '      expect(1).toBe(1)',
  '    },',
  '  )',
  '})',
  '',
].join('\n')

function nodeProject(runner: 'vitest' | 'jest', withModules: boolean): string {
  const root = scratch(runner)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', devDependencies: { [runner]: '*' } }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', runner === 'vitest' ? 'calc.test.mjs' : 'calc.test.js'), VITEST_TEST)
  if (withModules) {
    const pkgDir = path.join(root, 'node_modules', runner)
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    const entry = runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js'
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: runner, version: '0.0.0-fixture', bin: { [runner]: entry } }) + '\n')
    mkdirSync(path.dirname(path.join(pkgDir, entry)), { recursive: true })
    writeFileSync(path.join(pkgDir, entry), '#!/usr/bin/env node\nprocess.exit(0)\n')
    const link = path.join(root, 'node_modules', '.bin', runner)
    writeFileSync(link, '#!/usr/bin/env node\nprocess.exit(0)\n')
    chmodSync(link, 0o755)
  }
  return root
}

section('A. the vitest shim: the runner\'s own entry under js-debug, one test by anchored name, the stop on the test\'s first line')
{
  const root = nodeProject('vitest', true)
  const shim = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc adds two numbers', { from: root })
  check('A1 program is node_modules/vitest/vitest.mjs (the package\'s own bin, never the .bin shell link)', !('state' in shim) && shim.program === path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), JSON.stringify(shim))
  check('A2 args: run <file> -t ^name$ --no-file-parallelism --test-timeout=0 (vitest\'s own debugging flags)', !('state' in shim) && JSON.stringify(shim.args) === JSON.stringify(['run', 'src/calc.test.mjs', '-t', '^calc adds two numbers$', '--no-file-parallelism', '--test-timeout=0']), 'state' in shim ? shim.reason : JSON.stringify(shim.args))
  check('A3 cwd is the runner root and the stop is the first line of the test body (line 7)', !('state' in shim) && shim.cwd === root && shim.stop?.file === path.join(root, 'src', 'calc.test.mjs') && shim.stop.line === 7, 'state' in shim ? shim.reason : JSON.stringify(shim.stop))
  const meta = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc keeps zero (0+0)', { from: root })
  check('A4 regex metacharacters in the name are escaped inside the anchors; a one-line test stops on its own line (10)', !('state' in meta) && meta.args[3] === '^calc keeps zero \\(0\\+0\\)$' && meta.stop?.line === 10, 'state' in meta ? meta.reason : JSON.stringify({ t: meta.args[3], stop: meta.stop }))
  const spans = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc spans lines', { from: root })
  check('A5 a title on its own line is found through the quoted-name fallback and the stop is the body\'s first line past the opening brace (14)', !('state' in spans) && spans.stop?.line === 14, 'state' in spans ? spans.reason : JSON.stringify(spans.stop))
  const unknown = plans.buildNodeRunnerDebugShim('vitest', 'src/calc.test.mjs::calc nowhere', { from: root })
  check('A6 a name the file does not carry still builds the shim with NO stop and a note that names the Debug tool', !('state' in unknown) && unknown.stop === null && unknown.note.includes('Debug tool') && unknown.args[3] === '^calc nowhere$', JSON.stringify(unknown))
  const missing = plans.buildNodeRunnerDebugShim('vitest', 'src/absent.test.mjs::x', { from: root })
  check('A7 a missing test file refuses typed', 'state' in missing && missing.state === 'unavailable' && missing.reason.includes('not found'), JSON.stringify(missing))
  const bare = runWithCwdOverride(root, () => plans.buildNodeRunnerDebugShim('vitest', 'calc adds two numbers', { from: root }))
  check('A8 a bare name with no run record refuses with the file::name remedy', 'state' in bare && bare.remedy.includes('file::name'), JSON.stringify(bare))
  rmSync(root, { recursive: true, force: true })
}

section('B. the jest shim')
{
  const root = nodeProject('jest', true)
  const shim = plans.buildNodeRunnerDebugShim('jest', 'src/calc.test.js::calc adds two numbers', { from: root })
  check('B1 program is node_modules/jest/bin/jest.js and args are --runInBand <file> -t ^name$ (jest\'s own debugging shape)', !('state' in shim) && shim.program === path.join(root, 'node_modules', 'jest', 'bin', 'jest.js') && JSON.stringify(shim.args) === JSON.stringify(['--runInBand', 'src/calc.test.js', '-t', '^calc adds two numbers$']), JSON.stringify(shim))
  check('B2 the stop is the first line of the test body', !('state' in shim) && shim.stop?.line === 7, 'state' in shim ? shim.reason : JSON.stringify(shim.stop))
  rmSync(root, { recursive: true, force: true })
}

section('C. a bare name is placed by the latest run\'s case rows (the reporter carries the file)')
{
  const root = nodeProject('vitest', true)
  const report = readFileSync(path.join(import.meta.dir, 'fixtures', 'runners', 'vitest-report.json'), 'utf8').split('/work/project').join(root)
  const bin = path.join(root, 'node_modules', '.bin', 'vitest')
  writeFileSync(bin, ['#!/usr/bin/env node', `const out = process.argv.slice(2).find(a => a.startsWith('--outputFile='))`, `if (out) require('fs').writeFileSync(out.slice('--outputFile='.length), ${JSON.stringify(report)})`, 'process.exit(1)', ''].join('\n'))
  chmodSync(bin, 0o755)
  const profile = runners.discoverRunnerProfiles(root).profiles.find(p => p.runner === 'vitest' && p.kind === 'test')!
  const run = await runners.runRunnerProfile(profile, { from: root })
  check('C1 the run recorded the failing case with its file', run.state === 'ok' && run.record.cases.some(c => c.id === 'calc adds two numbers' && c.file === 'src/calc.test.mjs'), JSON.stringify(run.state === 'ok' ? run.record.cases : run))
  const shim = runWithCwdOverride(root, () => plans.buildNodeRunnerDebugShim('vitest', 'calc adds two numbers', { from: root }))
  check('C2 the bare full name resolves to that file and its line', !('state' in shim) && shim.stop?.file === path.join(root, 'src', 'calc.test.mjs') && shim.stop.line === 7 && shim.args[1] === 'src/calc.test.mjs', JSON.stringify(shim))
  rmSync(root, { recursive: true, force: true })
}

section('D. the Test tool: vitest and jest debug ride js-debug; an absent runner is an honest unavailable with its remedy')
{
  const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
  const toolSrc = readFileSync(path.join(ROOT, 'src/tools/TestTool/TestTool.ts'), 'utf8')
  check('D1 the debug op routes vitest and jest through the node-runner shim onto adapterKey js with the shim\'s program and args', toolSrc.includes("buildNodeRunnerDebugShim(runner, input.node") && toolSrc.includes("adapterKey: 'js'") && toolSrc.includes('args: shim.args') && toolSrc.includes('breakpoints.set(shim.stop.file, [shim.stop.line])'))
  const root = nodeProject('vitest', false)
  const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: 'src/calc.test.mjs::calc adds two numbers' } as never, ctx))) as { data: { result: string; outcome: string } }
  check('D2 vitest declared but not installed: "debug unavailable" with the install remedy, never a sentence about the debugger not being there', out.data.outcome === 'failed' && out.data.result.startsWith('debug unavailable: vitest is declared but node_modules/.bin/vitest is missing') && out.data.result.includes('remedy: install the project dependencies'), out.data.result)
  rmSync(root, { recursive: true, force: true })
}

const JEST_TEST = VITEST_TEST.split('\n').slice(1).join('\n')

async function liveNodeRunner(tag: string, runner: 'vitest' | 'jest', entry: string, testFile: string, source: string, packageJson: Record<string, unknown>): Promise<void> {
  section(`${tag}. the live leg — a real ${runner} under the vendored js-debug stops on the test's first line with locals readable`)
  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const runnerEntry = modules ? path.join(modules, runner, entry) : ''
  if (!modules || !existsSync(runnerEntry)) {
    console.log(`  [SKIP — LOUD] no ${runner} on this machine (${modules ? `${runnerEntry} absent` : 'MERCURY_PROOF_RUNNER_MODULES unset'}) — the shim and the tool route above are the evidence`)
    return
  }
  if (!existsSync(JS_DEBUG)) {
    console.log(`  [SKIP — LOUD] ${JS_DEBUG} absent — build the tree (bun run build.ts) for the vendored js-debug`)
    failures++
    return
  }
  process.env.MERCURY_JS_DEBUG_DAP = JS_DEBUG
  const root = scratch(`live-${runner}`)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'live', private: true, devDependencies: { [runner]: '*' }, ...packageJson }) + '\n')
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  symlinkSync(modules, path.join(root, 'node_modules'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', testFile), source)
  const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
  const dap = await import('../../src/services/dap/dapClient.ts')
  const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
  const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
  const bodyLine = source.split('\n').findIndex(l => l.includes('const result = add(2, 3)')) + 1
  const out = (await runWithCwdOverride(root, () => TestTool.call({ op: 'debug', node: `src/${testFile}::calc adds two numbers` } as never, ctx))) as { data: { result: string; outcome: string } }
  check(`${tag}1 the tool reports a stop at a breakpoint`, out.data.outcome === 'succeeded' && /stopped in '.*' — reason breakpoint/.test(out.data.result), out.data.result.split('\n').slice(0, 3).join(' | '))
  const owner = ownerFromToolUseContext(ctx)
  const session = dap.getDapSession(owner, 'test')
  const stopped = session?.treeStopped() ?? null
  check(`${tag}2 a session named test is live and a tree member holds the stop`, session !== undefined && stopped !== null, String(session?.treeSessions().map(s => s.label)))
  if (session && stopped && stopped.lastStopped) {
    const threadId = stopped.lastStopped.threadId ?? 1
    const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 3 })
    const frames = stack.stackFrames as Array<{ id: number; name?: string; line?: number; source?: { path?: string } }>
    check(`${tag}3 the top frame is the test body in the REAL test file at its first line (${bodyLine})`, (frames[0]?.source?.path ?? '').endsWith(`src/${testFile}`) && frames[0]?.line === bodyLine, JSON.stringify(frames[0]))
    const stamp = session.treeNewestStopStamp()
    await stopped.request('next', { threadId })
    const stepped = await session.waitForStopOutcome(10_000, undefined, stamp)
    const frame = stepped.state === 'stopped' ? ((await stepped.session.request('stackTrace', { threadId: stepped.info.threadId ?? threadId, startFrame: 0, levels: 1 })).stackFrames as Array<{ id: number; line?: number }>)[0] : undefined
    check(`${tag}4 one step lands on the next line of the test (${bodyLine + 1})`, stepped.state === 'stopped' && frame?.line === bodyLine + 1, JSON.stringify(stepped.state === 'stopped' ? frame : stepped))
    if (stepped.state === 'stopped' && frame) {
      const scopes = await stepped.session.request('scopes', { frameId: frame.id })
      const rows = scopes.scopes as Array<{ name: string; variablesReference: number }>
      const seen: Array<{ scope: string; name: string; value: string }> = []
      for (const scope of rows.slice(0, 3)) {
        const vars = await stepped.session.request('variables', { variablesReference: scope.variablesReference })
        for (const v of vars.variables as Array<{ name: string; value: string }>) seen.push({ scope: scope.name, name: v.name, value: v.value })
      }
      const result = seen.find(v => v.name === 'result')
      check(`${tag}5 locals are readable: result reads -1 (the defect the test catches)`, result?.value === '-1', JSON.stringify(seen.slice(0, 8)))
    }
  }
  await disposeOwner(owner)
  check(`${tag}6 disconnect is clean: no session left`, dap._dapSessionCountForTesting() === 0, String(dap._dapSessionCountForTesting()))
  delete process.env.MERCURY_JS_DEBUG_DAP
  rmSync(root, { recursive: true, force: true })
}

await liveNodeRunner('E', 'vitest', 'vitest.mjs', 'calc.test.mjs', VITEST_TEST, { type: 'module' })
await liveNodeRunner('F', 'jest', 'bin/jest.js', 'calc.test.js', JEST_TEST, { jest: { testEnvironment: 'node' } })

console.log('')
if (failures > 0) {
  console.error(`prove-runner-debug: ${failures} RED`)
  process.exit(1)
}
console.log('prove-runner-debug: GREEN')
