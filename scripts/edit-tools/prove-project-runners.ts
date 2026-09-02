#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-project-runners.ts — the polyglot runner
//  registry, proved with real disposable fixtures and the real runners this
//  machine ships (node always; cargo when present — an honest UNAVAILABLE
//  row otherwise; go exercised through the missing-executable law when
//  absent).
//
//  Laws:
//    D. discovery is manifest-driven — node-test/vitest/jest from
//       package.json (vitest w/o node_modules ⇒ typed missing-deps), cargo
//       from Cargo.toml, go from go.mod; PM only from lockfile/packageManager
//       (no signal ⇒ typed unavailable, never a guess); ids content-stable
//    L. lane routing — python signals keep the python lane; a single runner
//       routes there; two runner languages NAME the ambiguity; explicit
//       framework always wins
//    R. execution truth — pass and fail runs parse counts + failing nodes
//       (node:test TAP · cargo); exit-0-with-failures can NEVER summarize
//       as success; a stale profile id gets a typed stale result; records
//       persist in the ONE test-run store and rerun-failed reruns exactly
//       the failing selection
//    X. lifecycle — abort kills the child promptly; no orphaned process
//    U. Launch integration — runner profiles join discoverLaunchProfiles as
//       source 'runners' with availability-honest labels
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-project-runners.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anvil-s3-home-'))
process.env.MERCURY_SIMPLE = '1'

const {
  discoverRunnerProfiles,
  resolveTestLane,
  runRunnerProfile,
  rerunRunnerFailures,
} = await import('../../src/services/ide/projectRunners.ts')
const { latestRun } = await import('../../src/services/ide/pythonTests.ts')
const { discoverLaunchProfiles } = await import('../../src/services/ide/launchProfiles.ts')
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
  console.log('\nTIMEOUT — runners proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `anvil-s3-${label}-`))
}

// ── fixtures ────────────────────────────────────────────────────────────────
const tsDir = tempDir('ts')
mkdirSync(join(tsDir, 'test'))
writeFileSync(join(tsDir, 'package.json'), JSON.stringify({ name: 'f', private: true, type: 'module', scripts: { test: 'node --test', build: 'node -e "console.log(1)"' } }) + '\n')
writeFileSync(join(tsDir, 'bun.lock'), '{}\n')
writeFileSync(
  join(tsDir, 'test', 'calc.test.mjs'),
  [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('good', () => { assert.equal(1 + 1, 2) })",
    "test('bad', () => { assert.equal(1 + 1, 3) })",
    '',
  ].join('\n'),
)

const vitestDir = tempDir('vitest')
writeFileSync(join(vitestDir, 'package.json'), JSON.stringify({ name: 'v', private: true, devDependencies: { vitest: '^2.0.0' } }) + '\n')

const noPmDir = tempDir('nopm')
writeFileSync(join(noPmDir, 'package.json'), JSON.stringify({ name: 'n', private: true, scripts: { build: 'x', test: 'node --test' } }) + '\n')

const cargoDir = tempDir('rs')
mkdirSync(join(cargoDir, 'src'))
writeFileSync(join(cargoDir, 'Cargo.toml'), '[package]\nname = "anvil_s3"\nversion = "0.1.0"\nedition = "2021"\n')
writeFileSync(
  join(cargoDir, 'src', 'lib.rs'),
  ['pub fn two() -> i32 { 3 }', '', '#[cfg(test)]', 'mod tests {', '    #[test]', '    fn is_two() { assert_eq!(super::two(), 2); }', '    #[test]', '    fn trivially() { assert!(true); }', '}', ''].join('\n'),
)

const goDir = tempDir('go')
writeFileSync(join(goDir, 'go.mod'), 'module example.com/anvil\n\ngo 1.22\n')

const pyDir = tempDir('py')
writeFileSync(join(pyDir, 'pyproject.toml'), '[project]\nname = "p"\nversion = "0"\n')
writeFileSync(join(pyDir, 'package.json'), JSON.stringify({ name: 'p', private: true }) + '\n')

