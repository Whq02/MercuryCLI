#!/usr/bin/env bun
// ============================================================================
//  prove-mo6-win32-open-handle — the NORMAL Windows
//  open-file lifecycle, with a REAL foreign handle (no injection).
//
//  A PowerShell child opens the destination with FileShare.Read (readable by
//  everyone, NOT renameable-over — exactly what antivirus/indexer/editor
//  handles do), holds it, and releases ON COMMAND: the holder polls (~25ms)
//  for a release-sentinel file and closes the instant it appears. No timed
//  hold anywhere — the first hosted run proved the clock race (a 250ms
//  Start-Sleep stretched past the whole 350ms retry budget under runner
//  scheduling; run 31127455884: EPERM persisted through 4 attempts over
//  405ms and the uncaught throw crashed the prover). A generous timed
//  fallback (~10s) means a crashed prover can never wedge the runner.
//
//    §1 a short hold released MID-BUDGET: the publish is started unawaited,
//       observed still in flight at +50ms (the retry arm demonstrably
//       engaged), THEN the release is commanded — the publication retries
//       and lands the complete new value; a starved runner that lets the
//       ladder exhaust before the commanded release lands (the
//       lane red) DEGRADES to §2's typed-failure discipline plus the
//       post-release landing, loudly named — never a red for losing a
//       scheduler race the budget contract is allowed to lose;
//    §2 a hold outlasting the budget BY CONSTRUCTION (released only after
//       the typed failure is captured): fails typed with the full
//       accounting, the committed file stays READABLE the whole time, the
//       prepared temp is cleaned — and the very next publish (after the
//       commanded release) lands.
//
//  Every section is crash-proof: ANY unexpected throw is a ❌ check with the
//  typed accounting printed, never a prover crash.
//
//  win32-only by nature: on POSIX an open handle never blocks rename, so
//  this prover SKIPS LOUDLY (exit 0) — the windows-functional lane is where
//  it proves the field defect.
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  durableAtomicPublish,
  DurablePublishError,
  isDurableTempName,
  type DurablePublishReport,
} from '../../src/substrate/durablePublish.ts'

if (process.platform !== 'win32') {
  console.log('── mo6 win32 open-handle lifecycle — SKIP (POSIX host: an open handle never blocks rename here).')
  console.log('   The windows-functional lane runs this prover on a real NTFS runner.')
  console.log('\nPASS prove-mo6-win32-open-handle (skipped: not win32)')
  process.exit(0)
}

let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mooring-mo6-'))
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** ❌ detail that never loses the typed accounting. */
const describe = (e: unknown): string =>
  e instanceof DurablePublishError
    ? `DurablePublishError phase=${e.phase} fsCode=${e.fsCode} attempts=${e.attempts} elapsedMs=${e.elapsedMs} tempCleanup=${e.tempCleanup}`
    : String(e)

interface Holder {
  held: Promise<void>
  done: Promise<number | null>
  kill: () => void
}

/** Open `path` in a PowerShell child with FileShare.Read, print HELD, then
 *  POLL (~25ms) for `releasePath` and close the INSTANT it appears — the
 *  release is command-driven, never clock-raced. `fallbackMs` bounds the
 *  hold so a crashed prover can never wedge the runner. Windows PowerShell
 *  (powershell.exe, 5.1) is guaranteed present on every Windows host —
 *  pwsh is optional there — and every construct below is 5.1-safe. */
