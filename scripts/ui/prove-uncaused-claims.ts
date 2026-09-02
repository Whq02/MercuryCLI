#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-uncaused-claims.ts — WORDING FOLLOWS FACTS (the C4
//  class, product-wide): a band's zero/fallback state never CLAIMS a state
//  its mount condition does not carry. The steer strip's phantom receipt
//  (SWIFT C4) was this class; the concourse strips retired their own bare
//  'thinking…' before it; this ratchet keeps the class dead where it was
//  found again (SWIFTVERIFY W2): a turn-live fact without a phase fact
//  wears the honest generic, never a phase word.
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('the uncaused-claim ratchet (zero states claim nothing beyond their fact)')

// The board mirror's activity fallback: state 'working' means "a turn is
// live" — with no activity label there is no phase fact to speak.
const mirror = readFileSync('src/components/concourse/SessionMirror.tsx', 'utf8')
const nowTextAt = mirror.indexOf('const nowText =')
const nowTextBody = mirror.slice(nowTextAt, mirror.indexOf('const clusterDesired', nowTextAt))
check("the mirror's bare working fallback claims no phase", !nowTextBody.includes("'thinking'"), nowTextBody.slice(0, 120))
check('…and wears the honest generic', nowTextBody.includes("'working…'"))

// The run-detail pane's live-agent line: 'progress' with no tool fact says
// only that the agent is working — never which phase.
const pane = readFileSync('src/components/tasks/RunDetailPane.tsx', 'utf8')
const paneNowAt = pane.indexOf('const nowText =')
const paneNowBody = pane.slice(paneNowAt, pane.indexOf('const attemptCalls', paneNowAt))
check("the run pane's bare progress fallback claims no phase", !paneNowBody.includes("'thinking'"), paneNowBody.slice(0, 120))
check('…and wears the honest generic', paneNowBody.includes("'working…'"))

console.log(failures === 0 ? '\nprove-uncaused-claims: ALL LAWS HOLD' : `\nprove-uncaused-claims: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
