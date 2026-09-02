#!/usr/bin/env bun
// ============================================================================
//  scripts/exit-handle/prove-exit-cliff-drain.ts — the exit-cliff named
// drain's laws (TASK-017 D3).
//
//    §1 the drain owner (src/utils/exitCliffDrain.ts): one bounded grace ·
//       a settled seam costs zero · a rejecting or throwing seam never
//       throws at the cliff · an in-flight seam LANDS inside the grace · a
//       wedged seam is abandoned BY NAME at the grace, never held · phases
//       run in data-dependency order (1 → 2 → 3), a later phase never
//       starts before the earlier settled, a spent grace abandons the rest
//       by name · the registry is identity-keyed with a harmless
//       double-unregister · the registered poison seam
//       MERCURY_EXIT_CLIFF_DRAIN=0 skips the drain
//    §2 the product's seam registers itself at load with its phase — the
//       transcript writer (1) — and a Project exists only once asked for
//       (the seam settles its flush; a peek never instantiates)
//    §3 POISONS (source shape): gracefulShutdown drains the named seams
//       AFTER the session-end hooks and BEFORE the stdout drain + forceExit;
//       the drain owner is a fire-time import; the poison seam is a
//       registered default-on flag whose evidence is the census prover
//
//  Hermetic: a scratch config home is pinned BEFORE any src import and
//  removed at the end.
//  Run: ~/.bun/bin/bun run scripts/exit-handle/prove-exit-cliff-drain.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'exit-cliff-drain-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_EXIT_CLIFF_DRAIN

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const later = (ms: number, fn?: () => void): Promise<void> =>
  new Promise(res =>
    setTimeout(() => {
      fn?.()
      res()
    }, ms),
  )
const never = (): Promise<never> => new Promise(() => {})

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — exit-cliff drain proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const drain = await import('../../src/utils/exitCliffDrain.ts')
const { drainNamedSeams, drainExitCliffSeams, registerExitCliffSeam, listExitCliffSeams, EXIT_CLIFF_DRAIN_MS } = drain
type Seam = import('../../src/utils/exitCliffDrain.ts').ExitCliffSeam

// ── §1 the drain owner ──────────────────────────────────────────────────────
section('§1 — the drain owner: bounded, never-throw, phased, by name')
check(
  'the grace is bounded and small (a wedged seam cannot hold the exit)',
  EXIT_CLIFF_DRAIN_MS > 0 && EXIT_CLIFF_DRAIN_MS <= 3_000,
  String(EXIT_CLIFF_DRAIN_MS),
)
{
  const t0 = Date.now()
  const r = await drainNamedSeams([{ name: 'settled', phase: 1, settle: () => Promise.resolve() }])
  check(
    'a settled seam costs the exit nothing',
    r.settled.join() === 'settled' && r.abandoned.length === 0 && r.failed.length === 0 && Date.now() - t0 < 50,
    j(r),
  )
}
{
  const r = await drainNamedSeams([
    { name: 'rejects', phase: 1, settle: () => Promise.reject(new Error('boom')) },
    {
      name: 'throws',
      phase: 1,
      settle: () => {
        throw new Error('sync boom')
      },
    },
  ])
  check(
    'a rejecting or throwing seam never throws at the cliff — recorded as failed, nothing abandoned',
    r.failed.sort().join() === 'rejects,throws' && r.abandoned.length === 0 && r.settled.length === 0,
    j(r),
  )
}
{
  let landed = false
  const r = await drainNamedSeams(
    [
      {
        name: 'late',
        phase: 1,
        settle: () =>
          later(60, () => {
            landed = true
          }),
      },
    ],
    500,
  )
  check('an in-flight seam LANDS inside the grace (the cliff is drained, not raced)', landed && r.settled.join() === 'late', j(r))
}
{
  const t0 = Date.now()
  const r = await drainNamedSeams([{ name: 'wedged', phase: 1, settle: never }], 80)
  const ms = Date.now() - t0
  check(
    'a wedged seam is abandoned BY NAME at the grace, never held forever',
    r.abandoned.join() === 'wedged' && ms >= 80 && ms < 500,
    `${j(r)} in ${ms}ms`,
  )
}
{
  const order: string[] = []
  const r = await drainNamedSeams(
    [
      {
        name: 'closer',
        phase: 3,
        settle: async () => {
          order.push('closer')
        },
      },
      { name: 'derived', phase: 2, settle: () => later(20, () => order.push('derived')) },
      { name: 'source', phase: 1, settle: () => later(30, () => order.push('source')) },
    ],
    500,
  )
  check(
    'phases run in data-dependency order — source, then derived, then closer — each after the previous settled',
    order.join('>') === 'source>derived>closer' && r.settled.length === 3,
    order.join('>'),
  )
}
{
  const ran: string[] = []
  const r = await drainNamedSeams(
    [
      { name: 'source-wedged', phase: 1, settle: never },
      {
        name: 'closer',
        phase: 3,
        settle: async () => {
          ran.push('closer')
        },
      },
    ],
    60,
  )
  check(
    'a spent grace abandons the LATER phases by name — the closer never runs under an unsettled producer',
    r.abandoned.sort().join() === 'closer,source-wedged' && ran.length === 0,
    j(r),
  )
}
{
  const seam: Seam = { name: 'twice', phase: 1, settle: () => Promise.resolve() }
  const before = listExitCliffSeams().length
  const un1 = registerExitCliffSeam(seam)
  registerExitCliffSeam(seam)
  check('the registry is identity-keyed (one reference registered twice is one seam)', listExitCliffSeams().length === before + 1)
  un1()
  const afterOne = listExitCliffSeams().length
  un1()
  check('unregister removes it; a second unregister is harmless', afterOne === before && listExitCliffSeams().length === before)
}
{
  let called = 0
  const un = registerExitCliffSeam({
    name: 'poisoned',
    phase: 1,
    settle: async () => {
      called++
    },
  })
  process.env.MERCURY_EXIT_CLIFF_DRAIN = '0'
  const skipped = await drainExitCliffSeams(200)
  const calledAfterSkip = called
  delete process.env.MERCURY_EXIT_CLIFF_DRAIN
  const drained = await drainExitCliffSeams(200)
  un()
  check(
    "the registered poison seam MERCURY_EXIT_CLIFF_DRAIN=0 skips the drain (the census prover's pre-fix arm); unset drains",
    skipped.skipped && calledAfterSkip === 0 && !drained.skipped && called === 1 && drained.settled.includes('poisoned'),
    j({ skipped, drained, calledAfterSkip, called }),
  )
}