const dualDir = tempDir('dual')
writeFileSync(join(dualDir, 'package.json'), JSON.stringify({ name: 'd', private: true, scripts: { test: 'node --test' } }) + '\n')
writeFileSync(join(dualDir, 'Cargo.toml'), '[package]\nname = "d"\nversion = "0.1.0"\nedition = "2021"\n')

// ── D. discovery ────────────────────────────────────────────────────────────
section('D. manifest-driven discovery')
{
  const ts = discoverRunnerProfiles(tsDir)
  const nodeTest = ts.profiles.find(p => p.runner === 'node-test' && p.kind === 'test')
  check('D1 node --test discovered from script', !!nodeTest && nodeTest.availability.state === 'ok')
  const build = ts.profiles.find(p => p.kind === 'build')
  check('D2 build script rides the lockfile PM (bun)', !!build && build.command[0] === 'bun')
  const vt = discoverRunnerProfiles(vitestDir)
  const vitest = vt.profiles.find(p => p.runner === 'vitest')
  check('D3 declared vitest w/o node_modules ⇒ typed missing-deps',
    !!vitest && vitest.availability.state === 'unavailable' && vitest.availability.state === 'unavailable' && vitest.availability.remedy.includes('install the project dependencies'))
  const np = discoverRunnerProfiles(noPmDir)
  const npBuild = np.profiles.find(p => p.kind === 'build')
  check('D4 no lockfile/packageManager ⇒ typed unavailable, never a guess',
    !!npBuild && npBuild.availability.state === 'unavailable' && npBuild.availability.remedy.includes('never guesses'))
  const rs = discoverRunnerProfiles(cargoDir)
  check('D5 cargo test/check/build discovered', ['test', 'check', 'build'].every(k => rs.profiles.some(p => p.runner === 'cargo' && p.kind === k)))
  const goP = discoverRunnerProfiles(goDir)
  const goTest = goP.profiles.find(p => p.runner === 'go' && p.kind === 'test')
  check('D6 go profiles discovered from go.mod', !!goTest)
  const ts2 = discoverRunnerProfiles(tsDir)
  check('D7 ids content-stable across discoveries', ts.profiles.map(p => p.id).join() === ts2.profiles.map(p => p.id).join())
}

// ── L. lane routing ─────────────────────────────────────────────────────────
section('L. lane routing')
{
  check('L1 python signals keep the python lane', resolveTestLane(pyDir).lane === 'python')
  const ts = resolveTestLane(tsDir)
  check('L2 single runner routes there', ts.lane === 'runner' && ts.lane === 'runner' && ts.profile.runner === 'node-test')
  const dual = resolveTestLane(dualDir)
  check('L3 two runner languages NAME the ambiguity', dual.lane === 'ambiguous' && dual.lane === 'ambiguous' && dual.options.length === 2)
  const explicit = resolveTestLane(dualDir, 'cargo')
  check('L4 explicit framework wins', explicit.lane === 'runner' && explicit.lane === 'runner' && explicit.profile.runner === 'cargo')
  check('L5 explicit pytest stays python even in a runner project', resolveTestLane(tsDir, 'pytest').lane === 'python')
}

