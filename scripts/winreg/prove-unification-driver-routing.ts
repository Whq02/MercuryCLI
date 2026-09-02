#!/usr/bin/env bun
// ============================================================================
//  scripts/winreg/prove-unification-driver-routing.ts — the unification
//  render proof routes to the ConPTY engine on win32 (TASK-015 F2).
//
//  THE LAW: a capture entrypoint selects its engine through the driver's
//  selection table (scripts/lib/captureDriver.ts) — the POSIX PTY engine on
//  POSIX, the Windows ConPTY engine on win32 — over ONE cfg grammar; it
//  never hard-exits off the POSIX kind and never names an engine file
//  itself. This prover is the STRUCTURAL half, provable from any OS: the
//  table, the resolver's win32 arm, the prover's routing, its cfg vocabulary
//  against the Windows engine's grammar, and the loud fence on the one
//  POSIX-signal leg. The behavioral half — prove-session-unification under a
//  real ConPTY — is Windows-box work.
//
//    §1 the selection table names both engines, and both exist;
//    §2 the resolver routes win32 to the ConPTY engine (PATHEXT probe,
//       MERCURY_PYTHON pin, the honest unavailable remedy) and argv[0]
//       follows the driver (a bare `node` on POSIX; the PATH hit on win32 —
//       the ConPTY backend concatenates appname + cmdline and never searches
//       PATH);
//    §3 prove-session-unification routes through the table (source pins):
//       gates on `unavailable` only, spawns the table's entry, resolves
//       argv[0] through the driver, fences the signal leg by engine kind;
//    §4 every cfg/send token the unification prover writes is read by
//       vshot-win.py (the identical grammar the amendment names).
//
//  Poison: on the base the prover hard-exits unless the driver is
//  `posix-pty` and spawns scripts/ui/vshot.py by name (§3 red); the table
//  itself did not exist (§1 red).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { CAPTURE_ENGINE_ENTRY, captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver } from '../lib/captureDriver.ts'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')

t.section('§1 the selection table')
{
  t.check('posix-pty → scripts/ui/vshot.py', CAPTURE_ENGINE_ENTRY['posix-pty'] === 'scripts/ui/vshot.py')
  t.check('windows-conpty → scripts/winreg/vshot-win.py', CAPTURE_ENGINE_ENTRY['windows-conpty'] === 'scripts/winreg/vshot-win.py')
  for (const entry of Object.values(CAPTURE_ENGINE_ENTRY)) {
    t.check(`${entry} exists`, existsSync(join(REPO, entry)))
  }
}

