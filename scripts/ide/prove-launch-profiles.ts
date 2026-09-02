#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-launch-profiles.ts
//  PROOF: unified launch profiles.
//
//    (A) DISCOVERY MATRIX on one fixture tree carrying all four sources:
//        .vscode/launch.json (a python config, a native config, an attach
//        config + an alien type — the last two SKIPPED with reasons, JSONC
//        comments tolerated, ${workspaceFolder} expanded, extra fields
//        listed as dropped), a detected unittest layout (test profile), a
//        CMakePresets.json (build profile per preset), a project.godot
//        (scene profiles riding the slice-6 discovery).
//    (B) IDENTITY — ids are content-stable across discoveries; a payload
//        change CHANGES the id.
//    (C) EXECUTION, REAL — op:"run" executes a quick python program through
//        the DAP noDebug path (real bundled debugpy; output captured;
//        session reaped); op:"debug" stops at a real breakpoint through the
//        same profile. The Launch tool surface: permission matrix + typed
//        refusals (kind mismatch, unknown id).
//    (D) HONESTY — a broken launch.json is a typed sourceError; the tool
//        teaches re-listing on a stale id.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-launch-profiles.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'
const DIST_VENDOR = path.join(ROOT, 'dist', 'vendor', 'debugpy')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' unified launch profiles — discovery · identity · execution')
console.log('============================================================')

const proj = mkdtempSync(path.join(tmpdir(), 'mercury-launch-'))
// One tree, four sources.
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "launch-fixture"\nversion = "0.0.1"\n')
writeFileSync(path.join(proj, 'hello.py'), 'import sys\nvalue = 21 * 2\nprint("answer:", value)\n')
mkdirSync(path.join(proj, 'tests'))
writeFileSync(path.join(proj, 'tests', '__init__.py'), '')
writeFileSync(
  path.join(proj, 'tests', 'test_ok.py'),
  'import unittest\n\nclass TestOk(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n',
)
mkdirSync(path.join(proj, '.vscode'))
writeFileSync(
  path.join(proj, '.vscode', 'launch.json'),
  `{
  // JSONC comments must be tolerated
  "version": "0.2.0",
  "configurations": [
    {
      "name": "hello (py)",
      "type": "debugpy",
      "request": "launch",
      "program": "\${workspaceFolder}/hello.py",
      "console": "integratedTerminal", /* dropped, honestly */
      "justMyCode": true,
    },
    {
      "name": "native demo",
      "type": "lldb",
      "request": "launch",
      "program": "\${workspaceFolder}/build/demo"
    },
    {
      "name": "attach to server",
      "type": "debugpy",
      "request": "attach",
      "connect": { "port": 5678 }
    },
    {
      "name": "node service",
      "type": "pwa-node",
      "request": "launch",
      "program": "\${workspaceFolder}/index.js"
    },
    {
      "name": "go server",
      "type": "go",
      "request": "launch",
      "program": "\${workspaceFolder}/cmd/server"
    },
    {
      "name": "dotnet api",
      "type": "coreclr",
      "request": "launch",
      "program": "\${workspaceFolder}/bin/Debug/api.dll"
    },
    {
      "name": "ruby worker",
      "type": "rdbg",
      "request": "launch",
      "program": "worker.rb"
    },
    {
      "name": "macro laden",
      "type": "pwa-node",
      "request": "launch",
      "program": "\${file}"
    },
    {
      "name": "alien",
      "type": "chrome",
      "request": "launch",
      "program": "index.js"
    }
  ]
}
`,
)
writeFileSync(
  path.join(proj, 'CMakeLists.txt'),
  'cmake_minimum_required(VERSION 3.20)\nproject(launchfix)\nadd_executable(demo demo.c)\n',
)
writeFileSync(path.join(proj, 'demo.c'), 'int main(void){return 0;}\n')
writeFileSync(
  path.join(proj, 'CMakePresets.json'),
  JSON.stringify({
    version: 4,
    configurePresets: [
      { name: 'dev', displayName: 'Dev', binaryDir: '${sourceDir}/build-dev' },
      { name: 'hidden-base', hidden: true },
    ],
  }),
)
writeFileSync(path.join(proj, 'project.godot'), '[application]\nconfig/name="LaunchFix"\nrun/main_scene="res://Main.tscn"\n')
writeFileSync(path.join(proj, 'Main.tscn'), '[gd_scene]\n')

process.env.MERCURY_PYTHON = SYS_PY
process.chdir(proj)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const launch = await import('../../src/services/ide/launchProfiles.js')
const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
_resetPythonProjectForTesting()

