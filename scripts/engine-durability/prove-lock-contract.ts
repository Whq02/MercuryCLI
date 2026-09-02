#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-lock-contract.ts — M0 reproducer for defect F,
//  the cross-process store lock's missing ownership contract.
//
//  ORACLE: a locked read-modify-write is only linearizable if the writer can
//  learn that it no longer owns the lock. Losing ownership must surface, and a
//  mutation that lost its lock must not publish as though it had one.
//
//  What the code does today — src/substrate/fileStore.ts:
//      export const STORE_LOCK_OPTIONS = {
//        retries: { retries: 30, minTimeout: 5, maxTimeout: 100, randomize: true },
//      } as const
//  Retries only. No explicit stale interval, no refresh interval, and no
//  compromise handler, while the `locked` helper performs a cross-process
//  read → mutate → publish → release cycle exposed as update/mutate/write.
//  Missed invariant: linearizable multi-process updates. In-process work
//  serializes on a per-path `opChain`, so cross-process correctness rests
//  entirely on a staleness clock nobody configured.
//
//  This is the repo's own OPEN row STALE-STEAL-UNDER-DESCHEDULE
//  (the concurrency case where a lock's stale
//  timeout expires while its holder is merely descheduled, after which two
//  processes each believe they hold it. Recorded OPEN with the
//  hardening options "deliberately NOT decided".
//
//  The loss is forced DETERMINISTICALLY here (the lock is removed from inside
//  the critical section, which is exactly the state a stale-timeout expiry
//  leaves behind) rather than waited out on a clock — a staleness wait would
//  be a wall-clock race, and the paused-holder stress belongs to
//  multi-process acceptance.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite, waitUntil } from './harness.ts'

/** The real proper-lockfile the store uses, resolved for the child process. */
const LOCKFILE_MODULE = createRequire(import.meta.url).resolve('proper-lockfile')

const ROOT = scratchRoot('lock')
const t = checker()

const { defineStore, STORE_LOCK_OPTIONS } = await import('../../src/substrate/fileStore.ts')
const lockfileUtil = await import('../../src/utils/lockfile.ts')

// ── §1 the declared lock contract ──────────────────────────────────────────
t.section('§1 — the store lock declares its ownership contract explicitly')
{
  const opts = STORE_LOCK_OPTIONS as unknown as Record<string, unknown>
  t.check(
    'an explicit stale interval is declared',
    typeof opts.stale === 'number',
    `stale=${String(opts.stale)}`,
  )
  t.check(
    'an explicit lock-refresh interval is declared',
    typeof opts.update === 'number',
    `update=${String(opts.update)}`,
  )
  t.check(
    'a compromise handler is declared',
    typeof opts.onCompromised === 'function',
    `onCompromised=${typeof opts.onCompromised}`,
  )
}

// ── §2 a writer that loses its lock mid-mutation ───────────────────────────
t.section('§2 — a mutation that lost its lock does not publish as though it held one')
{
  const path = guardWrite(ROOT, join(ROOT, 'lock-probe.json'))
  const store = defineStore<{ n: number }>({
    name: 'keel-lock-probe',
    path: () => path,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object'
        ? { n: Number((raw as { n?: unknown }).n ?? 0) }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'empty',
  })()

  await store.write({ n: 1 })

  let ownershipLossSurfaced = false
  try {
    await store.update(current => {
      // Another process breaks the lock while this holder is inside its
      // critical section — the exact state a stale-timeout expiry leaves.
      rmSync(`${path}.lock`, { recursive: true, force: true })
      return { next: { n: current.n + 1 }, result: undefined }
    })
  } catch {
    ownershipLossSurfaced = true
  }

  const after = await store.read()
  t.check(
    'the writer learns its lock ownership was lost',
    ownershipLossSurfaced,
    ownershipLossSurfaced ? '' : 'the mutation reported success',
  )
  t.check(
    'the unowned mutation did not publish',
    after.n === 1,
    `on-disk n=${after.n} (1 = the committed value before the lost lock)`,
  )
}

// ── §3 two spellings of one store file still exclude each other ────────────
t.section('§3 — a symlinked spelling does not get its own lock')
{
  // The first attempt at making assertStillHeld agree with proper-lockfile
  // PINNED lockfilePath to the caller's literal spelling. That fixed the guard
  // and broke the lock: the library keys exclusion by the resolved real path,
  // so two spellings of one file each acquired their own artefact and both
  // published — a silent lost update, traded for a loud refusal. The guard
  // resolves the real path instead, and this section is what stops that trade
  // from being made again.
  t.check(
    'the declared lock options do not pin lockfilePath',
    !('lockfilePath' in (STORE_LOCK_OPTIONS as Record<string, unknown>)),
    'pinning it keys the artefact by spelling and drops cross-spelling exclusion',
  )

  const real = join(ROOT, 'shared-store.json')
  const alias = join(ROOT, 'alias-store.json')
  writeFileSync(guardWrite(ROOT, real), '{}')
  symlinkSync(real, guardWrite(ROOT, alias))

  const holderScript = join(ROOT, 'holder.cjs')
  writeFileSync(
    guardWrite(ROOT, holderScript),
    [
      "const lockfile = require(" + JSON.stringify(LOCKFILE_MODULE) + ")",
      'const opts = JSON.parse(process.argv[3])',
      'lockfile.lock(process.argv[2], opts).then(async release => {',
      "  console.log('HELD')",
      '  await new Promise(r => setTimeout(r, 4000))',
      '  await release()',
      "}).catch(e => console.log('HOLD-FAILED ' + e.message))",
    ].join('\n'),
  )

  // Only the serializable half of the contract crosses the process boundary;
  // the compromise handler is a function and is exercised by §2.
  const wireOptions = JSON.stringify({
    retries: STORE_LOCK_OPTIONS.retries,
    stale: STORE_LOCK_OPTIONS.stale,
    update: STORE_LOCK_OPTIONS.update,
  })

  const holder = spawn(process.execPath, [holderScript, real, wireOptions], { stdio: 'pipe' })
  let held = false
  holder.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('HELD')) held = true
  })
  const acquired = await waitUntil(() => held, { tries: 200, everyMs: 25 })
  t.check('the holder acquired the lock on the real path', acquired)

  let contenderAcquired = false
  let refusal = ''
  try {
    await lockfileUtil.lock(alias, {
      ...STORE_LOCK_OPTIONS,
      retries: { retries: 0 },
    } as never)
    contenderAcquired = true
  } catch (e) {
    refusal = (e as { code?: string; message?: string }).code ?? String((e as Error).message)
  }
  t.check(
    'a contender on the symlinked spelling is excluded',
    !contenderAcquired,
    contenderAcquired
      ? 'both spellings acquired — the lock no longer excludes across spellings'
      : `refused with ${refusal}`,
  )
  holder.kill('SIGKILL')
}

t.finish('prove-lock-contract')
