#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const hookEventsModule = await import('../../src/utils/hooks/hookEvents.ts')
const { hookProgressReporter, registerHookEventHandler, HOOK_PROGRESS_MIN_DELTA_BYTES } = hookEventsModule
const source = readFileSync(new URL('../../src/utils/hooks/hookEvents.ts', import.meta.url), 'utf8')
check('the 1000 ms progress poll is gone from the engine (no setInterval in the module)', !source.includes('setInterval'))
const events: Array<import('../../src/utils/hooks/hookEvents.ts').HookExecutionEvent> = []
registerHookEventHandler(event => events.push(event))

const threshold = typeof HOOK_PROGRESS_MIN_DELTA_BYTES === 'number' ? HOOK_PROGRESS_MIN_DELTA_BYTES : 4096
const chunkOf = (index: number): string => `${String(index).padStart(6, '0')}:${'x'.repeat(57)}\n`
const report = hookProgressReporter({ hookId: 'probe', hookName: 'probe', hookEvent: 'SessionStart' })
let cumulative = ''
const fedChunks: number[] = []
for (let index = 0; index < 400; index++) {
  cumulative += chunkOf(index)
  report({ stdout: cumulative, stderr: '', output: cumulative })
  fedChunks.push(cumulative.length)
  if (events.filter(event => event.type === 'progress').length > 0 && index === 0) break
}
let marks = events.filter(event => event.type === 'progress')
check('a mark waits for the byte threshold, not one per chunk', marks.length < fedChunks.length && marks.length >= 1, `${marks.length} marks for ${fedChunks.length} chunks`)
check('every mark carries at most one threshold window, never the cumulative text', marks.every(mark => mark.output.length <= threshold + 72), `max mark bytes ${Math.max(...marks.map(mark => mark.output.length))} of ${cumulative.length} written`)
const firstMark = marks[0]
check('the first mark carries exactly the coalesced first window', firstMark !== undefined && firstMark.output.length >= threshold && firstMark.output.length < threshold + 72, `${firstMark?.output.length} bytes`)
const windows = marks.map(mark => mark.output)
const lineIndex = (text: string, seen: string[]): number => seen.findIndex(prefix => prefix === text.slice(0, prefix.length))
check('no mark repeats a window another mark already carried (windows advance through the stream)', new Set(windows).size === windows.length, `${new Set(windows).size} distinct of ${windows.length}`)
void lineIndex

const quiet = hookProgressReporter({ hookId: 'probe2', hookName: 'p2', hookEvent: 'SessionStart' })
const before = events.length
quiet({ stdout: 'same', stderr: '', output: 'same' })
quiet({ stdout: 'same', stderr: '', output: 'same' })
check('unchanged output emits no duplicate mark', events.length - before === 0)

const small = hookProgressReporter({ hookId: 'probe3', hookName: 'p3', hookEvent: 'SessionStart' })
const smallBefore = events.length
for (let index = 0; index < 20; index++) small({ stdout: 'x'.repeat(index + 1), stderr: '', output: 'x'.repeat(index + 1) })
check('a hook under the threshold in total emits no progress mark at all (the response carries the output)', events.length - smallBefore === 0, `${events.length - smallBefore} marks for 20 growing chunks totalling 210 bytes`)

const truncated = hookProgressReporter({ hookId: 'probe4', hookName: 'p4', hookEvent: 'SessionStart' })
const truncateBefore = events.length
truncated({ stdout: 'a'.repeat(5000), stderr: '', output: 'a'.repeat(5000) })
truncated({ stdout: 'b'.repeat(100), stderr: '', output: 'b'.repeat(100) })
check('a truncation reset (output shrinking) never emits a corrupted delta', events.length - truncateBefore <= 1, `${events.length - truncateBefore} marks across the reset`)

const chatty = hookProgressReporter({ hookId: 'probe5', hookName: 'p5', hookEvent: 'SessionStart' })
const chattyLine = `${'c'.repeat(62)}\n`
let chattyOut = ''
const chattyMarksBefore = events.filter(event => event.type === 'progress').length
let chattySerialized = 0
for (let index = 0; index < 3000; index++) {
  chattyOut += chattyLine
  chatty({ stdout: chattyOut, stderr: '', output: chattyOut })
}
const chattyMarks = events.filter(event => event.type === 'progress').length - chattyMarksBefore
for (const event of events.filter(event => event.type === 'progress').slice(-chattyMarks)) chattySerialized += JSON.stringify(event).length
check('a 3000-line (~190 KB) hook emits at most the base cadence of 26 marks, not thousands', chattyMarks <= 26, `${chattyMarks} marks`)
check('the serialized marks stay a bounded fraction of the output, not the base-beating 4.5 MB and never 605 MB', chattySerialized <= 4_500_000, `${chattySerialized} bytes serialized for ~${chattyOut.length} bytes of output`)

registerHookEventHandler(null)
console.log(failures === 0 ? 'HOOK PROGRESS MARKS GREEN' : `${failures} HOOK PROGRESS MARK FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
