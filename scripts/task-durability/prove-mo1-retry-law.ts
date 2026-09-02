#!/usr/bin/env bun
// ============================================================================
//  prove-mo1-retry-law — the win32 bounded-retry law at the
//  ASYNC publication owner (src/substrate/durablePublish.ts).
//
//    §1 the PURE retry decision table (renameRetryDelayMs) — provable on
//       every platform with the platform pinned explicitly;
//    §2 immediate success: report {attempts:1, retriedTransient:false};
//    §3 short-lived contention that CLEARS (injected eperm#2): win32 absorbs
//       it (attempts=3, elapsed ≥ the two sleeps); POSIX keeps single-attempt
//       semantics byte-identical (typed failure on the FIRST hit) — the
//       platform gate itself;
//    §4 contention beyond the budget: win32 fails typed after 4 attempts
//       with fsCode/elapsedMs/tempCleanup accounting; both platforms keep
//       the previously committed bytes and clean the prepared temp;
//    §5 structural errors return immediately (erofs → attempts=1);
//    §6 fault-grammar compatibility: bare `throw` unchanged; `#N` bound is
//       honored and exhausts deterministically; path filter still scopes.
//
//  Fixtures are deterministic (the designed MERCURY_FAULT_INJECT seam), the
//  scratch root is OUTSIDE the repo (mkdtemp), and env is pinned per case.
// ============================================================================
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetFaultInjectionCountersForTests,
  cleanupOrphanDurableTemps,
  durableAtomicPublish,
  DurablePublishError,
  isDurableTempName,
  isTransientWin32FsCode,
  renameRetryDelayMs,
  WIN32_RENAME_RETRY_DELAYS_MS,
} from '../../src/substrate/durablePublish.ts'

const IS_WIN = process.platform === 'win32'
let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mooring-mo1-'))
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)
const inject = (spec: string | null): void => {
  if (spec === null) delete process.env.MERCURY_FAULT_INJECT
  else process.env.MERCURY_FAULT_INJECT = spec
  _resetFaultInjectionCountersForTests()
}
console.log(`── mo1 retry law (async owner) — live platform: ${process.platform}`)

// ── §1 the pure decision table ───────────────────────────────────────────────
{
  ok(
    JSON.stringify(WIN32_RENAME_RETRY_DELAYS_MS) === '[50,100,200]',
    '§1 the schedule is exactly the updater-proven 50/100/200ms',
  )
  ok(
    isTransientWin32FsCode('EPERM') && isTransientWin32FsCode('EBUSY') && isTransientWin32FsCode('EACCES'),
    '§1 the transient class is exactly EPERM/EBUSY/EACCES',
  )
  ok(
    !isTransientWin32FsCode('ENOENT') && !isTransientWin32FsCode('EROFS') && !isTransientWin32FsCode(undefined),
    '§1 structural codes and absent codes are never transient',
  )
  const t = (
    code: string | undefined,
    attempt: number,
    platform: NodeJS.Platform,
    want: number | null,
  ): boolean => renameRetryDelayMs(code, attempt, platform) === want
  ok(
    t('EPERM', 1, 'win32', 50) &&
      t('EBUSY', 2, 'win32', 100) &&
      t('EACCES', 3, 'win32', 200) &&
      t('EPERM', 4, 'win32', null),
    '§1 win32 transient: 50 → 100 → 200 → stop (4 attempts total)',
  )
  ok(
    t('EPERM', 1, 'darwin', null) && t('EBUSY', 1, 'linux', null),
    '§1 non-win32 platforms NEVER retry (single-attempt semantics)',
  )
  ok(
    t('ENOENT', 1, 'win32', null) && t('EROFS', 1, 'win32', null) && t(undefined, 1, 'win32', null),
    '§1 structural/unknown codes never retry even on win32',
  )
  ok(t('EPERM', 0, 'win32', null), '§1 attempt numbers are 1-based (0 is out of range)')
}

// ── §2 immediate success reports honest accounting ───────────────────────────
{
  const p = join(tmp, 's2', 'store.json')
  const r = await durableAtomicPublish(p, 'first')
  ok(
    r.attempts === 1 && r.retriedTransient === false && r.elapsedMs >= 0 && r.elapsedMs < 10_000,
    '§2 clean publish: attempts=1, retriedTransient=false, sane elapsedMs',
    JSON.stringify(r),
  )
  ok(readFileSync(p, 'utf8') === 'first' && tempsIn(join(tmp, 's2')).length === 0, '§2 bytes landed, zero temps')
}

// ── §3 short-lived contention that clears (eperm#2) ─────────────────────────
{
  const dir = join(tmp, 's3')
  const p = join(dir, 'victim.json')
  await durableAtomicPublish(p, 'committed')
  inject('rename@victim.json:eperm#2')
  if (IS_WIN) {
    const started = Date.now()
    const r = await durableAtomicPublish(p, 'landed')
    const wall = Date.now() - started
    ok(
      r.attempts === 3 && r.retriedTransient === true,
      '§3 win32: two transient failures absorbed, landed on attempt 3',
      JSON.stringify(r),
    )
    ok(wall >= 150, `§3 win32: the two backoff sleeps really happened (${wall}ms ≥ 150ms)`)
    ok(readFileSync(p, 'utf8') === 'landed', '§3 win32: the complete NEW value landed')
  } else {
    let caught: unknown = null
    try {
      await durableAtomicPublish(p, 'doomed')
    } catch (e) {
      caught = e
    }
    ok(
      caught instanceof DurablePublishError &&
        caught.phase === 'rename' &&
        caught.fsCode === 'EPERM' &&
        caught.attempts === 1,
      '§3 POSIX platform gate: the SAME transient code fails on attempt 1 (byte-identical single-attempt semantics)',
      caught instanceof DurablePublishError ? `attempts=${caught.attempts} fsCode=${caught.fsCode}` : String(caught),
    )
    ok(readFileSync(p, 'utf8') === 'committed', '§3 POSIX: the complete PREVIOUS value is untouched')
  }
  inject(null)
  ok(tempsIn(dir).length === 0, '§3 no temp residue either way')
}

