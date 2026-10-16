#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const JS_DEBUG = path.join(ROOT, 'dist', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
const SYS_PY = process.platform === 'win32' ? 'python' : '/usr/bin/python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — debug-without-adapter proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' the Launch run op reports the program’s own end; the Test debug op names a missing debugger and still runs the test')
console.log('============================================================')

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'mercury-debug-without-adapter-')))
const nodeProj = path.join(scratch, 'node')
mkdirSync(path.join(nodeProj, '.vscode'), { recursive: true })
writeFileSync(path.join(nodeProj, 'printvar.js'), "console.log('VAR is ' + (process.env.VAR ?? '(unset)'))\n")
writeFileSync(path.join(nodeProj, 'exitcode.js'), "console.log('exiting with 7'); process.exit(7)\n")
writeFileSync(path.join(nodeProj, 'package.json'), JSON.stringify({ name: 'launch-exit-fixture', private: true }) + '\n')
writeFileSync(
  path.join(nodeProj, '.vscode', 'launch.json'),
  JSON.stringify(
    {
      version: '0.2.0',
      configurations: [
        { name: 'run', type: 'node', request: 'launch', program: '${workspaceFolder}/printvar.js', env: { VAR: 'one' } },
        { name: 'seven', type: 'node', request: 'launch', program: '${workspaceFolder}/exitcode.js' },
      ],
    },
    null,
    2,
  ),
)

const pyProj = path.join(scratch, 'py')
mkdirSync(path.join(pyProj, 'tests'), { recursive: true })
writeFileSync(path.join(pyProj, 'pyproject.toml'), '[project]\nname = "debug-without-adapter-fixture"\nversion = "0.0.1"\n')
writeFileSync(path.join(pyProj, 'calc.py'), 'def add(a, b):\n    return a + b\n')
writeFileSync(path.join(pyProj, 'tests', '__init__.py'), '')
writeFileSync(
  path.join(pyProj, 'tests', 'test_sum.py'),
  'import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\n' +
    'import unittest\nfrom calc import add\n\n' +
    'class TestSum(unittest.TestCase):\n' +
    '    def test_add_three_plus_four(self):\n' +
    '        self.assertEqual(add(3, 4), 8)\n',
)

process.env.MERCURY_JS_DEBUG_DAP = JS_DEBUG
process.chdir(nodeProj)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const launch = await import('../../src/services/ide/launchProfiles.js')
const { LaunchTool } = await import('../../src/tools/LaunchTool/LaunchTool.js')
const dap = await import('../../src/services/dap/dapClient.js')
const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.js')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.js')
const ctx = { getAppState: () => ({}) } as never

try {
  section('§1 the Launch run op: a Node program that ends on its own is not reported as a failed exit; an explicit exit code is the program’s own')
  if (!existsSync(JS_DEBUG)) {
    console.log(`  [SKIP — LOUD] ${JS_DEBUG} absent — run bun run build.ts; the run legs need the vendored js-debug.`)
    failures++
  } else {
    const d = await launch.discoverLaunchProfiles(nodeProj)
    const runProfile = d.profiles.find(p => p.label === 'run')
    const sevenProfile = d.profiles.find(p => p.label === 'seven')
    check('both launch profiles are discovered', runProfile !== undefined && sevenProfile !== undefined, JSON.stringify(d.profiles.map(p => p.label)))
    const ran = (await LaunchTool.call({ op: 'run', profile: runProfile!.id } as never, ctx)) as { data: { result: string; outcome: string } }
    const ranLine = ran.data.result.split('\n')[0] ?? ''
    console.log(`  run → ${ranLine}`)
    check('the natural end carries the program’s stdout', ran.data.result.includes('VAR is one'), ran.data.result.slice(0, 300))
    check('the natural end is never spelled as the adapter’s own exit (code 1, a kill signal)', !/adapter exited/.test(ranLine) && !/code 1\b/.test(ranLine) && !/SIGKILL/.test(ranLine), ranLine)
    check('the natural end says the program ended without a non-zero exit code', /debuggee ended \(no non-zero exit code reported\)|debuggee exited \(code 0\)/.test(ranLine), ranLine)
    const seven = (await LaunchTool.call({ op: 'run', profile: sevenProfile!.id } as never, ctx)) as { data: { result: string; outcome: string } }
    const sevenLine = seven.data.result.split('\n')[0] ?? ''
    console.log(`  seven → ${sevenLine}`)
    check('an explicit process.exit(7) is reported as the program’s exit code 7', /debuggee exited \(code 7\)/.test(sevenLine), sevenLine)
    check('…and never as the adapter’s end', !/adapter exited/.test(sevenLine), sevenLine)
    await disposeOwner(ownerFromToolUseContext(ctx))
    check('the sessions are reaped', dap._dapSessionCountForTesting() === 0)
  }

  section('§2 the Test debug op with no Python debugger: one line names what is missing and how to install it, and the test still runs without a stop')
  const pythonPresent = (() => {
    try {
      execFileSync(SYS_PY, ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  if (!pythonPresent) {
    console.log(`  [SKIP — LOUD] ${SYS_PY} absent — the debug leg needs one interpreter without debugpy.`)
    failures++
  } else {
    process.env.MERCURY_PYTHON = SYS_PY
    delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
    const resolver = await import('../../src/services/dap/debugpyResolver.js')
    resolver._resetDebugpyResolverForTesting()
    const { _resetPythonProjectForTesting, projectPythonDebugAdapter } = await import('../../src/services/ide/pythonProject.js')
    _resetPythonProjectForTesting()
    process.chdir(pyProj)
    const adapter = projectPythonDebugAdapter(pyProj)
    if (adapter.state === 'ok') {
      console.log(`  [SKIP — LOUD] ${SYS_PY} carries debugpy (${JSON.stringify(adapter.provenance)}) — this leg needs an interpreter without it`)
    } else {
      const { TestTool } = await import('../../src/tools/TestTool/TestTool.js')
      const out = (await TestTool.call({ op: 'debug', node: 'tests.test_sum.TestSum.test_add_three_plus_four', framework: 'unittest' } as never, ctx)) as { data: { result: string; outcome: string } }
      const first = out.data.result.split('\n')[0] ?? ''
      console.log(`  debug → ${first}`)
      check('the first line says no Python debugger is on this machine', first.startsWith('no Python debugger (debugpy) on this machine — '), first)
      check('…with the install words', /pip install debugpy/.test(first) && /py -m pip install debugpy/.test(first), first)
      check('…and that the test ran without a stop', first.endsWith('; the test ran without a stop'), first)
      check('the run’s own verdict follows: the failing test is named with its counts', /test_add_three_plus_four/.test(out.data.result) && /1 failed|failed/.test(out.data.result) && out.data.outcome === 'failed', out.data.result.slice(0, 400))
      check('the result is a typed answer, never a thrown tool error', !/^Error|adapter 'python' is unavailable:/.test(first), first)
    }
  }
} finally {
  clearTimeout(guard)
  process.chdir(ROOT)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-debug-without-adapter: ALL LAWS HOLD' : `\nprove-debug-without-adapter: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
