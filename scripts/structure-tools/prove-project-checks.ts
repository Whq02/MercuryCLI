#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-project-checks.ts — Family 3: the project-check
//  residuals over the shipped runner registry:
//
//    P. failure normalization — parseRunnerCases turns each runner's output
//       into typed {file · line · test name · summary} rows (pure captured-
//       output fixtures: node-test TAP · cargo modern+legacy · go · vitest ·
//       jest); what does not parse yields no row, never an invention;
//    C. changed-file selection — runner-native focused argv (vitest related ·
//       jest --findRelatedTests · changed test files · go packages), honest
//       declines (cargo · clean tree · no relevant changes);
//    E. end-to-end (node --test, real child) — streamed bounded progress
//       fires while live, the failing case carries file:line, the full
//       output spills to an artifact ref, the resolved argv is on the
//       record, LSP diagnostics compose as a note.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lathe-f3-home-'))
process.env.MERCURY_SIMPLE = '1'

const { parseRunnerCases, changedRunnerSelection, discoverRunnerProfiles, runRunnerProfile } = await import(
  '../../src/services/ide/projectRunners.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(name: string): void {
  console.log(`\n${name}`)
}

// ── P. failure normalization (pure captured-output fixtures) ────────────────
section('P. typed failure rows per runner')
{
  const tap = [
    'TAP version 13',
    'not ok 1 - adds numbers',
    '  ---',
    '  duration_ms: 1.23',
    "  location: '/proj/math.test.mjs:12:1'",
    "  failureType: 'testCodeFailure'",
    "  error: 'Expected 3 to equal 4'",
    '  ...',
    'ok 2 - subtracts',
    '# tests 2',
    '# pass 1',
    '# fail 1',
  ].join('\n')
  const rows = parseRunnerCases('node-test', tap, '/proj')
  check(
    'node-test TAP: name + file + line + message',
    rows.length === 1 &&
      rows[0]!.id === 'adds numbers' &&
      rows[0]!.file === 'math.test.mjs' &&
      rows[0]!.line === 12 &&
      rows[0]!.message === 'Expected 3 to equal 4',
    JSON.stringify(rows),
  )

  const cargoModern = [
    'running 2 tests',
    'test tests::works ... ok',
    'test tests::breaks ... FAILED',
    '',
    'failures:',
    '',
    '---- tests::breaks stdout ----',
    'thread \'tests::breaks\' panicked at src/lib.rs:9:5:',
    'assertion failed: 1 == 2',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored;',
  ].join('\n')
  const cargoRows = parseRunnerCases('cargo', cargoModern, '/proj')
  check(
    'cargo (modern panic): name + file + line + message',
    cargoRows.length === 1 &&
      cargoRows[0]!.id === 'tests::breaks' &&
      cargoRows[0]!.file === 'src/lib.rs' &&
      cargoRows[0]!.line === 9 &&
      cargoRows[0]!.message === 'assertion failed: 1 == 2',
    JSON.stringify(cargoRows),
  )

  const cargoLegacy = ['---- t::old stdout ----', "thread 't::old' panicked at 'boom', src/old.rs:4:9"].join('\n')
  const legacyRows = parseRunnerCases('cargo', cargoLegacy, '/proj')
  check(
    'cargo (legacy panic): message + file + line',
    legacyRows.length === 1 && legacyRows[0]!.message === 'boom' && legacyRows[0]!.file === 'src/old.rs' && legacyRows[0]!.line === 4,
    JSON.stringify(legacyRows),
  )

  const goOut = ['--- FAIL: TestThing', '    thing_test.go:23: got 1, want 2', 'FAIL', 'FAIL\texample.com/pkg\t0.01s'].join('\n')
  const goRows = parseRunnerCases('go', goOut, '/proj')
  check(
    'go: name + file + line + message',
    goRows.length === 1 && goRows[0]!.id === 'TestThing' && goRows[0]!.file === 'thing_test.go' && goRows[0]!.line === 23 && goRows[0]!.message === 'got 1, want 2',
    JSON.stringify(goRows),
  )

  const vitestOut = ['  × src/sum.test.ts > sum > adds', '   ❯ src/sum.test.ts:8:15'].join('\n')
  const vitestRows = parseRunnerCases('vitest', vitestOut, '/proj')
  check('vitest: file + test name', vitestRows.length === 1 && vitestRows[0]!.file === 'src/sum.test.ts' && vitestRows[0]!.id === 'sum > adds', JSON.stringify(vitestRows))

  const jestOut = ['  ● suite › does math', '', '    expect(received).toBe(expected)', '', '      at Object.<anonymous> (src/math.test.js:5:17)'].join('\n')
  const jestRows = parseRunnerCases('jest', jestOut, '/proj')
  check('jest: name + file + line', jestRows.length === 1 && jestRows[0]!.id === 'suite > does math' && jestRows[0]!.file === 'src/math.test.js' && jestRows[0]!.line === 5, JSON.stringify(jestRows))

  check('garbage parses to zero rows (never invented)', parseRunnerCases('node-test', 'random\nnoise', '/p').length === 0)

  // Closing-wave regression: jest Console echoes / warnings are NOT failures.
  const jestGreenNoise = [
    '  ● Console',
    '',
    '    console.log',
    '      hello from a passing test',
    '',
    '      at Object.log (src/sum.test.js:3:13)',
    '',
    '  ● Validation Warning:',
    '',
    '    Unknown option "foo".',
  ].join('\n')
  check('jest Console/Warning blocks yield ZERO failure rows', parseRunnerCases('jest', jestGreenNoise, '/p').length === 0, JSON.stringify(parseRunnerCases('jest', jestGreenNoise, '/p')))
}

