#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' /resume full-history surface — proof')
console.log('============================================================')

{
  const { computeSessionWindow } = await import(
    '../../src/screen/widgets/faces/SessionManagerView.tsx'
  )
  const win = computeSessionWindow as (
    sel: number,
    total: number,
    size: number,
  ) => { start: number; end: number }
  check('small list ⇒ whole list', JSON.stringify(win(0, 5, 8)) === '{"start":0,"end":5}', 'fix computeSessionWindow in src/screen/widgets/faces/SessionManagerView.tsx so a list shorter than the window returns the whole list')
  check('cursor at top ⇒ window at top', win(0, 100, 8).start === 0, 'fix computeSessionWindow in src/screen/widgets/faces/SessionManagerView.tsx so a cursor at the top keeps the window at index 0')
  const atEnd = win(99, 100, 8)
  check('cursor at index 99 of 100 is REACHABLE (window slides)', atEnd.end === 100 && atEnd.start === 92, 'fix computeSessionWindow in src/screen/widgets/faces/SessionManagerView.tsx so the window slides to the last rows; got ' + JSON.stringify(atEnd))
  let allReachable = true
  for (let i = 0; i < 500; i++) {
    const w = win(i, 500, 8)
    if (!(i >= w.start && i < w.end)) allReachable = false
  }
  check('every index of a 500-session history is inside its window', allReachable, 'fix computeSessionWindow in src/screen/widgets/faces/SessionManagerView.tsx so the selected index always lies inside start..end')
  check('window size stays fixed', win(250, 500, 8).end - win(250, 500, 8).start === 8, 'fix computeSessionWindow in src/screen/widgets/faces/SessionManagerView.tsx so the window keeps its size in the middle of a long list')
}


{
  const { markSessionCleared, isSessionCleared, resetClearedSessionsMemo } =
    await import('../../src/sessions/transcripts/clearedSessions.ts')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cleared-proof-'))
  process.env.MERCURY_CONFIG_DIR = dir
  resetClearedSessionsMemo()
  markSessionCleared('sess-reopen')
  resetClearedSessionsMemo()
  check('marked session reads cleared', isSessionCleared('sess-reopen') === true, 'fix markSessionCleared or isSessionCleared in src/sessions/transcripts/clearedSessions.ts so a marked session persists across a memo reset')
  delete process.env.MERCURY_CONFIG_DIR
  fs.rmSync(dir, { recursive: true, force: true })

}


console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} RESUME-FULL-HISTORY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RESUME-FULL-HISTORY PROOFS PASS')
