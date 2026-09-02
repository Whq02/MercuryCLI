#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-writer-epoch.ts — epoch fencing.
//
//  What the code DID: `WRITER_EPOCH = Date.now()` at module load.
//
//  Which invariant that MISSED: an epoch is a FENCING TOKEN, so it must be
//  strictly increasing per writer generation — and a wall clock is not. Two
//  processes started inside the same millisecond take the SAME epoch, and a
//  clock stepped backwards (NTP correction, VM resume, a laptop waking in
//  another timezone) hands a LATER writer a LOWER one than a writer that has
//  already committed. A token that can go backwards cannot fence: the stale
//  writer looks newer and wins the comparison it should lose.
//
//  Laws:
//    1. MONOTONIC   — successive process generations get strictly increasing
//                     epochs.
//    2. CLOCK-PROOF — an epoch claimed while the clock reads EARLIER than the
//                     previous claim is still higher. This is the law the old
//                     code could not satisfy at any speed.
//    3. STABLE      — one process claims exactly ONE epoch however many times
//                     it asks, so every owner it writes shares a token.
//    4. DURABLE     — the claim survives into the counter on disk.
//
//  Law 2 exits 1 at the pre-fix tree by construction: with a Date.now() epoch a
//  backwards clock produces a LOWER number.
// ============================================================================
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'keel-epoch-'))
const guard = (p: string): string => {
  const abs = resolve(p)
  if (!abs.startsWith(resolve(SCRATCH))) throw new Error(`refusing write outside scratch: ${abs}`)
  return abs
}
process.env.MERCURY_CONFIG_DIR = guard(join(SCRATCH, 'home'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const epoch = await import('../../src/services/run/writerEpoch.ts')

console.log('============================================================')
console.log(' writer epoch: monotonic, clock-proof, stable')
console.log('============================================================')

// Each reset models a PROCESS RESTART: the memoized claim is forgotten, so the
// next call must claim afresh from the durable counter.
const claimAsNewProcess = async (): Promise<number> => {
  epoch._resetWriterEpochForTesting()
  return epoch.writerEpoch()
}

const first = await claimAsNewProcess()
const second = await claimAsNewProcess()
const third = await claimAsNewProcess()

check(
  `1. MONOTONIC: three process generations strictly increase (${first} < ${second} < ${third})`,
  first < second && second < third,
  `${first},${second},${third}`,
)

// ── law 2: the clock runs BACKWARDS between claims ──────────────────────────
{
  const realNow = Date.now
  // Move the wall clock far into the past — further than any plausible NTP
  // correction — for the whole of the next claim.
  Date.now = () => realNow() - 86_400_000
  let underBackwardsClock: number
  try {
    underBackwardsClock = await claimAsNewProcess()
  } finally {
    Date.now = realNow
  }
  check(
    `2. CLOCK-PROOF: a claim under a backwards clock still rises (${third} -> ${underBackwardsClock})`,
    underBackwardsClock > third,
    `got ${underBackwardsClock} after ${third}`,
  )
}

// ── law 3 ───────────────────────────────────────────────────────────────────
{
  epoch._resetWriterEpochForTesting()
  const [a, b, c] = await Promise.all([epoch.writerEpoch(), epoch.writerEpoch(), epoch.writerEpoch()])
  check(
    '3. STABLE: one process claims ONE epoch however often it asks',
    a === b && b === c,
    `${a},${b},${c}`,
  )
  check('3b. STABLE: the sync accessor agrees with the claim', epoch.currentWriterEpoch() === a)
}

// ── law 4 ───────────────────────────────────────────────────────────────────
{
  const file = join(process.env.MERCURY_CONFIG_DIR!, 'writer-epoch.json')
  const onDisk = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { epoch?: number }).epoch
    : undefined
  check(
    `4. DURABLE: the counter persisted the claim (${onDisk})`,
    typeof onDisk === 'number' && onDisk >= epoch.currentWriterEpoch(),
    `disk=${onDisk} memory=${epoch.currentWriterEpoch()}`,
  )
}

console.log('════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} epoch law(s) failed`)
  process.exit(1)
}
console.log('✅ WRITER EPOCH FENCES')