function holdFile(path: string, releasePath: string, fallbackMs: number): Holder {
  const q = (s: string): string => s.replace(/'/g, "''")
  const script = [
    `$f=[System.IO.File]::Open('${q(path)}','Open','Read','Read')`,
    `[Console]::Out.WriteLine('HELD')`,
    `[Console]::Out.Flush()`,
    `$deadline=[DateTime]::UtcNow.AddMilliseconds(${fallbackMs})`,
    `while(-not (Test-Path -LiteralPath '${q(releasePath)}') -and ([DateTime]::UtcNow -lt $deadline)){ Start-Sleep -Milliseconds 25 }`,
    `$f.Close()`,
    `[Console]::Out.WriteLine('RELEASED')`,
  ].join('; ')
  const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  let resolveHeld!: () => void
  const held = new Promise<void>(resolve => {
    resolveHeld = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (chunk.includes('HELD')) resolveHeld()
  })
  const done = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  return { held, done, kill: () => void child.kill() }
}

/** HELD, or a loud typed reason — a holder that died or wedged must become a
 *  ❌ check, never an infinite await. */
const awaitHeld = (holder: Holder): Promise<'held' | 'exited' | 'timeout'> =>
  Promise.race([
    holder.held.then(() => 'held' as const),
    holder.done.then(() => 'exited' as const),
    pause(30_000).then(() => 'timeout' as const),
  ])

/** Crash-proof section runner: an uncaught throw is a ❌ with the typed
 *  accounting — the first hosted run died exactly this way (an uncaught
 *  DurablePublishError out of §1). */
async function section(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (e) {
    ok(false, `${label} ran to completion without an uncaught throw`, describe(e))
  }
}

console.log('── mo6 win32 open-handle lifecycle (real foreign handle, command-driven release)')

// ── §1 a short hold, released by command mid-budget ─────────────────────────
await section('§1', async () => {
  const dir = join(tmp, 's1')
  const p = join(dir, 'held.json')
  const release = join(tmp, 's1.release')
  await durableAtomicPublish(p, 'previous-good')
  const holder = holdFile(p, release, 10_000)
  const engaged = await awaitHeld(holder)
  ok(engaged === 'held', '§1 the PowerShell holder engaged (HELD observed)', engaged === 'held' ? '' : engaged)
  if (engaged !== 'held') {
    holder.kill()
    return
  }
  const started = Date.now()
  let settled = false
  const outcome: Promise<{ landed: DurablePublishReport } | { failed: unknown }> = durableAtomicPublish(
    p,
    'new-value',
  ).then(
    r => {
      settled = true
      return { landed: r }
    },
    e => {
      settled = true
      return { failed: e as unknown }
    },
  )
  // One attempt window passes before this check: a clean publish lands in
  // ~10-25ms on this runner class, so a publish still in flight at +50ms
  // proves attempt 1 hit the live handle and the ladder engaged. The
  // release is commanded right after — nominally ~300ms of the 350ms budget
  // remain for the ~25ms sentinel poll. Under CPU starvation BOTH timers
  // stretch and the ladder can legally exhaust first (the lane
  // red — 490ms of EPERM before the holder's poll saw the sentinel): the
  // budget is the product contract and losing that scheduler race is not a
  // defect, so the lost race DEGRADES below instead of redding. MO-1 §3
  // pins mid-ladder clearing deterministically; this section's unique
  // teeth are the REAL foreign handle on both sides of the race.
  await pause(50)
  ok(!settled, '§1 the publish is still in flight at +50ms (the retry arm is demonstrably engaged)')
  writeFileSync(release, 'release')
  const res = await outcome
  const wall = Date.now() - started
  if ('landed' in res) {
    ok(
      res.landed.attempts > 1 && res.landed.retriedTransient,
      `§1 the publish RETRIED through the live handle (attempts=${res.landed.attempts})`,
    )
    ok(readFileSync(p, 'utf8') === 'new-value', '§1 the complete NEW value landed')
    ok(wall < 5_000, `§1 landed promptly once the release was commanded (${wall}ms)`)
  } else {
    // The LOST RACE: exhaustion before the commanded release landed. Hold
    // the typed failure to §2's discipline, then prove the handle really
    // was the blocker: once the holder exits, the same publish lands.
    console.log(`  · §1 LOST RACE under runner starvation (${wall}ms to exhaustion) — degrading to typed-failure discipline`)
    const err = res.failed instanceof DurablePublishError ? res.failed : null
    ok(
      err !== null &&
        err.phase === 'rename' &&
        (err.fsCode === 'EPERM' || err.fsCode === 'EACCES' || err.fsCode === 'EBUSY'),
      '§1 lost race: typed failure with the real fs code',
      describe(res.failed),
    )
    ok(
      err?.attempts === 4 && err?.tempCleanup === 'removed',
      `§1 lost race: full budget spent, temp cleaned (attempts=${err?.attempts}, ${err?.tempCleanup})`,
    )
    ok(readFileSync(p, 'utf8') === 'previous-good', '§1 lost race: the committed file stayed intact through exhaustion')
    await holder.done
    const after = await durableAtomicPublish(p, 'new-value')
    ok(
      after.attempts >= 1 && readFileSync(p, 'utf8') === 'new-value',
      '§1 the publish after the commanded release landed the NEW value',
    )
  }
  ok(tempsIn(dir).length === 0, '§1 no temp residue')
  await holder.done
})

// ── §2 a hold outlasting the budget BY CONSTRUCTION ─────────────────────────
await section('§2', async () => {
  const dir = join(tmp, 's2')
  const p = join(dir, 'stuck.json')
  const release = join(tmp, 's2.release')
  await durableAtomicPublish(p, 'previous-good')
  const holder = holdFile(p, release, 10_000)
  const engaged = await awaitHeld(holder)
  ok(engaged === 'held', '§2 the PowerShell holder engaged (HELD observed)', engaged === 'held' ? '' : engaged)
  if (engaged !== 'held') {
    holder.kill()
    return
  }
  // The release is commanded only AFTER the typed failure is captured, so
  // the hold outlasts the whole retry budget by construction — no clock.
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'never-lands')
  } catch (e) {
    caught = e
  }
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null && err.phase === 'rename' && (err.fsCode === 'EPERM' || err.fsCode === 'EACCES' || err.fsCode === 'EBUSY'),
    '§2 beyond-budget: typed failure with the real fs code',
    err ? `fsCode=${err.fsCode}` : caught === null ? 'the publish unexpectedly LANDED through the held handle' : describe(caught),
  )
  ok(err?.attempts === 4 && (err?.elapsedMs ?? 0) >= 350, `§2 full budget spent (attempts=${err?.attempts}, ${err?.elapsedMs}ms)`)
  ok(err?.tempCleanup === 'removed', `§2 prepared temp cleaned (${err?.tempCleanup})`)
  // Read BEFORE the release is commanded — genuinely DURING the live hold.
  ok(readFileSync(p, 'utf8') === 'previous-good', '§2 the committed file stayed READABLE + intact through the whole hold')
  ok(tempsIn(dir).length === 0, '§2 no orphan replacement left behind')
  writeFileSync(release, 'release')
  await holder.done
  const after = await durableAtomicPublish(p, 'after-release')
  ok(after.attempts === 1 && readFileSync(p, 'utf8') === 'after-release', '§2 the next publish after release lands cleanly')
})

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* scratch under the OS tmpdir — a transiently held remnant is the temp
     cleaner's to collect, never a verdict */
}
console.log(failures === 0 ? '\nPASS prove-mo6-win32-open-handle' : `\nFAIL prove-mo6-win32-open-handle (${failures})`)
process.exit(failures === 0 ? 0 : 1)
