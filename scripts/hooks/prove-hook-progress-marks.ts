#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const hookEventsModule = await import('../../src/utils/hooks/hookEvents.ts')
const { hookProgressReporter, registerHookEventHandler } = hookEventsModule
const source = readFileSync(new URL('../../src/utils/hooks/hookEvents.ts', import.meta.url), 'utf8')
check('the 1000 ms progress poll is gone from the engine (no setInterval in the module)', !source.includes('setInterval'))
const events: Array<import('../../src/utils/hooks/hookEvents.ts').HookExecutionEvent> = []
registerHookEventHandler(event => events.push(event))
const writer = spawn(process.execPath, ['-e', "let n=0;process.stdin.on('data',()=>process.stdout.write(['line one\\n','line two\\n','line three\\n'][n++]));process.stdin.on('end',()=>process.exit(0))"], { stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''
let chunks = 0
let synchronousMarks = true
const report = hookProgressReporter({ hookId: 'probe', hookName: 'probe', hookEvent: 'SessionStart' })
writer.stdout.on('data', data => {
  stdout += String(data)
  const before = events.length
  report({ stdout, stderr: '', output: stdout })
  synchronousMarks &&= events.length === before + 1
  chunks++
  if (chunks < 3) writer.stdin.write('next\n')
  else writer.stdin.end()
})
const guard = setTimeout(() => { writer.kill('SIGTERM'); console.error('FAIL progress fixture exceeded its liveness deadline'); process.exit(1) }, 15_000)
writer.stdin.write('next\n')
await new Promise<void>(resolve => writer.once('close', () => resolve()))
clearTimeout(guard)
const marks = events.filter(event => event.type === 'progress')
check('each acknowledged output chunk has exactly one progress mark', chunks === 3 && marks.length === chunks, `chunks=${chunks} marks=${marks.length}`)
check('each chunk carries its own bytes rather than a sampled tail', marks.some(event => event.output.includes('line one') && !event.output.includes('line two')))
check('the last mark carries all output chunks', marks.at(-1)?.output.includes('line three') === true)
check('progress is observable inside the output callback before the next chunk is acknowledged', synchronousMarks)
const unchanged = hookProgressReporter({ hookId: 'probe2', hookName: 'p2', hookEvent: 'SessionStart' })
const before = events.length
unchanged({ stdout: 'same', stderr: '', output: 'same' })
unchanged({ stdout: 'same', stderr: '', output: 'same' })
check('unchanged output emits no duplicate mark', events.length - before === 1)
registerHookEventHandler(null)
console.log(failures === 0 ? 'HOOK PROGRESS MARKS GREEN' : `${failures} HOOK PROGRESS MARK FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
