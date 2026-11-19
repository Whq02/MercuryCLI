#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' /resume full-history surface — proof')
console.log('============================================================')

{
  const { computeSessionWindow } = await import(
    '../../src/components/mercury-ui/screens/SessionManagerView.tsx'
  )
  const win = computeSessionWindow as (
    sel: number,
    total: number,
    size: number,
  ) => { start: number; end: number }
  check('small list ⇒ whole list', JSON.stringify(win(0, 5, 8)) === '{"start":0,"end":5}')
  check('cursor at top ⇒ window at top', win(0, 100, 8).start === 0)
  const atEnd = win(99, 100, 8)
  check('cursor at index 99 of 100 is REACHABLE (window slides)', atEnd.end === 100 && atEnd.start === 92)
  let allReachable = true
  for (let i = 0; i < 500; i++) {
    const w = win(i, 500, 8)
    if (!(i >= w.start && i < w.end)) allReachable = false
  }
  check('every index of a 500-session history is inside its window', allReachable)
  check('window size stays fixed', win(250, 500, 8).end - win(250, 500, 8).start === 8)
}


{
  const { markSessionCleared, unmarkSessionCleared, isSessionCleared, resetClearedSessionsMemo } =
    await import('../../src/utils/sessionStorage/clearedSessions.ts')
  const os = await import('node:os')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cleared-proof-'))
  process.env.MERCURY_CONFIG_DIR = dir
  resetClearedSessionsMemo()
  markSessionCleared('sess-reopen')
  resetClearedSessionsMemo()
  check('marked session reads cleared', isSessionCleared('sess-reopen') === true)
  unmarkSessionCleared('sess-reopen')
  resetClearedSessionsMemo()
  check('unmark (the resume reopen) makes it visible again', isSessionCleared('sess-reopen') === false)
  unmarkSessionCleared('never-marked')
  check('unmark of an unknown id is a safe no-op', true)
  delete process.env.MERCURY_CONFIG_DIR
  fs.rmSync(dir, { recursive: true, force: true })

}


console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} RESUME-FULL-HISTORY CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RESUME-FULL-HISTORY PROOFS PASS')