// ── C. changed-file selection ───────────────────────────────────────────────
section('C. changed-file-focused selection')
function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-f3-repo-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    execFileSync('mkdir', ['-p', join(full, '..')])
    writeFileSync(full, content)
  }
  const g = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  return dir
}
{
  // node-test: a changed test file focuses; a changed source-only tree declines
  const dir = gitRepo({
    'package.json': JSON.stringify({ name: 'f', private: true, scripts: { test: 'node --test' } }),
    'a.test.mjs': "import { test } from 'node:test'\ntest('t', () => {})\n",
    'src.mjs': 'export const x = 1\n',
  })
  writeFileSync(join(dir, 'a.test.mjs'), "import { test } from 'node:test'\ntest('t2', () => {})\n")
  const { profiles } = discoverRunnerProfiles(dir)
  const nodeProfile = profiles.find(p => p.runner === 'node-test' && p.kind === 'test')!
  const sel = changedRunnerSelection(nodeProfile)
  check('node-test: changed test file focuses', sel.state === 'ok' && sel.argv.includes('a.test.mjs'), JSON.stringify(sel))

  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-aqm', 'x'], { cwd: dir })
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 2\n')
  const noTests = changedRunnerSelection(nodeProfile)
  check('node-test: source-only change declines honestly', noTests.state === 'unavailable' && noTests.reason.includes('cannot map'), JSON.stringify(noTests))

  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-aqm', 'y'], { cwd: dir })
  const clean = changedRunnerSelection(nodeProfile)
  check('clean tree declines honestly', clean.state === 'unavailable' && clean.reason.includes('clean'))

  // Closing-wave regression: a DELETED test file never rides the argv.
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rm', '-q', 'a.test.mjs'], { cwd: dir })
  const deleted = changedRunnerSelection(nodeProfile)
  check(
    'deleted-only change declines (no phantom red run)',
    deleted.state === 'unavailable',
    JSON.stringify(deleted),
  )
}
{
  // vitest/jest: runner-native related-test argv
  const dir = gitRepo({
    'package.json': JSON.stringify({ name: 'f', private: true, devDependencies: { vitest: '^1' } }),
    'src/sum.ts': 'export const sum = (a: number, b: number) => a + b\n',
  })
  writeFileSync(join(dir, 'src/sum.ts'), 'export const sum = (a: number, b: number) => a + b + 0\n')
  const { profiles } = discoverRunnerProfiles(dir)
  const vitest = profiles.find(p => p.runner === 'vitest')!
  const sel = changedRunnerSelection(vitest)
  check(
    "vitest: 'related --run' over the changed sources",
    sel.state === 'ok' && sel.argv[1] === 'related' && sel.argv.includes('src/sum.ts') && sel.argv.at(-1) === '--run',
    JSON.stringify(sel),
  )
}
{
  const dir = gitRepo({
    'Cargo.toml': '[package]\nname = "f"\nversion = "0.1.0"\n',
    'src/lib.rs': 'pub fn f() {}\n',
  })
  writeFileSync(join(dir, 'src/lib.rs'), 'pub fn f() { let _ = 1; }\n')
  const { profiles } = discoverRunnerProfiles(dir)
  const cargo = profiles.find(p => p.runner === 'cargo' && p.kind === 'test')!
  const sel = changedRunnerSelection(cargo)
  check('cargo declines by-file selection honestly', sel.state === 'unavailable' && sel.reason.includes('NAME filter'), JSON.stringify(sel))
}
{
  const dir = gitRepo({
    'go.mod': 'module example.com/f\n\ngo 1.21\n',
    'pkg/a/a.go': 'package a\n',
  })
  writeFileSync(join(dir, 'pkg/a/a.go'), 'package a\n// changed\n')
  const { profiles } = discoverRunnerProfiles(dir)
  const goProfile = profiles.find(p => p.runner === 'go' && p.kind === 'test')!
  const sel = changedRunnerSelection(goProfile)
  check('go: changed packages focus', sel.state === 'ok' && sel.argv.includes('./pkg/a'), JSON.stringify(sel))
}

