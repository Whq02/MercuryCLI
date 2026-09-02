#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('the uncaused-claim ratchet (zero states claim nothing beyond their fact)')

const mirror = readFileSync('src/components/concourse/SessionMirror.tsx', 'utf8')
const nowTextAt = mirror.indexOf('const nowText =')
const nowTextBody = mirror.slice(nowTextAt, mirror.indexOf('const clusterDesired', nowTextAt))
check("the mirror's bare working fallback claims no phase", !nowTextBody.includes("'thinking'"), nowTextBody.slice(0, 120))
check('…and wears the honest generic', nowTextBody.includes("'working…'"))

const pane = readFileSync('src/components/tasks/RunDetailPane.tsx', 'utf8')
const paneNowAt = pane.indexOf('const nowText =')
const paneNowBody = pane.slice(paneNowAt, pane.indexOf('const attemptCalls', paneNowAt))
check("the run pane's bare progress fallback claims no phase", !paneNowBody.includes("'thinking'"), paneNowBody.slice(0, 120))
check('…and wears the honest generic', paneNowBody.includes("'working…'"))

console.log(failures === 0 ? '\nprove-uncaused-claims: ALL LAWS HOLD' : `\nprove-uncaused-claims: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