// ── §4 contention lasting beyond the retry budget ───────────────────────────
{
  const dir = join(tmp, 's4')
  const p = join(dir, 'stuck.json')
  await durableAtomicPublish(p, 'previous-good')
  inject('rename@stuck.json:eperm')
  const started = Date.now()
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'never-lands')
  } catch (e) {
    caught = e
  }
  const wall = Date.now() - started
  inject(null)
  const err = caught instanceof DurablePublishError ? caught : null
  ok(err !== null && err.phase === 'rename' && err.fsCode === 'EPERM', '§4 typed failure names the phase + fs code')
  if (IS_WIN) {
    ok(err?.attempts === 4, `§4 win32: budget is 1 + 3 retries (attempts=${err?.attempts})`)
    ok(wall >= 350 && (err?.elapsedMs ?? 0) >= 350, `§4 win32: elapsed covers the full backoff (${wall}ms wall, ${err?.elapsedMs}ms reported)`)
  } else {
    ok(err?.attempts === 1, `§4 POSIX: single attempt (attempts=${err?.attempts})`)
  }
  ok(err?.tempCleanup === 'removed', `§4 temp-cleanup outcome reported honestly (${err?.tempCleanup})`)
  ok(typeof err?.elapsedMs === 'number' && err.elapsedMs >= 0, '§4 elapsedMs always reported')
  ok(readFileSync(p, 'utf8') === 'previous-good', '§4 previously committed file available THROUGHOUT')
  ok(tempsIn(dir).length === 0, '§4 the prepared replacement was cleaned after final failure')
  // recovery after the condition clears: the very next publish lands.
  const r = await durableAtomicPublish(p, 'after-clear')
  ok(r.attempts === 1 && readFileSync(p, 'utf8') === 'after-clear', '§4 next publish after the condition clears lands cleanly')
}

// ── §5 structural errors return immediately ─────────────────────────────────
{
  const dir = join(tmp, 's5')
  const p = join(dir, 'ro.json')
  await durableAtomicPublish(p, 'good')
  inject('rename@ro.json:erofs')
  const started = Date.now()
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'doomed')
  } catch (e) {
    caught = e
  }
  const wall = Date.now() - started
  inject(null)
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null && err.phase === 'rename' && err.fsCode === 'EROFS' && err.attempts === 1,
    '§5 EROFS is structural on EVERY platform: one attempt, typed',
    err ? `attempts=${err.attempts}` : String(caught),
  )
  ok(wall < 5_000, `§5 no retry sleeps for structural errors (${wall}ms)`)
  ok(readFileSync(p, 'utf8') === 'good' && tempsIn(dir).length === 0, '§5 prior bytes intact, temp cleaned')
}

// ── §6 fault-grammar compatibility ──────────────────────────────────────────
{
  const dir = join(tmp, 's6')
  const p = join(dir, 'compat.json')
  await durableAtomicPublish(p, 'base')
  // (a) bare `throw` unchanged: no code, typed phase, prior preserved.
  inject('rename@compat.json:throw')
  let caught: unknown = null
  try {
    await durableAtomicPublish(p, 'x')
  } catch (e) {
    caught = e
  }
  ok(
    caught instanceof DurablePublishError && caught.phase === 'rename' && caught.fsCode === undefined,
    '§6 bare `throw` grammar unchanged (no errno attached)',
  )
  // (b) `#N` exhausts deterministically. On POSIX each publish consumes one
  //     hit (no retry): fail, fail, then success. On win32 the FIRST publish
  //     absorbs both hits in its retry loop.
  inject('rename@compat.json:eperm#2')
  if (IS_WIN) {
    const r = await durableAtomicPublish(p, 'y')
    ok(r.attempts === 3, '§6 win32: #2 bound absorbed inside one publish (attempts=3)')
  } else {
    let f1 = false
    let f2 = false
    try {
      await durableAtomicPublish(p, 'y')
    } catch {
      f1 = true
    }
    try {
      await durableAtomicPublish(p, 'y')
    } catch {
      f2 = true
    }
    const r = await durableAtomicPublish(p, 'y')
    ok(f1 && f2 && r.attempts === 1, '§6 POSIX: #2 bound = exactly two failing publishes, then clean success')
  }
  ok(readFileSync(p, 'utf8') === 'y', '§6 the bounded injection ended with the complete new value')
  // (c) the path filter still scopes: injection aimed elsewhere never fires.
  inject('rename@some-other-file.json:eperm')
  const r2 = await durableAtomicPublish(p, 'z')
  inject(null)
  ok(r2.attempts === 1 && readFileSync(p, 'utf8') === 'z', '§6 path filter: unrelated spec never fires')
  ok((await cleanupOrphanDurableTemps(dir, { olderThanMs: 0 })).length === 0, '§6 nothing left for the sweeper')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-mo1-retry-law' : `\nFAIL prove-mo1-retry-law (${failures})`)
process.exit(failures === 0 ? 0 : 1)