// ── E. end-to-end node --test: progress · cases · artifact · argv ──────────
section('E. live node --test run (streamed progress + typed failure)')
{
  const dir = gitRepo({
    'package.json': JSON.stringify({ name: 'f', private: true, scripts: { test: 'node --test' } }),
    'fail.test.mjs': [
      "import { test } from 'node:test'",
      "import assert from 'node:assert'",
      "test('this one fails', () => {",
      '  for (let i = 0; i < 60; i++) console.log("filler line " + i)',
      '  assert.strictEqual(1, 2)',
      '})',
      "test('this one passes', () => {})",
    ].join('\n'),
  })
  const { profiles } = discoverRunnerProfiles(dir)
  const profile = profiles.find(p => p.runner === 'node-test' && p.kind === 'test')!
  let progressCalls = 0
  const out = await runRunnerProfile(profile, {
    from: dir,
    onOutput: () => {
      progressCalls++
    },
  })
  if (out.state !== 'ok') {
    check('run lands', false, JSON.stringify(out))
  } else {
    const r = out.record
    check('output streamed while live', progressCalls >= 1, String(progressCalls))
    check('counts parsed (1 pass · 1 fail)', r.counts.passed === 1 && r.counts.failed === 1, JSON.stringify(r.counts))
    const failCase = r.cases.find(c => c.id === 'this one fails')
    check(
      'the failing case carries file:line + message',
      failCase !== undefined && failCase.file === 'fail.test.mjs' && typeof failCase.line === 'number' && (failCase.message ?? '').length > 0,
      JSON.stringify(r.cases),
    )
    check('full output behind an artifact ref', typeof r.outputArtifactRef === 'string', r.outputArtifactRef)
    check('the resolved argv is ON the record', r.command[0] === 'node' && r.command.includes('--test'))
    check('LSP diagnostics compose as a note', typeof r.diagnosticsNote === 'string', r.diagnosticsNote)
    check('failed run never green', r.exitCode !== 0 && r.counts.failed > 0)
  }
}

