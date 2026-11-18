#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const main = readFileSync(join(ROOT, 'src/daemon/main.ts'), 'utf8')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('a deploy-armed restart waits for EVERY live session, counted live: what the count is made of')
const liveAt = main.indexOf('const liveWorkers = (): { live: number; liveSessions: number } => {')
const liveEnd = main.indexOf('return { live, liveSessions }', liveAt)
const live = liveAt !== -1 && liveEnd !== -1 ? main.slice(liveAt, liveEnd) : ''
check('liveWorkers counts every live rostered worker, whenever admitted', live.includes('roster.liveWorkerFacts()') && live.includes('live++'))
check('only pre-booted warm runners are set aside (a claimed late session counts)', live.includes('warmRunnerShorts()') && live.includes('warm.has(w.short)'))
const restartPart = readFileSync(join(ROOT, 'src/daemon/run/restart.ts'), 'utf8')
const beatAt = restartPart.indexOf('export function armedRestartBeat(')
const beatEnd = restartPart.indexOf('\n}\n', beatAt)
const beat = beatAt !== -1 && beatEnd !== -1 ? restartPart.slice(beatAt, beatEnd) : ''
const armAt = main.indexOf('const armedBeat = setInterval(')
const armEnd = main.indexOf('ARMED_RESTART_BEAT_MS)', armAt)
const arm = armAt !== -1 && armEnd !== -1 ? main.slice(armAt, armEnd) : ''
check('the beat holds no count frozen at arming (a session admitted after arming is not excluded): none in the beat of the restart part, none where the daemon arms it', beat !== '' && arm !== '' && !/arm(ed)?Live|liveAtArm|countAtArm|frozen/i.test(beat) && !/arm(ed)?Live|liveAtArm|countAtArm|frozen/i.test(arm))
console.log(`\n${failures === 0 ? 'prove-restart-waits-live: ALL LAWS HOLD' : `prove-restart-waits-live: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
