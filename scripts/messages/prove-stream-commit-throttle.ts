#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamingTailStore } from '../../src/utils/messages/streamingTailStore.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!fail && !cond) fail++
  else if (!cond) fail++
}
console.log('prove-stream-commit-throttle — live tail commits under a delta storm')

{
  let clock = 0
  let timer: { at: number; fire: () => void } | null = null
  let commits = 0
  const tail = createStreamingTailStore({
    now: () => clock,
    setTimer: (fire, ms) => { timer = { at: clock + ms, fire }; return 1 },
    clearTimer: () => { timer = null },
  })
  tail.subscribe(() => commits++)
  tail.update(() => '')
  check('the opening publishes synchronously', commits === 1)
  for (let i = 0; i < 100; i++) {
    tail.update(cur => (cur ?? '') + 'x')
    clock += 10
    const due = timer as { at: number; fire: () => void } | null
    if (due && due.at <= clock) due.fire()
  }
  const trailing = timer as { at: number; fire: () => void } | null
  if (trailing) { clock = trailing.at; trailing.fire() }
  check('100 deltas stay within the live tail cadence', commits >= 1 && commits <= 40, String(commits))
  check('fresh and published tails contain every byte', tail.read() === 'x'.repeat(100) && tail.getSnapshot() === tail.read())
  const before = commits
  tail.update(cur => cur)
  check('identity updates schedule no work', commits === before && timer === null)
  tail.update(() => null)
  check('the close publishes immediately and retains the last text', tail.getSnapshot() === null && tail.readSettled() === 'x'.repeat(100) && timer === null)
  tail.update(() => 'next')
  tail.update(cur => cur + ' pending')
  tail.dispose()
  check('dispose cancels the trailing publish', timer === null)
  const disposed = commits
  tail.update(() => 'late')
  check('late updates never resurrect the subscriber', commits === disposed)
}

{
  const repl = readFileSync(join(import.meta.dir, '../../src/screens/Chat.tsx'), 'utf8')
  const connector = readFileSync(join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const seat = readFileSync(join(import.meta.dir, '../../src/daemon/sessionSeat.ts'), 'utf8')
  check('the face holds no stream batcher (no batcher.update, no streaming tool-use reset)', !repl.includes('batcher.update(') && !repl.includes('resetStreamingToolUses'))
  check('the connector feeds one streaming tail store from the seat tail feed', connector.includes('tailStore: StreamingTailStore = createStreamingTailStore()') && connector.includes('this.tailStore.update(() => text)'))
  check('the seat publishes its tail on a bounded throttle with a trailing publish', seat.includes('TAIL_PUBLISH_MS = 40') && seat.includes('tailDirty'))
  check('every transcript arm paints the focused tail under the one motion gate (the gate suppresses the text half; the tail mounts on every surface — FN-016 R12)', (repl.match(/streamingTail=\{focusedTail\}/g) ?? []).length === 3 && (repl.match(/streamingTextSuppressed=\{streamingSuppressed\}/g) ?? []).length === 3)
  const streaming = readFileSync(join(import.meta.dir, '../../src/utils/messages/streaming.ts'), 'utf8')
  check('input_json_delta replaces IN PLACE (order-stable — no filter+append reorder)', streaming.includes('const at = current.findIndex(t => t.index === index)') && !streaming.includes('...current.filter(t => t !== element)'))
}

console.log(fail === 0 ? '\n✅ prove-stream-commit-throttle: ALL PASS' : `\n❌ prove-stream-commit-throttle: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