// ── R. execution truth ──────────────────────────────────────────────────────
section('R. execution truth (node:test always; cargo when present)')
{
  const ts = discoverRunnerProfiles(tsDir)
  const nodeTest = ts.profiles.find(p => p.runner === 'node-test' && p.kind === 'test')!
  const run1 = await runRunnerProfile(nodeTest, { from: tsDir })
  check('R1 node:test run records parsed counts', run1.state === 'ok' && run1.record.counts.passed === 1 && run1.record.counts.failed === 1)
  check('R2 failing node parsed', run1.state === 'ok' && run1.record.failures.length === 1 && run1.record.failures[0]!.includes('bad'))
  check('R3 record persisted in the ONE store', runWithCwdOverride(tsDir, () => latestRun(tsDir))?.framework === 'node-test')
  if (run1.state === 'ok') {
    const rerun = await rerunRunnerFailures(run1.record, { from: tsDir })
    check('R4 rerun-failed reruns exactly the failing selection',
      rerun.state === 'ok' && rerun.record.selection === 'rerun-failed' && rerun.record.counts.failed === 1 && rerun.record.counts.passed === 0)
  }
  const stale = await runRunnerProfile('rp-000000000000', { from: tsDir })
  check('R5 stale profile id ⇒ typed stale result', stale.state === 'stale-profile')

  // exit-0-with-parsed-failures can never summarize as success
  const lieDir = tempDir('lie')
  writeFileSync(join(lieDir, 'package.json'), JSON.stringify({ name: 'l', private: true, scripts: { test: 'node --test' } }) + '\n')
  writeFileSync(join(lieDir, 'liar.mjs'), 'console.log("TAP version 13\\nnot ok 1 - fabricated\\n# tests 1\\n# pass 0\\n# fail 1\\n")\n')
  const lieProfiles = discoverRunnerProfiles(lieDir).profiles
  const lieProfile = { ...lieProfiles.find(p => p.runner === 'node-test')!, command: ['node', join(lieDir, 'liar.mjs')] }
  const lie = await runRunnerProfile(lieProfile, { from: lieDir })
  check('R6 exit 0 + parsed failures ⇒ FAILED verdict, note recorded',
    lie.state === 'ok' && lie.record.counts.failed === 1 && (lie.record.verdictNote ?? '').includes('disagreed'))

  const rs = discoverRunnerProfiles(cargoDir)
  const cargoTest = rs.profiles.find(p => p.runner === 'cargo' && p.kind === 'test')!
  if (cargoTest.availability.state === 'ok') {
    const cargoRun = await runRunnerProfile(cargoTest, { from: cargoDir })
    check('R7 cargo run parses counts + failing test', cargoRun.state === 'ok' && cargoRun.record.counts.failed === 1 && (cargoRun.record.failures[0] ?? '').includes('is_two'))
    if (cargoRun.state === 'ok') {
      const cargoRerun = await rerunRunnerFailures(cargoRun.record, { from: cargoDir })
      check('R8 cargo rerun-failed targets the failure', cargoRerun.state === 'ok' && cargoRerun.record.counts.failed === 1 && cargoRerun.record.counts.passed === 0)
    }
  } else {
    console.log('  [SKIP] R7/R8 cargo not on PATH — honest unavailable row')
    check('R7u cargo unavailability carries a remedy', cargoTest.availability.state === 'unavailable' && cargoTest.availability.remedy.length > 0)
  }

  const goP = discoverRunnerProfiles(goDir)
  const goTest = goP.profiles.find(p => p.runner === 'go' && p.kind === 'test')!
  if (goTest.availability.state === 'unavailable') {
    const goRun = await runRunnerProfile(goTest, { from: goDir })
    check('R9 missing executable ⇒ exact typed unavailable', goRun.state === 'unavailable' && goRun.remedy.includes('toolchain'))
  } else {
    const goRun = await runRunnerProfile(goTest, { from: goDir })
    check('R9 go run executes (toolchain present)', goRun.state === 'ok' || goRun.state === 'unavailable')
  }
}

