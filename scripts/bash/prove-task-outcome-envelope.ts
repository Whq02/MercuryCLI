#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-task-outcome-envelope.ts
//  PROOF: — the TaskOutcomeEnvelope owner (fixture §10.16):
//    - a terminal outcome minted once is durable and re-readable in a FRESH
//      process (the clear/resume/reconnect survival law) — raw output stays
//      out;
//    - exactly-once: a second mint for the same taskId is refused, the
//      first terminal outcome stands;
//    - the ring bound holds (oldest evicted past MAX);
//    - shellOutcomeState derives the truth-law vocabulary (policy stops are
//      never user interrupts; not-started is never success).
//  Hygiene: config home pinned to a scratch root BEFORE imports.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'envelope-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const mod = await import(join(ROOT, 'src/tasks/taskOutcomeEnvelope.ts'))
const { recordTaskOutcome, loadTaskOutcomes, findTaskOutcome, shellOutcomeState, taskOutcomesPath } = mod

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' TaskOutcomeEnvelope (seamark SM-B, fixture 10.16) — proof')
console.log('============================================================')

const SESSION = '00000000-0000-4000-8000-00000000e0e1'
try {
  // ── mint + same-process read ─────────────────────────────────────────────
  await recordTaskOutcome(SESSION, {
    taskId: 'task-env-1',
    taskType: 'local_bash',
    command: 'bun run build.ts',
    spawn: 'confirmed',
    state: 'succeeded',
    exitCode: 0,
    interrupted: false,
    startTime: 1_000,
    endTime: 4_500,
    output: { totalLines: 42, totalBytes: 2_048, artifactPath: '/durable/tool-results/task-env-1' },
  })
  const one = await findTaskOutcome(SESSION, 'task-env-1')
  check('minted outcome readable (exitCode + duration derived)', one?.exitCode === 0 && one?.durationMs === 3_500, JSON.stringify(one)?.slice(0, 120))
  check('artifact REFERENCE carried, never raw output', one?.output?.artifactPath === '/durable/tool-results/task-env-1' && !JSON.stringify(one).includes('stdout'))

  // ── exactly-once ─────────────────────────────────────────────────────────
  await recordTaskOutcome(SESSION, {
    taskId: 'task-env-1',
    taskType: 'local_bash',
    command: 'echo overwrite-attempt',
    spawn: 'confirmed',
    state: 'failed',
    exitCode: 1,
    interrupted: false,
    startTime: 1,
    endTime: 2,
  })
  const still = await findTaskOutcome(SESSION, 'task-env-1')
  check('second mint refused — the FIRST terminal outcome stands', still?.state === 'succeeded' && still?.exitCode === 0)

  // ── fresh-process reload (the clear/resume survival law) ─────────────────
  const path = taskOutcomesPath(SESSION)
  const sub = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      `const f = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8')); const e = f.envelopes.find(x => x.taskId === 'task-env-1'); console.log(JSON.stringify({ v: f.v, state: e?.state, code: e?.exitCode }))`,
    ],
  })
  const fresh = JSON.parse(sub.stdout.toString().trim() || '{}') as { v?: number; state?: string; code?: number }
  check('outcome survives in a FRESH process (durable file, versioned)', fresh.v === 1 && fresh.state === 'succeeded' && fresh.code === 0, JSON.stringify(fresh))

  // ── ring bound ───────────────────────────────────────────────────────────
  for (let i = 0; i < 105; i++) {
    await recordTaskOutcome(SESSION, {
      taskId: `bulk-${i}`,
      taskType: 'local_bash',
      command: `true # ${i}`,
      spawn: 'confirmed',
      state: 'succeeded',
      exitCode: 0,
      interrupted: false,
      startTime: i,
      endTime: i + 1,
    })
  }
  const all = await loadTaskOutcomes(SESSION)
  check('ring bound holds (≤100, oldest evicted)', all.length === 100 && !all.some(e => e.taskId === 'task-env-1'), `len=${all.length}`)

  // ── shellOutcomeState vocabulary (pure) ──────────────────────────────────
  check('deadline kill = policy stop, not user interrupt', shellOutcomeState({ code: 137, interrupted: false, wasKilled: false, stderr: 'Background command killed: absolute deadline elapsed (10× …)' }).state === 'killed-policy')
  check('size-watchdog kill = policy stop', shellOutcomeState({ code: 137, interrupted: false, wasKilled: false, stderr: 'Background command killed: output file exceeded 5GB' }).terminationReason === 'size-watchdog')
  check('timeout keeps its own vocabulary', shellOutcomeState({ code: 143, interrupted: false, wasKilled: false, stderr: 'Command timed out after 2m' }).state === 'timed-out')
  check('user kill = stopped', shellOutcomeState({ code: 137, interrupted: true, wasKilled: true }).state === 'stopped')
  check('clean exit = succeeded; non-zero = failed', shellOutcomeState({ code: 0, interrupted: false, wasKilled: false }).state === 'succeeded' && shellOutcomeState({ code: 7, interrupted: false, wasKilled: false }).state === 'failed')
} finally {
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL ENVELOPE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
