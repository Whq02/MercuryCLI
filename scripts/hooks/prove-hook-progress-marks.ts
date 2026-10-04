#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const hookEventsModule = await import('../../src/utils/hooks/hookEvents.ts')
const { hookProgressReporter, registerHookEventHandler } = hookEventsModule
type HookExecutionEvent = hookEventsModule.HookExecutionEvent
const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/utils/hooks/hookEvents.ts', import.meta.url), 'utf8'))

check('the 1000 ms progress poll is gone from the engine (no setInterval in the module)', !source.includes('setInterval'))

const events: HookExecutionEvent[] = []
const startMs = Date.now()
const chunkTimes: number[] = []
registerHookEventHandler(e => {
  events.push(e)
  if (e.type === 'progress' && e.hookId === 'probe') chunkTimes.push(Date.now() - startMs)
})

const writer = spawn('/bin/sh', ['-c', 'printf "line one\\n"; sleep 0.9; printf "line two\\n"; sleep 0.9; printf "line three\\n"'], { stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
const report = hookProgressReporter({ hookId: 'probe', hookName: 'probe', hookEvent: 'SessionStart' })
writer.stdout.on('data', d => { stdout += d; report({ stdout, stderr, output: stdout + stderr }) })
writer.stderr.on('data', d => { stderr += d; report({ stdout, stderr, output: stdout + stderr }) })
await new Promise<void>(resolve => writer.on('close', () => resolve()))

const progressEvents = events.filter(e => e.type === 'progress') as Array<{ type: 'progress'; output: string }>
check('progress marks moved on the output chunks (three chunks, three distinct outputs)', progressEvents.length >= 3, `got ${progressEvents.length}`)
check('each chunk\'s mark carries its own bytes (not a sampled tail)', progressEvents.some(e => e.output.includes('line one') && !e.output.includes('line two')))
check('the last mark carries every chunk', progressEvents.length > 0 && progressEvents[progressEvents.length - 1].output.includes('line three'))
check('no mark arrives from a timer (the first mark lands within 400ms of its chunk, well under the old 1000ms tick)', chunkTimes.length === 0 || chunkTimes[0] < 400, chunkTimes[0] !== undefined ? `first at ${chunkTimes[0]}ms` : '')

const unchanged = hookProgressReporter({ hookId: 'probe2', hookName: 'p2', hookEvent: 'SessionStart' })
const before = events.length
unchanged({ stdout: 'same', stderr: '', output: 'same' })
unchanged({ stdout: 'same', stderr: '', output: 'same' })
const added = events.length - before
check('an unchanged output emits nothing (the coalescing the poll had, kept)', added === 1, `got ${added}`)

if (failures > 0) {
  console.log(`❌ ${failures} HOOK PROGRESS MARK CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ hook progress marks come from the output chunks, never a timer')
