#!/usr/bin/env bun
// ============================================================================
//  prove-flush-drain-ladder — a drain started by flush() walks the same
//  failure ladder as the timer's (release-hardening audit rank 16).
//
//  The gap: flush() called drainWriteQueue() directly, and every reference
//  to the streak, the store-health sentence and the re-arm lived inside the
//  timer callback. A turn-boundary flush — useLogMessages after every
//  turn-boundary record, queryHelpers after each record in the headless
//  path — that failed (a scanner holding the .jsonl, EPERM, ENOSPC) rethrew
//  to its caller and did nothing else: no streak, so the sticky "the
//  session transcript store is unwritable" sentence never armed; and no
//  timer re-armed, so the requeued batch waited for the NEXT enqueue. When
//  that flush was the exit-time one there was no next enqueue, and
//  --resume showed a conversation ending before what the user saw. The
//  law: ONE drain owner; whoever starts a drain, the ladder applies.
//
//  L1 two consecutive flush-initiated failures reject at the caller AND
//     publish the failing fact with the owner's sentence
//  L2 the un-landed batch is retried by the re-armed backoff timer — the
//     store heals, nothing is enqueued, the words land and the fact clears
//  L3 controls: a healthy flush resolves and lands; the timer road still
//     lands without a flush
//  L4 structural: drainWriteQueue() has exactly one caller (the owner)
//
//  PROVE_SRC names another checkout's src (the A/B control: against the
//  pre-fix tree L1's fact, L2 and L4 read red).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const SCRATCH = mkdtempSync(join(tmpdir(), 'flush-ladder-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const writer = await import(join(SRC, 'utils/sessionStorage/writer.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
// A metadata kind (ALWAYS_APPEND) enqueues synchronously on the call — the
// transcript message kinds await a dedup set load first, which would let
// the timer road pick the line up before flush() is even called.
const entry = (_uuid: string, words: string): never => ({ type: 'tag', tag: words, sessionId: 'flush-ladder' }) as never

// The poisoned store: a DIRECTORY where the session .jsonl belongs (EISDIR
// — the same road as a held file, disk-full or a read-only home).
const poisoned = join(SCRATCH, 'session-as-dir.jsonl')
mkdirSync(join(poisoned, 'block'), { recursive: true })
writer.setSessionFileForTesting(poisoned)
const project = writer.getProject()

// ── L1: flush-initiated failures walk the ladder ───────────────────────────
project.appendEntry(entry('00000000-0000-4000-8000-000000000001', 'first words'))
let rejections = 0
let lastError = ''
for (let i = 0; i < 2; i++) {
  try {
    await writer.flushSessionStorage()
  } catch (err) {
    rejections++
    lastError = err instanceof Error ? err.message : String(err)
  }
}
{
  const health = writer.transcriptStoreHealth()
  t('L1 flush() reports each failure to its caller (2 of 2 rejected)', rejections === 2, `${rejections} rejections`)
  t('L1 two consecutive flush-initiated failures publish the failing fact', health.failing === true, JSON.stringify(health))
  t("L1 …carrying the store owner's sentence", (health.sentence ?? '') === lastError && lastError.length > 0, health.sentence ?? '(none)')
}

// ── L2: the re-arm — heal, enqueue NOTHING, the batch lands by itself ──────
rmSync(poisoned, { recursive: true, force: true })
// streak 2 → the re-armed interval is min(100·2², 5000) = 400 ms
await sleep(1_500)
{
  let landed = ''
  try {
    landed = readFileSync(poisoned, 'utf8')
  } catch {
    // stays empty — the check reds
  }
  t('L2 the un-landed batch is retried by the re-armed timer, not by the next enqueue', landed.includes('first words'), 'nothing landed after the heal')
  const health = writer.transcriptStoreHealth()
  t('L2 the first successful drain clears the failing fact', health.failing === false, JSON.stringify(health))
}

// ── L3: controls ───────────────────────────────────────────────────────────
{
  project.appendEntry(entry('00000000-0000-4000-8000-000000000002', 'second words'))
  let healthyFlushRejected = false
  try {
    await writer.flushSessionStorage()
  } catch {
    healthyFlushRejected = true
  }
  const afterFlush = readFileSync(poisoned, 'utf8')
  t('L3 a healthy flush resolves and lands its words', !healthyFlushRejected && afterFlush.includes('second words'))
  project.appendEntry(entry('00000000-0000-4000-8000-000000000003', 'third words'))
  await sleep(600)
  t('L3 the timer road still lands without a flush', readFileSync(poisoned, 'utf8').includes('third words'))
}

// ── L4: structural — one drain owner ───────────────────────────────────────
{
  const src = readFileSync(join(SRC, 'utils/sessionStorage/writer.ts'), 'utf8')
  const callers = src.split('this.drainWriteQueue()').length - 1
  t('L4 the owner exists (runDrain)', src.includes('private runDrain(): Promise<void>'))
  t('L4 drainWriteQueue() has exactly one caller — the owner', callers === 1, `${callers} call sites`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? 'FLUSH DRAIN LADDER: ALL PASS' : 'FLUSH DRAIN LADDER: RED')
process.exit(failures)