// ── §2 the product seams ────────────────────────────────────────────────────
section('§2 — the product seam registers with its phase; a Project exists only once asked for')
{
  const writer = await import('../../src/utils/sessionStorage/writer.ts')
  check('the writer never instantiates at a peek', writer.peekProject() === null)
  writer.getProject()
  check('a Project exists once asked for (getProject) — the seam settles its flush', writer.peekProject() !== null)
  const names = Object.fromEntries(listExitCliffSeams().map(s => [s.name, s.phase]))
  check(
    'the transcript writer is registered at phase 1 (the source of truth) — the one product seam',
    names['transcript-writer'] === 1 && Object.keys(names).length === 1,
    j(names),
  )
  const t0 = Date.now()
  const report = await drainNamedSeams(listExitCliffSeams())
  check(
    'the writer seam settles at the cliff with nothing queued (an idle flush costs nothing)',
    report.settled.includes('transcript-writer') && report.failed.length === 0 && report.abandoned.length === 0 && Date.now() - t0 < 1_000,
    j(report),
  )
}

// ── §3 poisons ──────────────────────────────────────────────────────────────
section('§3 — POISONS (source shape)')
{
  const shutdown = readFileSync(join(ROOT, 'src/utils/gracefulShutdown.ts'), 'utf8')
  check(
    'POISON (the unseen seams): gracefulShutdown drains the named seams AFTER the session-end hooks and BEFORE the stdout drain + forceExit',
    /executeSessionEndHooks\([\s\S]*?drainExitCliffSeams\(\)[\s\S]*?await drainPipedStdoutForExit\(\)[\s\S]*?forceExit\(exitCode\)/.test(shutdown),
  )
  check(
    'POISON (the stage-1 closure): the drain owner is a fire-time import, never a static one',
    /await import\('\.\/exitCliffDrain\.js'\)/.test(shutdown) && !/^import .*exitCliffDrain/m.test(shutdown),
  )
  const writerSrc = readFileSync(join(ROOT, 'src/utils/sessionStorage/writer.ts'), 'utf8')
  check(
    'POISON (the unregistered writer): getProject registers the transcript-writer seam at phase 1 with its flush as the settle',
    /registerExitCliffSeam\(\{\s*name: 'transcript-writer',\s*phase: 1,\s*settle: \(\) => project\?\.flush\(\)/.test(writerSrc),
  )
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  check(
    'the poison seam is a registered default-on flag whose evidence is the census prover',
    /env: 'MERCURY_EXIT_CLIFF_DRAIN', kind: 'default-on'[^\n]*evidence: 'scripts\/exit-handle\/prove-exit-cliff-census\.ts'/.test(registry) &&
      existsSync(join(ROOT, 'scripts/exit-handle/prove-exit-cliff-census.ts')),
  )
}

try {
  rmSync(HOME, { recursive: true, force: true })
} catch {
  // scratch only
}
console.log(`\n${failures === 0 ? '✅' : '❌'} exit-cliff drain — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