t.section('§2 the resolver routes win32 to the ConPTY engine')
{
  const scratch = mkdtempSync(join(tmpdir(), 'unify-route-'))
  try {
    writeFileSync(join(scratch, 'python.exe'), '')
    writeFileSync(join(scratch, 'node.exe'), '')
    const winEnv = { PATH: scratch, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    const win = resolveCaptureDriver({ platform: 'win32', env: winEnv })
    t.check('win32 with a python on PATH → windows-conpty', win.kind === 'windows-conpty', win.kind)
    t.check(
      '… its interpreter is the PATHEXT hit',
      win.kind === 'windows-conpty' && win.python === join(scratch, 'python.exe'),
      win.kind === 'windows-conpty' ? win.python : win.kind,
    )
    t.check(
      '… its entry is the ConPTY engine',
      win.kind !== 'unavailable' && captureEngineEntry(win, REPO) === join(REPO, 'scripts', 'winreg', 'vshot-win.py'),
    )
    t.check(
      '… argv[0] resolves node to the PATH hit (the ConPTY backend never searches PATH)',
      win.kind !== 'unavailable' && resolveCaptureArgv0('node', win, winEnv) === join(scratch, 'node.exe'),
    )
    t.check(
      '… a name with no PATH hit stays bare (the engine reports the spawn failure, never a silent substitute)',
      win.kind !== 'unavailable' && resolveCaptureArgv0('mercury-launcher', win, winEnv) === 'mercury-launcher',
    )
    const pinned = resolveCaptureDriver({ platform: 'win32', env: { PATH: '', MERCURY_PYTHON: 'C:\\py\\python.exe' } })
    t.check('the MERCURY_PYTHON pin wins on win32', pinned.kind === 'windows-conpty' && pinned.python === 'C:\\py\\python.exe')
    const bare = resolveCaptureDriver({ platform: 'win32', env: { PATH: '' } })
    t.check(
      'win32 without python → unavailable, naming the ConPTY engine and the hosted lane',
      bare.kind === 'unavailable' && bare.remedy.includes('scripts/winreg') && bare.remedy.includes('windows-ui'),
      bare.kind,
    )
    const posix = resolveCaptureDriver({ platform: 'darwin', env: { MERCURY_PYTHON: process.execPath } })
    t.check('POSIX → posix-pty over the pinned interpreter', posix.kind === 'posix-pty' && posix.python === process.execPath, posix.kind)
    t.check(
      '… its entry is the PTY engine',
      posix.kind !== 'unavailable' && captureEngineEntry(posix, REPO) === join(REPO, 'scripts', 'ui', 'vshot.py'),
    )
    t.check(
      '… argv[0] keeps the bare name on POSIX (the POSIX path unchanged)',
      posix.kind !== 'unavailable' && resolveCaptureArgv0('node', posix, winEnv) === 'node',
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

t.section('§3 prove-session-unification routes through the table (source pins)')
{
  const src = readFileSync(join(REPO, 'scripts/switchboard/prove-session-unification.ts'), 'utf8')
  t.check('imports the table and the argv[0] resolver', src.includes('captureEngineEntry') && src.includes('resolveCaptureArgv0'))
  t.check("gates on 'unavailable' only", src.includes("driver.kind === 'unavailable'") && !src.includes("driver.kind !== 'posix-pty'"))
  t.check("spawns the table's entry", src.includes('[ENGINE, cfgPath]') && src.includes('captureEngineEntry(driver, REPO)'))
  t.check(
    'never names an engine file itself (no quoted vshot.py / vshot-win.py token, no spawn of a hard-coded engine path)',
    !/['"]vshot(?:-win)?\.py['"]/.test(src) && !/spawn\(driver\.python,\s*\[join\(REPO/.test(src),
  )
  t.check(
    'argv[0] rides the driver at both argv doors',
    src.includes("resolveCaptureArgv0('node', driver)") && src.includes('[NODE, BIN_UNDER_TEST') && src.includes('[NODE, join(REPO') && !src.includes("['node', BIN_UNDER_TEST") && !src.includes("['node', join(REPO"),
  )
  t.check(
    'the POSIX-signal leg is fenced by engine kind, loudly',
    src.includes("driver.kind === 'windows-conpty' && drive.sends.some(s => 'signal' in s)") && src.includes('[SKIP]'),
  )
}

t.section("§4 the unification prover's cfg vocabulary is the Windows engine's grammar")
{
  const src = readFileSync(join(REPO, 'scripts/switchboard/prove-session-unification.ts'), 'utf8')
  const win = readFileSync(join(REPO, 'scripts/winreg/vshot-win.py'), 'utf8')
  // The grammar prove-capture-grammar pins; a token the unification prover
  // writes as a cfg/send key must be one the Windows engine reads.
  const GRAMMAR = [
    'cols', 'rows', 'total', 'argv', 'sends', 'out', 'readyText', 'readySettleTicks', 'stableTicks', 'resizes', 'cwd', 'stableRegion', 'requireStable',
    'atTick', 'afterPrevTicks', 'awaitText', 'awaitRaw', 'minTick', 'awaitSettleTicks', 'awaitStableTicks', 'data', 'mark', 'requireAwait',
    'awaitStableRegion', 'targetText', 'targetDx', 'signal',
  ]
  const used = GRAMMAR.filter(k => new RegExp(`(?:^|[\\s{,(])${k}\\s*:`, 'm').test(src))
  t.check('the prover writes grammar tokens (census non-empty)', used.length >= 10, used.join(','))
  for (const k of used) t.check(`vshot-win.py reads "${k}"`, win.includes(`"${k}"`))
}

console.log("\n[NOTE] the behavioral half — prove-session-unification under a real ConPTY — is the field box's next capture wave (no win32 box here); this prover is the structural floor.")
t.finish('prove-unification-driver-routing')
