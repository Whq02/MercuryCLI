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
const beatAt = main.indexOf("armPeriodic('the armed-restart beat', ")
const beatEnd = main.indexOf('restartNeeds))', beatAt)
const beat = beatAt !== -1 && beatEnd !== -1 ? main.slice(beatAt, beatEnd) : ''
check('the beat holds no count frozen at arming (a session admitted after arming is not excluded)', beat !== '' && !/arm(ed)?Live|liveAtArm|countAtArm|frozen/i.test(beat))
console.log(`\n${failures === 0 ? 'prove-restart-waits-live: ALL LAWS HOLD' : `prove-restart-waits-live: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
