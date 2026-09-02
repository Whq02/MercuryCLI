#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-runner-settles.ts — a Launch test/build run
//  ALWAYS settles, and its timeout ends the whole tree (FN-015 rank 2, S1).
//
//  The runner resolved its promise from the child's `close` event and killed
//  only the leader on timeout. A profile whose command spawns children —
//  `cargo test`, `go test ./...`, `npm run build` — leaves descendants
//  holding the inherited pipes, so `close` never fires: the turn stopped
//  progressing with no error, no timeout message and no exit code, and
//  LaunchTool awaited it with no deadline and no signal, so the promise
//  stayed pending for the rest of the session.
//
//  Driven against the REAL runRunnerProfile over a real child that forks a
//  real grandchild (fixtures/leaky-runner.mjs). Time and process census are
//  the contract here.
//
//   §1 a leader that EXITS while a grandchild holds the pipes settles on
//      `exit` inside a bounded drain — never waits for `close`
//   §2 a leader that never exits settles at its deadline, with an honest
//      typed verdict, and the TREE is ended (the grandchild is gone)
//   §3 the operator's abort settles the run promptly and ends the tree
//   §4 a healthy run is untouched (exit code, counts, output)
//   §5 the lane keeps no root-only kill: every teardown routes through the
//      one cross-platform tree owner, and LaunchTool hands its signal down
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-runner-settles.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-runner-settles-home-'))
process.env.MERCURY_SIMPLE = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const FIXTURE = join(ROOT, 'scripts', 'edit-tools', 'fixtures', 'leaky-runner.mjs')
const { runRunnerProfile } = await import('../../src/services/ide/projectRunners.ts')

const scratch = mkdtempSync(join(tmpdir(), 'prove-runner-settles-'))
writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'settles', private: true, type: 'module' }) + '\n')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}
const readPid = (file: string): number | null => {
  for (let i = 0; i < 60; i++) {
    if (existsSync(file)) {
      const raw = Number(readFileSync(file, 'utf8').trim())
      if (Number.isInteger(raw) && raw > 0) return raw
    }
  }
  return existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : null
}
const settled = async (pid: number, withinMs: number): Promise<boolean> => {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return !alive(pid)
}

function profile(mode: string, pidFile: string): Parameters<typeof runRunnerProfile>[0] {
  return {
    id: `rp-settles-${mode}`,
    runner: 'node-test' as const,
    kind: 'test' as const,
    title: `leaky ${mode}`,
    source: 'package.json',
    root: scratch,
    command: [process.execPath, FIXTURE],
    selection: 'none' as const,
    availability: { state: 'ok' as const },
  } as Parameters<typeof runRunnerProfile>[0]
}

/** Every run is raced against a watchdog: a HANG is the defect under test,
 *  so it must be a verdict here, never a stuck prover. */
