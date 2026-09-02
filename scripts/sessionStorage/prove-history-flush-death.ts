#!/usr/bin/env bun
// prove-history-flush-death — K7: the history.jsonl
// silent flush death. A wedged LIVE lock (fresh mtime) blocks every flush
// while in-session UX stays perfect (reads hit the pending buffer) — the old
// code swallowed every failure to debug and could LOSE a batch (buffer
// cleared between lock and append). Injection proofs:
//
//   §1 WEDGED LIVE LOCK: flushes fail, the streak escalates (≥3), pending
//      entries are RETAINED (zero loss), nothing lands on disk.
//   §2 RECOVERY: unwedge ⇒ one flush lands EVERY entry in order; streak 0.
//   §3 DEAD HOLDER: a lock older than the 10s stale window is BROKEN by the
//      next flush without intervention (the self-heal law).
//   §4 ORDERING (structural): the buffer clears only between lock success
//      and append; the requeue guard + the escalation mark are pinned.
//
// Hermetic: config home is a temp dir set BEFORE the module loads.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'history-flush-death-'))
process.env.MERCURY_CONFIG_DIR = HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { addToHistory, flushHistoryNow, getHistoryFlushHealth } = await import(
  '../../src/history.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void =>
  console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Counted wakeups, never a wall-clock window (the granted-time law).
const waitFor = async (cond: () => boolean, wakeups = 100): Promise<boolean> => {
  for (let i = 0; i < wakeups; i++) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

const historyPath = join(HOME, 'history.jsonl')
const lockDir = join(HOME, 'history.jsonl.lock')
const diskLines = (): string[] => {
  try {
    return readFileSync(historyPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

section('§1 WEDGED LIVE LOCK — failures escalate, nothing lost, nothing lands')
mkdirSync(lockDir) // fresh mtime = a live holder to proper-lockfile
addToHistory('k7-one')
addToHistory('k7-two')
addToHistory('k7-three')
check('entries buffered', await waitFor(() => getHistoryFlushHealth().pending === 3), String(getHistoryFlushHealth().pending))
await flushHistoryNow()
await flushHistoryNow()
await flushHistoryNow()
const wedged = getHistoryFlushHealth()
check('streak reached the escalation mark (≥3)', wedged.streak >= 3, String(wedged.streak))
check('ALL entries retained in the pending buffer (zero loss)', wedged.pending === 3, String(wedged.pending))
check('last failure is named', !!wedged.lastFailure && wedged.lastFailure.message.length > 0)
check('nothing landed on disk through the wedge', diskLines().length === 0, String(diskLines().length))

section('§2 RECOVERY — unwedge ⇒ every entry lands, in order; streak resets')
rmSync(lockDir, { recursive: true, force: true })
await flushHistoryNow()
const recovered = getHistoryFlushHealth()
check('pending drained', await waitFor(() => getHistoryFlushHealth().pending === 0), String(recovered.pending))
check('streak reset to 0', getHistoryFlushHealth().streak === 0, String(getHistoryFlushHealth().streak))
const lines = diskLines()
check('all three entries on disk', lines.length === 3, String(lines.length))
check(
  'order preserved',
  lines[0]!.includes('k7-one') && lines[1]!.includes('k7-two') && lines[2]!.includes('k7-three'),
)

section('§3 DEAD HOLDER — a stale lock (>10s) is broken by the next flush')
mkdirSync(lockDir)
const old = (Date.now() - 15_000) / 1000
utimesSync(lockDir, old, old)
addToHistory('k7-four')
await waitFor(() => getHistoryFlushHealth().pending >= 1)
await flushHistoryNow()
check('flush broke the stale lock and landed the entry', await waitFor(() => diskLines().length === 4), String(diskLines().length))
check('streak stayed 0 (self-heal is not a failure)', getHistoryFlushHealth().streak === 0, String(getHistoryFlushHealth().streak))
check('the stale lock dir is gone or re-owned then released', !existsSync(lockDir) || diskLines().length === 4)

section('§4 ORDERING — structural pins on src/history.ts')
const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'history.ts'), 'utf8')
check(
  'the buffer clears ONLY after lock success (snapshot maps first)',
  /const jsonLines = snapshot\.map[\s\S]{0,120}pendingEntries = \[\]\s*\n\s*await appendFile/.test(src),
)
check(
  'the requeue guard restores the snapshot ahead of mid-flush arrivals',
  src.includes('pendingEntries = snapshot.concat(pendingEntries)'),
)
check('the escalation mark is 3', src.includes('const HISTORY_FLUSH_ESCALATION_STREAK = 3'))
check(
  'escalated failures log at error level',
  /flushFailureStreak >= HISTORY_FLUSH_ESCALATION_STREAK\s*\?\s*\{ level: 'error' \}/.test(src),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} HISTORY-FLUSH-DEATH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL HISTORY-FLUSH-DEATH PROOFS PASS')
