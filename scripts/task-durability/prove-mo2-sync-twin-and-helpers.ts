#!/usr/bin/env bun
// ============================================================================
//  prove-mo2-sync-twin-and-helpers — the SAME retry law at
//  the SYNC publication owner and at the shared plain-rename helpers.
//
//    §1 durableAtomicPublishSync: immediate success report · injected
//       transient (win32 absorbs / POSIX single-attempt) · beyond-budget
//       accounting · structural immediate · prior bytes + temp hygiene;
//    §2 renameWithWin32Retry / renameWithWin32RetrySync: success passthrough
//       (including a caller-supplied doRename — the fs-shim seam), ENOENT
//       structural immediately, transient behavior per platform with the
//       attempt count observable through the injected doRename;
//    §3 the helpers keep EXDEV structural (the LSP move's copy-fallback
//       contract) on every platform.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetFaultInjectionCountersForTests,
  durableAtomicPublishSync,
  DurablePublishError,
  isDurableTempName,
  renameWithWin32Retry,
  renameWithWin32RetrySync,
} from '../../src/substrate/durablePublish.ts'

const IS_WIN = process.platform === 'win32'
let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mooring-mo2-'))
const tempsIn = (dir: string): string[] => readdirSync(dir).filter(isDurableTempName)
const inject = (spec: string | null): void => {
  if (spec === null) delete process.env.MERCURY_FAULT_INJECT
  else process.env.MERCURY_FAULT_INJECT = spec
  _resetFaultInjectionCountersForTests()
}
const errno = (code: string): NodeJS.ErrnoException => {
  const e = new Error(`synthetic ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}
console.log(`── mo2 sync twin + helpers — live platform: ${process.platform}`)

// ── §1 the sync twin ────────────────────────────────────────────────────────
{
  const dir = join(tmp, 's1')
  const p = join(dir, 'sync.json')
  const r = durableAtomicPublishSync(p, 'first')
  ok(r.attempts === 1 && !r.retriedTransient, '§1 clean sync publish: attempts=1', JSON.stringify(r))

  inject('rename@sync.json:ebusy#2')
  if (IS_WIN) {
    const started = Date.now()
    const r2 = durableAtomicPublishSync(p, 'second')
    ok(
      r2.attempts === 3 && r2.retriedTransient && Date.now() - started >= 150,
      '§1 win32: sync twin absorbs the clearing EBUSY (attempts=3, real sleeps)',
      JSON.stringify(r2),
    )
    ok(readFileSync(p, 'utf8') === 'second', '§1 win32: complete new value')
  } else {
    let caught: unknown = null
    try {
      durableAtomicPublishSync(p, 'doomed')
    } catch (e) {
      caught = e
    }
    ok(
      caught instanceof DurablePublishError && caught.fsCode === 'EBUSY' && caught.attempts === 1,
      '§1 POSIX gate: sync twin keeps single-attempt semantics',
    )
    ok(readFileSync(p, 'utf8') === 'first', '§1 POSIX: complete previous value preserved')
  }
  inject(null)

  // beyond-budget accounting (persistent EACCES)
  inject('rename@sync.json:eacces')
  let caught: unknown = null
  try {
    durableAtomicPublishSync(p, 'never')
  } catch (e) {
    caught = e
  }
  inject(null)
  const err = caught instanceof DurablePublishError ? caught : null
  ok(
    err !== null &&
      err.phase === 'rename' &&
      err.fsCode === 'EACCES' &&
      err.attempts === (IS_WIN ? 4 : 1) &&
      err.tempCleanup === 'removed' &&
      err.elapsedMs >= (IS_WIN ? 350 : 0),
    '§1 beyond-budget: phase/fsCode/attempts/elapsedMs/tempCleanup all reported',
    err ? `attempts=${err.attempts} elapsed=${err.elapsedMs} temp=${err.tempCleanup}` : String(caught),
  )
  // structural immediate on both platforms
  inject('rename@sync.json:eisdir')
  let caught2: unknown = null
  try {
    durableAtomicPublishSync(p, 'never')
  } catch (e) {
    caught2 = e
  }
  inject(null)
  ok(
    caught2 instanceof DurablePublishError && caught2.attempts === 1 && caught2.fsCode === 'EISDIR',
    '§1 structural EISDIR: one attempt on every platform',
  )
  ok(tempsIn(dir).length === 0, '§1 zero temp residue across all sync cases')
}

// ── §2 the shared helpers ───────────────────────────────────────────────────
{
  const dir = join(tmp, 's2')
  mkdirSync(dir, { recursive: true })
  // success passthrough (real fs)
  writeFileSync(join(tmp, 's2.seed'), 'move-me')
  const seeded = join(tmp, 's2.seed')
  const dest = join(dir, 'moved.txt')
  const r = await renameWithWin32Retry(seeded, dest).catch(() => null)
  ok(r !== null && r.attempts === 1 && readFileSync(dest, 'utf8') === 'move-me', '§2 async helper: clean move, attempts=1')

  // ENOENT is structural: exactly one underlying attempt, immediate throw.
  let calls = 0
  let caught: unknown = null
  try {
    renameWithWin32RetrySync('/nonexistent/a', join(dir, 'b'), () => {
      calls++
      throw errno('ENOENT')
    })
  } catch (e) {
    caught = e
  }
  ok(
    (caught as NodeJS.ErrnoException)?.code === 'ENOENT' && calls === 1,
    '§2 ENOENT: structural, one attempt, original error rethrown',
  )

  // transient through an injected doRename: platform-gated behavior, with
  // the attempt count OBSERVABLE (this also proves the fs-shim seam works).
  calls = 0
  let result: { attempts: number } | null = null
  caught = null
  try {
    result = renameWithWin32RetrySync(join(dir, 'x'), join(dir, 'y'), () => {
      calls++
      if (calls <= 2) throw errno('EPERM')
    })
  } catch (e) {
    caught = e
  }
  if (IS_WIN) {
    ok(result?.attempts === 3 && calls === 3, `§2 win32: helper retried through the shim (calls=${calls})`)
  } else {
    ok(caught !== null && calls === 1, `§2 POSIX: helper never retries (calls=${calls})`)
  }

  // async twin with injected doRename
  calls = 0
  let aResult: { attempts: number } | null = null
  let aCaught: unknown = null
  try {
    aResult = await renameWithWin32Retry(join(dir, 'x'), join(dir, 'z'), async () => {
      calls++
      if (calls <= 1) throw errno('EBUSY')
    })
  } catch (e) {
    aCaught = e
  }
  if (IS_WIN) {
    ok(aResult?.attempts === 2 && calls === 2, '§2 win32: async helper retried once for a clearing EBUSY')
  } else {
    ok(aCaught !== null && calls === 1, '§2 POSIX: async helper single-attempt')
  }
}

// ── §3 EXDEV stays structural (the copy-fallback contract) ──────────────────
{
  let calls = 0
  let caught: unknown = null
  try {
    await renameWithWin32Retry('/a', '/b', async () => {
      calls++
      throw errno('EXDEV')
    })
  } catch (e) {
    caught = e
  }
  ok(
    (caught as NodeJS.ErrnoException)?.code === 'EXDEV' && calls === 1,
    '§3 EXDEV rethrown on attempt 1 on every platform (callers keep their copy fallback)',
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-mo2-sync-twin-and-helpers' : `\nFAIL prove-mo2-sync-twin-and-helpers (${failures})`)
process.exit(failures === 0 ? 0 : 1)