async function bounded<T>(label: string, work: Promise<T>, ms: number): Promise<T | 'HUNG'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const verdict = await Promise.race([
    work,
    new Promise<'HUNG'>(resolve => {
      timer = setTimeout(() => resolve('HUNG'), ms)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (verdict === 'HUNG') console.log(`  (watchdog: ${label} did not settle within ${ms}ms)`)
  return verdict
}

console.log('============================================================')
console.log(' the runner always settles, and its timeout ends the tree')
console.log('============================================================')

// ── §1 the leader exits, a grandchild holds the pipes ───────────────────────
section('§1 a grandchild holding the pipes cannot hold the turn')
{
  const pidFile = join(scratch, 'linger.pid')
  const t0 = Date.now()
  const out = await bounded(
    'the linger run',
    runRunnerProfile(profile('linger', pidFile), { from: scratch, timeoutMs: 4000, env: { LEAKY_MODE: 'linger', LEAKY_PID_FILE: pidFile } } as never),
    12_000,
  )
  const elapsed = Date.now() - t0
  check('the run SETTLES (the base hung here — `close` never fires under a live grandchild)', out !== 'HUNG')
  if (out !== 'HUNG') {
    check(`it settles on the leader's exit, well inside the 4s budget (${elapsed}ms)`, elapsed < 3500, `${elapsed}ms`)
    check('the settlement carries the leader\'s own exit code', out.state === 'ok' && out.record.exitCode === 0, JSON.stringify(out.state === 'ok' ? out.record.exitCode : out))
    check('the output the leader wrote before exiting survives the drain', out.state === 'ok' && out.record.outputTail.join('\n').includes('leaky-runner: starting'), out.state === 'ok' ? out.record.outputTail.join(' | ') : '')
  }
  const pid = readPid(pidFile)
  if (pid) {
    // A clean exit is not a kill: the grandchild is the operator's to keep.
    check('a run that ENDED cleanly leaves its descendants alone (no gratuitous sweep)', alive(pid), 'the grandchild was killed by a clean exit')
    process.kill(pid, 'SIGKILL')
  }
}

// ── §2 the deadline ends the tree ───────────────────────────────────────────
section('§2 a run that never exits settles at its deadline, tree and all')
{
  const pidFile = join(scratch, 'hang.pid')
  const t0 = Date.now()
  const out = await bounded(
    'the hang run',
    runRunnerProfile(profile('hang', pidFile), { from: scratch, timeoutMs: 2000, env: { LEAKY_MODE: 'hang', LEAKY_PID_FILE: pidFile } } as never),
    20_000,
  )
  const elapsed = Date.now() - t0
  check('the run SETTLES at its deadline (the base hung forever)', out !== 'HUNG')
  if (out !== 'HUNG') {
    check(`it settles near the 2s budget, not before (${elapsed}ms)`, elapsed >= 1800 && elapsed < 12_000, `${elapsed}ms`)
    const record = out.state === 'ok' ? out.record : null
    check('the verdict is NOT a success', record !== null && (record.exitCode !== 0 || Boolean(record.verdictNote)), JSON.stringify(record?.exitCode))
    check('the verdict NAMES the timeout (never a silent stop)', /timed out|timeout/i.test(record?.verdictNote ?? ''), record?.verdictNote ?? '(no note)')
    check('…and names that the tree was ended', /tree/i.test(record?.verdictNote ?? ''), record?.verdictNote ?? '')
  }
  const pid = readPid(pidFile)
  check('the grandchild was found for the census', pid !== null)
  if (pid) {
    check('the TIMEOUT ended the whole tree — the grandchild is gone (a root-only kill left it running forever)', await settled(pid, 6000), `grandchild ${pid} survived`)
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}

// ── §3 the operator's abort ─────────────────────────────────────────────────
section('§3 the abort settles the run and ends the tree')
{
  const pidFile = join(scratch, 'abort.pid')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 600)
  const t0 = Date.now()
  const out = await bounded(
    'the aborted run',
    runRunnerProfile(profile('hang', pidFile), {
      from: scratch,
      timeoutMs: 60_000,
      signal: controller.signal,
      env: { LEAKY_MODE: 'hang', LEAKY_PID_FILE: pidFile },
    } as never),
    20_000,
  )
  const elapsed = Date.now() - t0
  check('the aborted run SETTLES promptly (the 60s budget never ran)', out !== 'HUNG' && elapsed < 12_000, `${elapsed}ms`)
  check('an aborted run is NEVER reported a success', out === 'HUNG' || out.state !== 'ok' || out.record.exitCode !== 0 || Boolean(out.record.verdictNote))
  const pid = readPid(pidFile)
  if (pid) {
    check('the abort ended the tree — the grandchild is gone', await settled(pid, 6000), `grandchild ${pid} survived`)
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}

// ── §4 the healthy path ─────────────────────────────────────────────────────
section('§4 a healthy run is untouched')
{
  const script = join(scratch, 'ok.mjs')
  writeFileSync(script, "process.stdout.write('hello from the runner\\n')\n")
  const healthy = {
    id: 'rp-settles-ok',
    runner: 'node-test' as const,
    kind: 'test' as const,
    title: 'healthy',
    source: 'package.json',
    root: scratch,
    command: [process.execPath, script],
    selection: 'none' as const,
    availability: { state: 'ok' as const },
  } as Parameters<typeof runRunnerProfile>[0]
  const out = await bounded('the healthy run', runRunnerProfile(healthy, { from: scratch } as never), 20_000)
  check('it settles', out !== 'HUNG')
  if (out !== 'HUNG' && out.state === 'ok') {
    check('exit 0 is recorded', out.record.exitCode === 0)
    check('its output is captured', out.record.outputTail.join('\n').includes('hello from the runner'))
    check('no timeout note is invented for a clean run', !/timed out/i.test(out.record.verdictNote ?? ''), out.record.verdictNote ?? '')
  }
}

// ── §5 the class: no root-only kill left in the lane ────────────────────────
section('§5 every teardown in the lane routes through the ONE tree owner')
{
  const files = [
    'src/services/ide/projectRunners.ts',
    'src/services/ide/pythonTests.ts',
    'src/services/ide/cppBuild.ts',
    'src/utils/healthReport.ts',
  ]
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    check(`${rel}: no root-only child.kill remains`, !/child\.kill\(/.test(src), (src.match(/.*child\.kill\(.*/g) ?? []).join(' | '))
    check(`${rel}: settles through the shared owner`, /settleChildRun\(/.test(src))
  }
  const launch = readFileSync(join(ROOT, 'src/tools/LaunchTool/LaunchTool.ts'), 'utf8')
  check('LaunchTool hands its abort signal to every runner call', (launch.match(/runRunnerProfile\([^)]*signal: context\.abortController\.signal/gs) ?? []).length >= 2, 'a run that ignores Esc is a run nobody can stop')
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-runner-settles${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
