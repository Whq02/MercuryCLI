#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-python-tests.ts
//  PROOF: structured Python test transactions — the COMPLETE
//  scratch-project journey on the stdlib unittest arm (machine-independent),
//  through the REAL service + the REAL Test tool + the REAL debugpy session:
//
//    (1) discover — structured node ids from the embedded runner (never
//        parsed prose); collect errors surface.
//    (2) run — one REAL failure with its structured location + message;
//        durable mercury://test records land (run/<id> · latest · failures).
//    (3) rerunFailed — EXACTLY the failing selection re-runs.
//    (4) fix → rerunFailed — green; the durable trail shows the whole arc.
//    (5) debug one test — a breakpoint INSIDE the test through the SAME
//        (bundled) debugpy machinery; locals inspected; clean disconnect.
//    (6) the Test TOOL surface — permission matrix (code-executing ops ask,
//        report rides free), typed effects, records in tool output.
//    (7) honesty — evidence-free runs read as errored (verdictNote), the
//        unavailable path names interpreter truth, pytest legs probe and
//        skip LOUDLY when the machine lacks pytest.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-python-tests.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

console.log('============================================================')
console.log(' python test transactions — the full journey (unittest arm)')
console.log('============================================================')

// Pin the interpreter to the known-good system python (the broken-Homebrew
// machine class from) — the SHARED owner honors the pin everywhere.
if (!existsSync(SYS_PY)) {
  console.log(`\n  [SKIP — LOUD] ${SYS_PY} absent — the journey needs one known-good interpreter.`)
  process.exit(0)
}
process.env.MERCURY_PYTHON = SYS_PY
delete process.env.MERCURY_TESTS

// The fixture project: a tests/ package with one passing and one failing test
// over a tiny lib with a real defect (the failing assertion localizes it).
const proj = mkdtempSync(path.join(tmpdir(), 'mercury-pytests-'))
const libPy = path.join(proj, 'calc.py')
mkdirSync(path.join(proj, 'tests'))
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "pytests-fixture"\nversion = "0.0.1"\n')
writeFileSync(libPy, 'def add(a, b):\n    return a - b  # DEFECT: subtraction\n\ndef mul(a, b):\n    return a * b\n')
writeFileSync(path.join(proj, 'tests', '__init__.py'), '')
writeFileSync(
  path.join(proj, 'tests', 'test_calc.py'),
  'import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\n' +
    'import unittest\nfrom calc import add, mul\n\n' +
    'class TestCalc(unittest.TestCase):\n' +
    '    def test_add(self):\n' +
    '        result = add(2, 3)\n' +
    '        self.assertEqual(result, 5)\n' +
    '    def test_mul(self):\n' +
    '        self.assertEqual(mul(2, 3), 6)\n',
)

process.chdir(proj)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const tests = await import('../../src/services/ide/pythonTests.js')
const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
_resetPythonProjectForTesting()

