#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-python-project.ts
//  PROOF: ONE Python project/interpreter owner (ide —
//  services/ide/pythonProject.ts).
//
//    (A) PRECEDENCE — explicit MERCURY_PYTHON pin (authoritative: a broken
//        pin reports unavailable NAMING the pin, never a silent substitute)
//        → $VIRTUAL_ENV → project .venv → project venv → PATH python3; every
//        rung exercised with REAL spawn probes against fixture environments;
//        an env change re-selects immediately (key-based invalidation, no
//        TTL wait).
//    (B) WORKSHOP CONSUMPTION — the py kernel's probePythonInterpreter is
//        the shared selection: a pin routes the REAL kernel through the
//        pinned interpreter (live cell run); PATH sabotage still reads the
//        honest 'install Python 3' unavailability (the §V workshop law).
//    (C) DEBUG COUPLING — projectPythonDebugAdapter leads with the shared
//        selection, walks past a selected-but-pydevd-broken interpreter to
//        a machine fallback, and NEVER walks past an explicit pin.
//    (D) RESOURCE — mercury://ide/python/project resolves through the real
//        registry with the profile as structured truth; tools.ts carries
//        the side-effect registration import.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-python-project.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

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
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

// Clean slate for the env rungs this proof drives.
const savedEnv = { ...process.env }
function restoreEnv(): void {
  for (const k of ['MERCURY_PYTHON', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'MERCURY_DEBUGPY_VENDOR_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  process.env.PATH = savedEnv.PATH
}
delete process.env.MERCURY_PYTHON
delete process.env.VIRTUAL_ENV
delete process.env.CONDA_PREFIX

const proj = await import('../../src/services/ide/pythonProject.js')

/** A fixture "venv": a real executable python shim at <dir>/bin/python. */
function makeFakeVenv(dir: string): string {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const py = join(dir, 'bin', 'python')
  writeFileSync(py, `#!/bin/sh\nexec ${SYS_PY} "$@"\n`)
  chmodSync(py, 0o755)
  return py
}

if (!existsSync(SYS_PY)) {
  console.log(`\n  [SKIP — LOUD] ${SYS_PY} is absent on this machine; the precedence fixtures need one known-good interpreter.`)
  console.log('  (darwin always ships it via CommandLineTools; on other platforms adapt the fixture.)')
  process.exit(0)
}

console.log('============================================================')
console.log(' python project owner — precedence · workshop · debug · resource')
console.log('============================================================')

const arena = mkdtempSync(join(tmpdir(), 'python-project-'))
try {
  section('(A) precedence matrix (real spawn probes, fixture envs)')
  {
    const bare = join(arena, 'bare')
    mkdirSync(bare, { recursive: true })

    // A1 explicit pin wins and is verbatim.
    process.env.MERCURY_PYTHON = SYS_PY
    proj._resetPythonProjectForTesting()
    const pinned = proj.selectPythonInterpreter(bare)
    check('A1 explicit pin selected verbatim', pinned.state === 'ok' && pinned.command === SYS_PY && pinned.envKind === 'explicit', JSON.stringify(pinned).slice(0, 160))

    // A2 a broken pin NEVER falls through (authoritative).
    process.env.MERCURY_PYTHON = '/nonexistent/python-pin'
    proj._resetPythonProjectForTesting()
    const broken = proj.selectPythonInterpreter(bare)
    check('A2 broken pin ⇒ unavailable NAMING the pin (no silent substitute)',
      broken.state === 'unavailable' && broken.detail.includes('MERCURY_PYTHON') && broken.remedy.includes('MERCURY_PYTHON'),
      JSON.stringify(broken).slice(0, 200))

    // A3 env-change invalidates WITHOUT a reset (key-based cache).
    process.env.MERCURY_PYTHON = SYS_PY
    const reselected = proj.selectPythonInterpreter(bare)
    check('A3 env change re-selects immediately (no TTL wait, no reset)', reselected.state === 'ok' && reselected.command === SYS_PY)

    // A4 active VIRTUAL_ENV rung.
    delete process.env.MERCURY_PYTHON
    const activeVenv = join(arena, 'active-venv')
    makeFakeVenv(activeVenv)
    process.env.VIRTUAL_ENV = activeVenv
    proj._resetPythonProjectForTesting()
    const active = proj.selectPythonInterpreter(bare)
    check('A4 $VIRTUAL_ENV selected (active-venv rung)',
      active.state === 'ok' && active.command === join(activeVenv, 'bin', 'python') && active.envKind === 'active-venv',
      JSON.stringify(active).slice(0, 160))
    delete process.env.VIRTUAL_ENV

    // A5 project .venv rung (and .venv beats venv).
    const withVenvs = join(arena, 'proj-venvs')
    makeFakeVenv(join(withVenvs, '.venv'))
    makeFakeVenv(join(withVenvs, 'venv'))
    writeFileSync(join(withVenvs, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    proj._resetPythonProjectForTesting()
    const projVenv = proj.selectPythonInterpreter(withVenvs)
    check('A5 project .venv selected over venv/ and PATH',
      projVenv.state === 'ok' && projVenv.command === join(withVenvs, '.venv', 'bin', 'python') && projVenv.envKind === 'project-venv',
      JSON.stringify(projVenv).slice(0, 160))

    // A6 root detection: markers name the evidence.
    const rooted = proj.findPythonProjectRoot(withVenvs)
    check('A6 root detection carries marker evidence', rooted.root === withVenvs && rooted.markers.includes('pyproject.toml') && rooted.markers.includes('.venv'), JSON.stringify(rooted))

    // A7 bare dir ⇒ PATH python3 (system rung).
    proj._resetPythonProjectForTesting()
    const system = proj.selectPythonInterpreter(bare)
    check('A7 bare dir falls to PATH python3 (system rung)', system.state === 'ok' && system.envKind === 'system', JSON.stringify(system).slice(0, 160))
  }

  section('(B) workshop consumption — the kernel rides the shared selection')
  {
    const { probePythonInterpreter, _resetPythonProbeForTesting, runPythonCell } = await import(
      '../../src/services/workshop/pythonRuntime.js'
    )
    const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
    const owner = makeOwnerKey({ workspace: arena, sessionId: 'py-project-proof', lane: 'main' })
    const noBridge = {
      inspect: async () => 'no',
      tool: async () => 'no',
      agent: async () => 'no',
    }

    process.env.MERCURY_PYTHON = SYS_PY
    _resetPythonProbeForTesting()
    const probe = probePythonInterpreter()
    check('B1 workshop probe = the pinned interpreter', !('unavailable' in probe) && probe.command === SYS_PY && probe.version.includes('explicit'), JSON.stringify(probe))

    const cell = await runPythonCell({
      owner,
      cwd: arena,
      cell: { language: 'py', code: 'import sys; result = sys.version.split()[0]\nresult' },
      bridge: noBridge as never,
    })
    // The expected version is THE PINNED INTERPRETER'S OWN — asked live, not
    // a calibration-machine literal ('3.9' baked the operator's /usr/bin/
    // python3; CI ubuntu ships 3.12 — the F6 ambient-state class).
    const pinnedVersion = execFileSync(SYS_PY, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' }).trim()
    check('B2 a REAL cell runs on the pinned interpreter', cell.state === 'succeeded' && cell.valuePreview.includes(pinnedVersion), `${cell.state}: ${cell.valuePreview || cell.error} (want ${pinnedVersion})`)

    // The §V workshop availability law survives the delegation.
    delete process.env.MERCURY_PYTHON
    const realPath = process.env.PATH
    process.env.PATH = '/nonexistent-forge'
    _resetPythonProbeForTesting()
    const sabotaged = probePythonInterpreter()
    check('B3 PATH sabotage still reads honest-unavailable (install Python 3)', 'unavailable' in sabotaged && /install Python 3/.test(sabotaged.unavailable), JSON.stringify(sabotaged).slice(0, 200))
    process.env.PATH = realPath
    _resetPythonProbeForTesting()
    const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.js')
    await disposeOwner(owner)
  }

  section('(C) debug coupling — shared selection leads; pins never fall through')
  {
    const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'debugpy')
    const resolver = await import('../../src/services/dap/debugpyResolver.js')
    if (!existsSync(join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py'))) {
      console.log('  [SKIP — LOUD] dist/vendor/debugpy absent — build with the vendor cache first (fetch-debugpy + build).')
      failures++
    } else {
      process.env.MERCURY_DEBUGPY_VENDOR_DIR = DIST_VENDOR

      // C1 pinned + healthy ⇒ the debug adapter uses EXACTLY the pin.
      process.env.MERCURY_PYTHON = SYS_PY
      proj._resetPythonProjectForTesting()
      resolver._resetDebugpyResolverForTesting()
      const viaPin = proj.projectPythonDebugAdapter(arena)
      check('C1 pinned interpreter drives the debug adapter', viaPin.state === 'ok' && viaPin.provenance.interpreter === SYS_PY && viaPin.provenance.adapterSource === 'bundled', JSON.stringify(viaPin.state === 'ok' ? viaPin.provenance : viaPin).slice(0, 200))

      // C2 a broken pin NEVER falls through to machine fallbacks.
      process.env.MERCURY_PYTHON = '/nonexistent/python-pin'
      proj._resetPythonProjectForTesting()
      resolver._resetDebugpyResolverForTesting()
      const brokenPin = proj.projectPythonDebugAdapter(arena)
      check('C2 broken pin ⇒ debug unavailable naming the pin (exclusive)', brokenPin.state === 'unavailable' && brokenPin.reason.includes('/nonexistent/python-pin'), JSON.stringify(brokenPin).slice(0, 220))

      // C3 no pin ⇒ selection leads, deeper health probe may walk on.
      delete process.env.MERCURY_PYTHON
      proj._resetPythonProjectForTesting()
      resolver._resetDebugpyResolverForTesting()
      const walked = proj.projectPythonDebugAdapter(arena)
      check('C3 unpinned resolution lands on a HEALTHY interpreter (walks past pydevd-broken selections)', walked.state === 'ok' && walked.provenance.lastProbe.includes('pydevd import chain OK'), JSON.stringify(walked.state === 'ok' ? walked.provenance : walked).slice(0, 220))
      delete process.env.MERCURY_DEBUGPY_VENDOR_DIR
      resolver._resetDebugpyResolverForTesting()
    }
  }

  section('(D) the mercury://ide/python/project resource')
  {
    await import('../../src/services/resources/adapters/ide.js')
    const { resolveResource } = await import('../../src/services/resources/registry.js')
    const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
    const owner = makeOwnerKey({ workspace: arena, sessionId: 'py-res-proof', lane: 'main' })
    const withVenvs = join(arena, 'proj-venvs')
    process.env.MERCURY_PYTHON = SYS_PY
    proj._resetPythonProjectForTesting()
    const res = await resolveResource('mercury://ide/python/project', { owner, cwd: withVenvs })
    check('D1 resource resolves ok', res.state === 'ok', res.state !== 'ok' ? res.note : '')
    if (res.state === 'ok') {
      const structured = res.resource.structured as { projectRoot?: string; interpreter?: { command?: string } }
      check('D2 profile roots at the fixture project', structured.projectRoot === withVenvs, String(structured.projectRoot))
      check('D3 profile carries the pinned interpreter', structured.interpreter?.command === SYS_PY)
      check('D4 summary is a one-line truth', res.resource.summary.includes(SYS_PY) && res.resource.summary.includes('debugpy'), res.resource.summary)
    }
    const listing = await resolveResource('mercury://ide', { owner, cwd: withVenvs })
    check('D5 kind listing names the projection', listing.state === 'ok' && (listing.state === 'ok' ? listing.resource.children?.some(c => c.ref === 'mercury://ide/python/project') === true : false))
    check('D6 tools.ts carries the side-effect registration', readFileSync(join(ROOT, 'src', 'tools.ts'), 'utf8').includes("./services/resources/adapters/ide.js"))
  }
} finally {
  restoreEnv()
  rmSync(arena, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PYTHON PROJECT-OWNER CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
