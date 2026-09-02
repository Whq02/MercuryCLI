#!/usr/bin/env bun
// ============================================================================
//  prove-mo4-kill-cleanup-boundaries — unexpected process
//  stops, cleanup discipline, read-only destinations, concurrent writers.
//
//    §1 kill at the rename boundary (real child): destination stays
//       old-complete; exactly one OWNED orphan temp; the age-gated sweeper
//       leaves a YOUNG temp alone (cleanup delays never race a live writer),
//       collects it when aged, and NEVER touches the committed file;
//    §2 kill after the rename (flush-dir): destination is new-complete —
//       whole-old-or-whole-new, never between;
//    §3 kill BETWEEN retry attempts (win32: eperm#1 then kill — the prepared
//       replacement was still valid between attempts; POSIX: the same spec is
//       a typed first-attempt failure, and the child EXITS rather than dies);
//    §4 read-only destination: POSIX read-only DIR ⇒ structural EACCES at
//       create-temp, immediate, prior intact; win32 read-only FILE ⇒ the
//       REAL persistent-EPERM shape — full retry budget, typed failure,
//       prior intact and READABLE throughout, then success after the
//       attribute clears;
//    §5 concurrent writers (20 overlapping publish rounds, one clearing
//       transient injected on win32): the final file is always ONE complete
//       payload, zero temps.
// ============================================================================
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetFaultInjectionCountersForTests,
  cleanupOrphanDurableTemps,
  durableAtomicPublish,
  DurablePublishError,
  isDurableTempName,
} from '../../src/substrate/durablePublish.ts'

const IS_WIN = process.platform === 'win32'
let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mooring-mo4-'))
const BUN = process.execPath
const KILL_CHILD = join(import.meta.dir, '..', 'reliability', 'helpers', 'durablePublishKillChild.ts')
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)
const inject = (spec: string | null): void => {
  if (spec === null) delete process.env.MERCURY_FAULT_INJECT
  else process.env.MERCURY_FAULT_INJECT = spec
  _resetFaultInjectionCountersForTests()
}
const runChild = (target: string, content: string, fault: string): ReturnType<typeof spawnSync> =>
  spawnSync(BUN, ['run', KILL_CHILD], {
    env: {
      ...process.env,
      RELIA_TARGET: target,
      RELIA_CONTENT: content,
      MERCURY_FAULT_INJECT: fault,
      MERCURY_FAULT_INJECT: fault,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
const diedAbruptly = (r: ReturnType<typeof spawnSync>): boolean =>
  r.signal === 'SIGKILL' || (IS_WIN && r.status !== null && r.status !== 0)
console.log(`── mo4 kill/cleanup/read-only/concurrency — live platform: ${process.platform}`)

// ── §1 kill at the rename boundary + the sweeper's discipline ───────────────
{
  const dir = join(tmp, 's1')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'target.json')
  writeFileSync(p, 'old-complete')
  const r = runChild(p, 'new-complete', 'rename@target.json:kill')
  ok(diedAbruptly(r), '§1 child died at the rename boundary', `signal=${r.signal} status=${r.status}`)
  ok(readFileSync(p, 'utf8') === 'old-complete', '§1 destination stays old-complete')
  ok(tempsIn(dir).length === 1, `§1 exactly one owned orphan temp (${tempsIn(dir).length})`)
  // Cleanup-delay discipline: a YOUNG temp is never collected...
  const early = await cleanupOrphanDurableTemps(dir, { olderThanMs: 10 * 60_000 })
  ok(early.length === 0 && tempsIn(dir).length === 1, '§1 age gate: a young temp survives the sweep (no live-writer race)')
  // ...and the sweeper NEVER touches the committed destination.
  const aged = await cleanupOrphanDurableTemps(dir, { olderThanMs: 0 })
  ok(aged.length === 1 && tempsIn(dir).length === 0, '§1 the aged orphan is collected')
  ok(readFileSync(p, 'utf8') === 'old-complete', '§1 the sweeper never removed the previous good file')
}

// ── §2 kill after the rename ────────────────────────────────────────────────
{
  const dir = join(tmp, 's2')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'target.json')
  writeFileSync(p, 'old-complete')
  const r = runChild(p, 'new-complete', 'flush-dir@target.json:kill')
  ok(
    diedAbruptly(r) && readFileSync(p, 'utf8') === 'new-complete',
    '§2 kill@flush-dir: destination is new-complete (whole-old-or-whole-new, never between)',
  )
}

// ── §3 kill between retry attempts ──────────────────────────────────────────
{
  const dir = join(tmp, 's3')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'target.json')
  writeFileSync(p, 'old-complete')
  const spec = 'rename@target.json:eperm#1;rename@target.json:kill'
  const r = runChild(p, 'new-complete', spec)
  if (IS_WIN) {
    // Attempt 1 injects EPERM → the loop sleeps → attempt 2 hits the kill.
    ok(diedAbruptly(r), '§3 win32: child died INSIDE the retry loop', `signal=${r.signal} status=${r.status}`)
    ok(readFileSync(p, 'utf8') === 'old-complete', '§3 win32: destination still old-complete')
    const orphans = tempsIn(dir)
    ok(orphans.length === 1, '§3 win32: the prepared replacement was still valid between attempts (one orphan)')
    await cleanupOrphanDurableTemps(dir, { olderThanMs: 0 })
    ok(tempsIn(dir).length === 0, '§3 win32: the orphan sweeps clean')
  } else {
    // POSIX platform gate: the first EPERM is terminal — the child EXITS
    // with the typed failure; the kill point is never reached.
    ok(r.signal === null && r.status !== 0, '§3 POSIX: typed exit, kill point unreachable (single-attempt gate)')
    ok(readFileSync(p, 'utf8') === 'old-complete' && tempsIn(dir).length === 0, '§3 POSIX: old-complete, temp cleaned')
  }
}