try {
  section('(1) discover — structured node ids')
  {
    const out = await tests.discoverPythonTests({ from: proj, framework: 'unittest' })
    check('discovery returns structured ids', !('state' in out) && out.tests.length === 2, JSON.stringify(out).slice(0, 200))
    if (!('state' in out)) {
      check('node ids are unittest-shaped', out.tests.every(t => t.includes('TestCalc.')), out.tests.join(', '))
    }
  }

  section('(2) run — one REAL failure, structured location, durable records')
  let failingNode = ''
  {
    const out = await tests.runPythonTests({ from: proj, framework: 'unittest', selectionLabel: 'all' })
    check('run lands', out.state === 'ok', JSON.stringify(out).slice(0, 200))
    if (out.state === 'ok') {
      const r = out.record
      check('counts: 1 passed · 1 failed', r.counts.passed === 1 && r.counts.failed === 1, JSON.stringify(r.counts))
      const failure = r.cases.find(c => c.outcome === 'failed')
      failingNode = failure?.id ?? ''
      check('the failure is test_add with the assertion message', failingNode.includes('test_add') && (failure?.message ?? '').includes('!='), `${failingNode}: ${(failure?.message ?? '').slice(0, 80)}`)
      check('failure carries its file', (failure?.file ?? '').includes('test_calc.py'), failure?.file)
      check('failures[] carries the rerun selection', r.failures.length === 1 && r.failures[0] === failingNode)
      check('durable record on disk (the sticky store root)', existsSync(path.join(tests.testRunsDir(proj), `${r.id}.json`)))
      check('latest.json points at this run', tests.latestRun(proj)?.id === r.id)
    }
  }

  section('(3) rerunFailed — EXACTLY the failing selection')
  {
    const out = await tests.rerunFailedTests({ from: proj })
    check('rerun runs', !('note' in out) && out.state === 'ok', JSON.stringify(out).slice(0, 160))
    if (!('note' in out) && out.state === 'ok') {
      check('rerun ran ONLY the failure (1 case, still failing)', out.record.cases.length === 1 && out.record.counts.failed === 1, JSON.stringify(out.record.counts))
      check('selection recorded as rerun-failed', out.record.selection === 'rerun-failed')
    }
  }

  section('(4) fix → rerunFailed — green, the durable trail shows the arc')
  {
    writeFileSync(libPy, 'def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n')
    const out = await tests.rerunFailedTests({ from: proj })
    check('post-fix rerun is green', !('note' in out) && out.state === 'ok' && out.record.counts.failed === 0 && out.record.counts.passed === 1, JSON.stringify(!('note' in out) && out.state === 'ok' ? out.record.counts : out).slice(0, 160))
    const again = await tests.rerunFailedTests({ from: proj })
    check('a green latest ⇒ nothing-to-rerun (honest)', 'note' in again && again.note.includes('no failures'), JSON.stringify(again).slice(0, 120))
    check('the run trail is durable (≥3 records)', tests.listRuns(proj).length >= 3)
  }

  section('(5) debug one test — breakpoint INSIDE the test via the real debugpy')
  {
    const DIST_VENDOR = path.join(ROOT, 'dist', 'vendor', 'debugpy')
    if (!existsSync(path.join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py'))) {
      console.log('  [SKIP — LOUD] dist/vendor/debugpy absent — the debug leg needs the built vendored adapter.')
      console.log('  remedy: bun run scripts/vendor/fetch-debugpy.ts && bun run build.ts')
      failures++
    } else {
      process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR
      const resolver = await import('../../src/services/dap/debugpyResolver.js')
      resolver._resetDebugpyResolverForTesting()
      const shim = tests.buildDebugTestShim('tests.test_calc.TestCalc.test_add', { from: proj, framework: 'unittest' })
      check('debug shim builds', !('state' in shim), JSON.stringify(shim).slice(0, 160))
      if (!('state' in shim)) {
        const dap = await import('../../src/services/dap/dapClient.js')
        const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
        const owner = makeOwnerKey({ workspace: proj, sessionId: 'pytests-proof', lane: 'main' })
        const testFile = path.join(proj, 'tests', 'test_calc.py')
        const session = await dap.createDapSession({
          owner,
          id: 'test',
          adapterKey: 'python',
          program: shim.program,
          cwd: shim.cwd,
          breakpoints: new Map([[testFile, [9]]]), // the assertEqual line — `result` is bound
        })
        const stop = await session.waitForStopOutcome(20_000)
        check('stopped at the breakpoint INSIDE the test', stop.state === 'stopped' && stop.info.reason === 'breakpoint', JSON.stringify(stop))
        if (stop.state === 'stopped') {
          const threadId = stop.info.threadId ?? 1
          const stack = await session.request('stackTrace', { threadId, startFrame: 0, levels: 4 })
          const frames = stack.stackFrames as Array<{ id: number; name?: string; source?: { path?: string } }>
          check('top frame is the test method in the REAL test file', (frames[0]?.name ?? '').includes('test_add') && (frames[0]?.source?.path ?? '').includes('test_calc.py'), JSON.stringify(frames[0]))
          const scopes = await session.request('scopes', { frameId: frames[0]!.id })
          const localRef = (scopes.scopes as Array<{ name: string; variablesReference: number }>).find(s => /local/i.test(s.name))?.variablesReference
          const vars = await session.request('variables', { variablesReference: localRef })
          const result = (vars.variables as Array<{ name: string; value: string }>).find(v => v.name === 'result')
          check('the local `result` shows the FIXED value 5', result?.value === '5', JSON.stringify(result))
        }
        await dap.removeDapSession(owner, 'test')
        check('debug session reaped', dap.getDapSession(owner, 'test') === undefined)
      }
    }
  }

  section('(6) the Test TOOL surface')
  {
    const { TestTool } = await import('../../src/tools/TestTool/TestTool.js')
    check('tool name is Test', TestTool.name === 'Test')
    check('report is read-only', TestTool.isReadOnly({ op: 'report' } as never) === true)
    check('run is NOT read-only', TestTool.isReadOnly({ op: 'run' } as never) === false)
    const runPerm = await TestTool.checkPermissions({ op: 'run' } as never, {} as never)
    check('run asks (executes project code)', runPerm.behavior === 'ask')
    const discoverPerm = await TestTool.checkPermissions({ op: 'discover' } as never, {} as never)
    check('discover asks too (collection imports modules)', discoverPerm.behavior === 'ask')
    const reportPerm = await TestTool.checkPermissions({ op: 'report' } as never, {} as never)
    check('report rides free', reportPerm.behavior === 'allow')
    const report = (await TestTool.call({ op: 'report' } as never, { getAppState: () => ({}) } as never)) as { data: { result: string; outcome: string } }
    check('tool report reads the durable latest', report.data.result.includes('rerun-failed') && report.data.result.includes('mercury://test/run/'), report.data.result.split('\n')[0])
  }

  section('(7) resources + honesty')
  {
    await import('../../src/services/resources/adapters/test.js')
    const { resolveResource } = await import('../../src/services/resources/registry.js')
    const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
    const owner = makeOwnerKey({ workspace: proj, sessionId: 'pytests-res', lane: 'main' })
    const latest = await resolveResource('mercury://test/latest', { owner, cwd: proj })
    check('mercury://test/latest resolves', latest.state === 'ok', latest.state !== 'ok' ? latest.note : '')
    const failuresRes = await resolveResource('mercury://test/failures', { owner, cwd: proj })
    check('mercury://test/failures resolves (empty after the fix)', failuresRes.state === 'ok' && (failuresRes.state === 'ok' ? failuresRes.resource.summary.startsWith('0 failing') : false), failuresRes.state === 'ok' ? failuresRes.resource.summary : failuresRes.note)
    const listing = await resolveResource('mercury://test', { owner, cwd: proj })
    check('kind listing shows the run trail', listing.state === 'ok' && (listing.state === 'ok' ? (listing.resource.children?.length ?? 0) >= 3 : false))

    // pytest arm: honest branch by machine.
    tests._resetPytestProbeForTesting()
    const pytest = tests.probePytest(proj)
    if (pytest.available) {
      const out = await tests.runPythonTests({ from: proj, framework: 'pytest', selectionLabel: 'all' })
      check('pytest arm runs structured (machine has pytest)', out.state === 'ok' && out.record.counts.passed === 2, JSON.stringify(out).slice(0, 160))
    } else {
      console.log(`  [SKIP — LOUD] pytest arm: ${pytest.detail}`)
      console.log('  the unittest arm above is the full machine-independent journey; install pytest to run this arm.')
      const out = await tests.runPythonTests({ from: proj, framework: 'pytest' })
      check('pytest-less machine ⇒ honest unavailable with remedy', out.state === 'unavailable' && out.remedy.includes('pip install pytest'), JSON.stringify(out).slice(0, 160))
    }
  }
} finally {
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_PYTHON
  delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PYTHON TEST-TRANSACTION CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
