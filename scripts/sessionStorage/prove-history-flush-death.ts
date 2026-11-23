#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'history-flush-death-'))
process.env.MERCURY_CONFIG_DIR = HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { addToHistory, flushHistoryNow, getHistoryFlushHealth } = await import(
  '../../src/sessions/promptHistory.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ' | to fix, change the history flush in src/sessions/promptHistory.ts (flushHistoryNow, getHistoryFlushHealth, and the lock call there with its 10 second stale limit) so a held lock keeps every pending entry, a stale lock is broken, and entries land in order'}`)
  if (!cond) failures++
}
const section = (t: string): void =>
  console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
mkdirSync(lockDir)
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


console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} HISTORY-FLUSH-DEATH PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL HISTORY-FLUSH-DEATH PROOFS PASS')