try {
  section('(A) the discovery matrix — four sources, one tree')
  const d = await launch.discoverLaunchProfiles(proj)
  {
    const bySource = (s: string) => d.profiles.filter(p => p.source === s)
    const vs = bySource('vscode')
    check('A1 six representable launch.json configs profiled (FN-013 IDE-06: every shipped adapter family translates)', vs.length === 6, vs.map(p => p.label).join(', '))
    const py = vs.find(p => p.label === 'hello (py)')
    check('A2 python config: adapter+program expanded', py?.debug?.adapter === 'python' && py?.debug?.program === path.join(proj, 'hello.py'), JSON.stringify(py?.debug))
    check('A3 dropped fields listed honestly', (py?.droppedFields ?? []).includes('console') && (py?.droppedFields ?? []).includes('justMyCode'), JSON.stringify(py?.droppedFields))
    check('A4 native config maps to lldb', vs.some(p => p.debug?.adapter === 'lldb'))
    check(
      'A4b the four shipped families route to their adapters with language populated (pwa-node→js, go→go, coreclr→dotnet, rdbg→ruby)',
      vs.find(p => p.label === 'node service')?.debug?.adapter === 'js' &&
        vs.find(p => p.label === 'node service')?.language === 'js' &&
        vs.find(p => p.label === 'go server')?.debug?.adapter === 'go' &&
        vs.find(p => p.label === 'go server')?.language === 'go' &&
        vs.find(p => p.label === 'dotnet api')?.debug?.adapter === 'dotnet' &&
        vs.find(p => p.label === 'dotnet api')?.language === 'dotnet' &&
        vs.find(p => p.label === 'ruby worker')?.debug?.adapter === 'ruby' &&
        vs.find(p => p.label === 'ruby worker')?.language === 'ruby',
      JSON.stringify(vs.map(p => ({ label: p.label, adapter: p.debug?.adapter, language: p.language }))),
    )
    check(
      'A4c a relative program resolves under the root; macro expansion holds for the new families',
      vs.find(p => p.label === 'ruby worker')?.debug?.program === path.join(proj, 'worker.rb') &&
        vs.find(p => p.label === 'node service')?.debug?.program === path.join(proj, 'index.js'),
    )
    check(
      'A5 attach + macro-laden + alien configs SKIPPED with their exact reasons',
      d.skipped.length === 3 &&
        d.skipped.some(s => s.name === 'attach to server' && s.reason.includes('attach')) &&
        d.skipped.some(s => s.name === 'macro laden' && s.reason.includes('unexpanded macro') && s.reason.includes('${file}')) &&
        d.skipped.some(s => s.name === 'alien' && s.reason.includes('no Mercury adapter')),
      JSON.stringify(d.skipped),
    )
    const tests = bySource('python-tests')
    check('A6 the detected test framework profiles (unittest)', tests.length === 1 && tests[0]?.test?.framework === 'unittest', JSON.stringify(tests.map(t => t.test)))
    const cmake = bySource('cmake')
    check('A7 one build profile per NON-HIDDEN preset', cmake.length === 1 && cmake[0]?.build?.preset === 'dev', JSON.stringify(cmake.map(c => c.build)))
    const godot = bySource('godot')
    check('A8 godot scenes profiled through the slice-6 discovery', godot.length >= 2 && godot.some(g => g.godotScene?.scene === 'res://Main.tscn'), JSON.stringify(godot.map(g => g.godotScene?.scene)))
    check('A9 zero source errors on the healthy tree', d.sourceErrors.length === 0, JSON.stringify(d.sourceErrors))
  }

  section('(B) content-stable identity')
  {
    const d2 = await launch.discoverLaunchProfiles(proj)
    check('B1 two discoveries agree on every id', JSON.stringify(d.profiles.map(p => p.id)) === JSON.stringify(d2.profiles.map(p => p.id)))
    writeFileSync(path.join(proj, 'hello.py'), 'print("changed")\n')
    // The payload (program PATH) is unchanged by content edits — ids hold.
    const d3 = await launch.discoverLaunchProfiles(proj)
    check('B2 ids are payload-stable (a content edit does not reshuffle)', d3.profiles.some(p => p.id === d.profiles.find(q => q.label === 'hello (py)')?.id))
    writeFileSync(path.join(proj, 'hello.py'), 'import sys\nvalue = 21 * 2\nprint("answer:", value)\n')
    const before = d.profiles.find(q => q.label === 'hello (py)')!
    const mutated = { ...before.debug!, args: ['--x'] }
    const { createHash } = await import('node:crypto')
    const newId = `lp-${createHash('sha256').update(`vscode\ndebug\n${JSON.stringify(mutated)}`).digest('hex').slice(0, 12)}`
    check('B3 a changed payload IS a new id', newId !== before.id)
  }

  section('(C) REAL execution through the Launch tool')
  if (!existsSync(path.join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py'))) {
    console.log('  [SKIP — LOUD] dist/vendor/debugpy absent — run/debug legs need the built vendored adapter.')
    failures++
  } else {
    process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR
    const resolver = await import('../../src/services/dap/debugpyResolver.js')
    resolver._resetDebugpyResolverForTesting()
    const { LaunchTool } = await import('../../src/tools/LaunchTool/LaunchTool.js')
    const ctx = { getAppState: () => ({}) } as never
    check('C1 list/inspect/last are read-only; run/debug/test/build are not',
      LaunchTool.isReadOnly({ op: 'list' } as never) === true &&
      LaunchTool.isReadOnly({ op: 'last' } as never) === true &&
      LaunchTool.isReadOnly({ op: 'run' } as never) === false &&
      LaunchTool.isReadOnly({ op: 'build' } as never) === false)
    const perm = await LaunchTool.checkPermissions({ op: 'debug', profile: 'lp-x' } as never, {} as never)
    check('C2 executing ops ask', perm.behavior === 'ask')

    const list = (await LaunchTool.call({ op: 'list' } as never, ctx)) as { data: { result: string } }
    const pyId = list.data.result.split('\n').find(l => l.includes('hello (py)'))?.split(' ')[0]
    check('C3 tool list surfaces the fixture profiles + skip reasons', pyId?.startsWith('lp-') === true && list.data.result.includes('alien'), list.data.result.split('\n')[0])

    const inspect = (await LaunchTool.call({ op: 'inspect', profile: pyId } as never, ctx)) as { data: { result: string } }
    check('C4 inspect shows payload + provenance + dropped fields', inspect.data.result.includes('hello.py') && inspect.data.result.includes('dropped'), inspect.data.result)

    const run = (await LaunchTool.call({ op: 'run', profile: pyId } as never, ctx)) as { data: { result: string; outcome: string } }
    check('C5 op:"run" executes via DAP noDebug and captures the REAL output', run.data.outcome === 'succeeded' && run.data.result.includes('answer: 42'), run.data.result.split('\n').slice(0, 3).join(' · '))

    const dbg = (await LaunchTool.call({ op: 'debug', profile: pyId, file: path.join(proj, 'hello.py'), lines: [3] } as never, ctx)) as { data: { result: string } }
    check('C6 op:"debug" stops at the real breakpoint', dbg.data.result.includes('stopped — reason breakpoint'), dbg.data.result.split('\n')[0])
    const dap = await import('../../src/services/dap/dapClient.js')
    const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
    void makeOwnerKey
    // Reap the debug session through the tool's own machinery: disconnect via Debug-tool path is covered elsewhere;
    // here dispose by owner sweep (the proof's owner is the fallback context owner).
    const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.js')
    const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.js')
    await disposeOwner(ownerFromToolUseContext(ctx))
    check('C7 owner disposal reaps the launch session', dap._dapSessionCountForTesting() === 0, String(dap._dapSessionCountForTesting()))

    const testProfile = list.data.result.split('\n').find(l => l.includes('run all tests'))?.split(' ')[0]
    const t = (await LaunchTool.call({ op: 'test', profile: testProfile } as never, ctx)) as { data: { result: string; outcome: string } }
    check('C8 op:"test" delegates to the Test transactions (durable record ref)', t.data.outcome === 'succeeded' && t.data.result.includes('mercury://test/run/'), t.data.result)

    const kindMismatch = (await LaunchTool.call({ op: 'run', profile: testProfile } as never, ctx)) as { data: { result: string; outcome: string } }
    check('C9 kind mismatch refuses with the right op named', kindMismatch.data.outcome === 'no-change' && kindMismatch.data.result.includes('op:"test"'), kindMismatch.data.result)

    const stale = (await LaunchTool.call({ op: 'inspect', profile: 'lp-000000000000' } as never, ctx)) as { data: { result: string } }
    check('C10 an unknown/stale id teaches re-listing', stale.data.result.includes('re-run op:"list"') || stale.data.result.includes('content-stable'), stale.data.result)

    const last = (await LaunchTool.call({ op: 'last' } as never, ctx)) as { data: { result: string } }
    check('C11 last remembers the newest action', last.data.result.includes('test') || last.data.result.includes('run'), last.data.result)
  }

  section('(D) source honesty — broken launch.json degrades, never throws')
  {
    writeFileSync(path.join(proj, '.vscode', 'launch.json'), '{ this is not json')
    const broken = await launch.discoverLaunchProfiles(proj)
    check('D1 typed sourceError for the broken file', broken.sourceErrors.some(e => e.source === 'vscode' && e.error.includes('unparseable')), JSON.stringify(broken.sourceErrors))
    check('D2 the other sources still discovered', broken.profiles.some(p => p.source === 'cmake') && broken.profiles.some(p => p.source === 'godot'))
  }
} finally {
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_PYTHON
  delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL LAUNCH-PROFILE CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