// ── W. closing-wave regressions: green runs stay clean · rerun by NAME ─────
section('W. green-run honesty + vitest rerun-by-name')
{
  const dir = gitRepo({
    'package.json': JSON.stringify({ name: 'f', private: true, scripts: { test: 'node --test' } }),
    'pass.test.mjs': "import { test } from 'node:test'\ntest('passes', () => { console.log('● Console-looking noise') })\n",
  })
  const { profiles } = discoverRunnerProfiles(dir)
  const profile = profiles.find(p => p.runner === 'node-test' && p.kind === 'test')!
  const out = await runRunnerProfile(profile, { from: dir })
  check(
    'a GREEN run persists zero failures and zero case rows',
    out.state === 'ok' && out.record.exitCode === 0 && out.record.failures.length === 0 && out.record.cases.length === 0,
    out.state === 'ok' ? JSON.stringify({ failures: out.record.failures, cases: out.record.cases }) : JSON.stringify(out),
  )
}
{
  const dir = gitRepo({
    'package.json': JSON.stringify({ name: 'f', private: true, devDependencies: { vitest: '^1' } }),
  })
  execFileSync('mkdir', ['-p', join(dir, 'node_modules', '.bin')])
  const shim = join(dir, 'node_modules', '.bin', 'vitest')
  writeFileSync(shim, '#!/bin/bash\necho "shim-args: $*"\nexit 0\n')
  execFileSync('chmod', ['+x', shim])
  const { rerunRunnerFailures } = await import('../../src/services/ide/projectRunners.ts')
  const fakeRecord = {
    schema: 1 as const,
    id: 'run-x',
    framework: 'vitest' as const,
    selection: 'all',
    command: [shim, 'run'],
    cwd: dir,
    interpreter: shim,
    startedAt: 0,
    durationMs: 1,
    counts: { passed: 0, failed: 1, skipped: 0, errored: 0 },
    cases: [],
    failures: ['suite > adds numbers'],
    outputTail: [],
    exitCode: 1,
  }
  const rerun = await rerunRunnerFailures(fakeRecord, { from: dir })
  check(
    'vitest rerun-failed selects by NAME (-t), never a file path',
    rerun.state === 'ok' && rerun.record.command.includes('-t') && rerun.record.command.some(a => a.includes('adds numbers')),
    rerun.state === 'ok' ? rerun.record.command.join(' ') : JSON.stringify(rerun),
  )
}

// ── R. failing → passing cargo fixture (honest skip when cargo is absent) ──
section('R. cargo failing → passing (real toolchain when present)')
{
  const hasCargo = (process.env.PATH ?? '').split(':').some(d => d.length > 0 && existsSync(join(d, 'cargo')))
  if (!hasCargo) {
    console.log('  [SKIP] cargo not on PATH — the failing→passing law is proved by the node --test leg above (recorded, not silent)')
  } else {
    const dir = gitRepo({
      'Cargo.toml': '[package]\nname = "lathe_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': [
        'pub fn add(a: i32, b: i32) -> i32 { a + b }',
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn adds() { assert_eq!(super::add(1, 2), 4); }',
        '}',
      ].join('\n'),
    })
    const { profiles } = discoverRunnerProfiles(dir)
    const cargo = profiles.find(p => p.runner === 'cargo' && p.kind === 'test')!
    const failing = await runRunnerProfile(cargo, { from: dir })
    if (failing.state !== 'ok') {
      check('cargo failing run lands', false, JSON.stringify(failing))
    } else {
      check('cargo failure never green', failing.record.exitCode !== 0 && failing.record.counts.failed === 1, JSON.stringify(failing.record.counts))
      const failCase = failing.record.cases.find(c => c.id.includes('adds'))
      check('cargo failing case carries file:line', failCase?.file === 'src/lib.rs' && typeof failCase?.line === 'number', JSON.stringify(failing.record.cases))
      writeFileSync(join(dir, 'src/lib.rs'), readFileSync(join(dir, 'src/lib.rs'), 'utf8').replace('assert_eq!(super::add(1, 2), 4)', 'assert_eq!(super::add(1, 2), 3)'))
      const passing = await runRunnerProfile(cargo, { from: dir })
      check(
        'cargo passing run goes green',
        passing.state === 'ok' && passing.record.exitCode === 0 && passing.record.counts.failed === 0 && passing.record.counts.passed === 1,
        JSON.stringify(passing.state === 'ok' ? passing.record.counts : passing),
      )
    }
  }
}

console.log(failures === 0 ? '\nPROJECT CHECK LAWS GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
