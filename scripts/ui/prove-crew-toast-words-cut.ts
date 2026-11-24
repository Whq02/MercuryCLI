#!/usr/bin/env bun
import { crewClearedWords } from '../../src/screen/cockpit/crewmateWords.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const cleared = crewClearedWords('scout')
check(
  'crewClearedWords reads "<name> cleared — its transcript stays on disk"',
  cleared === 'scout cleared — its transcript stays on disk',
  JSON.stringify(cleared),
)

console.log(failures === 0 ? 'prove-crew-toast-words-cut: ALL PASS' : `prove-crew-toast-words-cut: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