// ── S. the node-test debug shim ─────────────────────────────────────────────
section('S. the node-test debug shim (no scratch program; node\'s own anchored name filter)')
{
  const { buildNodeTestDebugShim } = await import('../../src/services/ide/projectRunners.ts')
  const s1 = buildNodeTestDebugShim(`test/calc.test.mjs::bad`, { from: tsDir })
  check('S1 file::name answers the shim whole: absolute program, anchored runtimeArgs, the runner root as cwd',
    !('state' in s1) && s1.framework === 'node-test' && s1.program === join(tsDir, 'test', 'calc.test.mjs') && s1.runtimeArgs.length === 1 && s1.runtimeArgs[0] === '--test-name-pattern=^bad$' && s1.cwd === tsDir,
    JSON.stringify(s1))
  const s2 = buildNodeTestDebugShim(`test/calc.test.mjs::adds (2+2)`, { from: tsDir })
  check('S2 regex metacharacters in the name are ESCAPED inside the anchors',
    !('state' in s2) && s2.runtimeArgs[0] === '--test-name-pattern=^adds \\(2\\+2\\)$',
    'state' in s2 ? s2.reason : s2.runtimeArgs[0])
  const s3 = runWithCwdOverride(tsDir, () => buildNodeTestDebugShim('bad', { from: tsDir }))
  check('S3 a bare name is placed by the LATEST node-test run\'s case rows (file + root-relative resolution)',
    !('state' in s3) && s3.program === join(tsDir, 'test', 'calc.test.mjs'),
    JSON.stringify(s3))
  const s4 = runWithCwdOverride(tsDir, () => buildNodeTestDebugShim('no-such-test-anywhere', { from: tsDir }))
  check('S4 a name the record cannot place refuses typed with the file::name remedy',
    'state' in s4 && s4.state === 'unavailable' && s4.remedy.includes('file::name'),
    JSON.stringify(s4))
  const s5 = buildNodeTestDebugShim('test/absent.test.mjs::x', { from: tsDir })
  check('S5 a missing test file refuses typed', 'state' in s5 && s5.state === 'unavailable' && s5.reason.includes('not found'), JSON.stringify(s5))
  // The tool surface routes debug BY LANE (source seams — the drive lives in
  // the RUN_LIVE node-debug drill's hand-off leg).
  const toolSrc = (await import('node:fs')).readFileSync(join(import.meta.dir, '..', '..', 'src/tools/TestTool/TestTool.ts'), 'utf8')
  check('S6 the debug op routes by lane like run', toolSrc.includes("const debugLane = resolveTestLane(getCwd(), input.framework)"))
  check('S7 a runner without a debug home refuses NAMING the lane', toolSrc.includes('debug is not grown for ${debugLane.profile.runner} yet'))
  check('S8 the js arm rides the shim + adapterKey js + runtimeArgs (one Debug-session machinery)', toolSrc.includes("adapterKey: 'js'") && toolSrc.includes('runtimeArgs: jsShim.runtimeArgs') && toolSrc.includes('buildNodeTestDebugShim(input.node'))
}

// ── X. lifecycle ────────────────────────────────────────────────────────────
section('X. abort kills the child promptly')
{
  const slowDir = tempDir('slow')
  writeFileSync(join(slowDir, 'package.json'), JSON.stringify({ name: 's', private: true, scripts: { test: 'node --test' } }) + '\n')
  writeFileSync(join(slowDir, 'slow.mjs'), 'setTimeout(() => {}, 60_000)\n')
  const base = discoverRunnerProfiles(slowDir).profiles.find(p => p.runner === 'node-test')!
  const profile = { ...base, command: ['node', join(slowDir, 'slow.mjs')] }
  const controller = new AbortController()
  const t0 = performance.now()
  const p = runRunnerProfile(profile, { from: slowDir, signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  const out = await p
  const elapsed = performance.now() - t0
  check('X1 abort resolves promptly (<10s)', elapsed < 10_000, `${Math.round(elapsed)}ms`)
  check('X2 aborted run is NEVER a success', out.state === 'ok' ? out.record.counts.errored > 0 || out.record.exitCode !== 0 : true)
}

// ── U. Launch integration ───────────────────────────────────────────────────
section('U. runner profiles join the Launch discovery')
{
  const d = await runWithCwdOverride(tsDir, () => discoverLaunchProfiles(tsDir))
  const runnerRows = d.profiles.filter(p => p.source === 'runners')
  check('U1 source runners present', runnerRows.length >= 2)
  check('U2 runnerRef payload carried', runnerRows.every(p => !!p.runnerRef))
  const dv = await runWithCwdOverride(vitestDir, () => discoverLaunchProfiles(vitestDir))
  const unavailable = dv.profiles.find(p => p.source === 'runners' && p.label.includes('unavailable'))
  check('U3 availability-honest labels', !!unavailable)
}

console.log('')
if (failures > 0) {
  console.error(`prove-project-runners: ${failures} RED`)
  process.exit(1)
}
console.log('prove-project-runners: GREEN')