// ── §4 read-only destination ────────────────────────────────────────────────
if (!IS_WIN) {
  const dir = join(tmp, 's4')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'ro.json')
  await durableAtomicPublish(p, 'committed')
  chmodSync(dir, 0o555)
  let caught: unknown = null
  const started = Date.now()
  try {
    await durableAtomicPublish(p, 'doomed')
  } catch (e) {
    caught = e
  }
  const wall = Date.now() - started
  chmodSync(dir, 0o755)
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null && err.phase === 'create-temp' && err.fsCode === 'EACCES' && err.attempts === 1,
    '§4 POSIX read-only dir: structural EACCES at create-temp, one attempt',
    err ? `phase=${err.phase} fsCode=${err.fsCode}` : String(caught),
  )
  ok(wall < 5_000, `§4 POSIX: immediate (no retry sleeps, ${wall}ms)`)
  ok(readFileSync(p, 'utf8') === 'committed' && tempsIn(dir).length === 0, '§4 POSIX: prior intact, no temp left')
} else {
  const dir = join(tmp, 's4')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'ro.json')
  await durableAtomicPublish(p, 'committed')
  chmodSync(p, 0o444) // FILE_ATTRIBUTE_READONLY — rename-over yields EPERM
  let caught: unknown = null
  const started = Date.now()
  try {
    await durableAtomicPublish(p, 'doomed')
  } catch (e) {
    caught = e
  }
  const wall = Date.now() - started
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null && err.phase === 'rename' && (err.fsCode === 'EPERM' || err.fsCode === 'EACCES'),
    '§4 win32 read-only file: the REAL persistent transient shape, typed',
    err ? `fsCode=${err.fsCode}` : String(caught),
  )
  ok(err?.attempts === 4 && wall >= 350, `§4 win32: full retry budget spent (attempts=${err?.attempts}, ${wall}ms)`)
  ok(err?.tempCleanup === 'removed' && tempsIn(dir).length === 0, '§4 win32: prepared temp cleaned after final failure')
  ok(readFileSync(p, 'utf8') === 'committed', '§4 win32: committed file READABLE throughout')
  chmodSync(p, 0o666)
  const r = await durableAtomicPublish(p, 'after-clear')
  ok(r.attempts === 1 && readFileSync(p, 'utf8') === 'after-clear', '§4 win32: lands cleanly once the attribute clears')
}

// ── §5 concurrent writers ───────────────────────────────────────────────────
{
  const dir = join(tmp, 's5')
  const p = join(dir, 'hot.json')
  if (IS_WIN) inject('rename@hot.json:ebusy#1')
  let anomalies = 0
  for (let i = 0; i < 20; i++) {
    const a = `A${'a'.repeat(16 * 1024)}#${i}`
    const b = `B${'b'.repeat(512)}#${i}`
    const settled = await Promise.allSettled([durableAtomicPublish(p, a), durableAtomicPublish(p, b)])
    // On POSIX every publish must succeed (no injection); on win32 the one
    // injected transient is absorbed by whichever writer hit it.
    if (settled.some(s => s.status === 'rejected')) anomalies++
    else {
      const got = readFileSync(p, 'utf8')
      if (got !== a && got !== b) anomalies++
    }
  }
  inject(null)
  ok(anomalies === 0, `§5 20 overlapping rounds: zero rejections/tears (${anomalies})`)
  ok(tempsIn(dir).length === 0, '§5 zero orphan temps after the storm')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-mo4-kill-cleanup-boundaries' : `\nFAIL prove-mo4-kill-cleanup-boundaries (${failures})`)
process.exit(failures === 0 ? 0 : 1)
