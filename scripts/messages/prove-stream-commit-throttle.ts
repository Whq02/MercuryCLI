#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamBatcher } from '../../src/utils/messages/streamBatcher.js'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!fail && !cond) fail++
  else if (!cond) fail++
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('prove-stream-commit-throttle — frame-cadence commits under a delta storm')

type Row = { index: number; unparsedToolInput: string }

{
  let commits = 0
  const b = new StreamBatcher<Row[]>([{ index: 0, unparsedToolInput: '' }], {
    sink: () => {
      commits++
    },
  })
  const t0 = Date.now()
  for (let i = 0; i < 100; i++) {
    b.update(cur => {
      const next = cur.slice()
      next[0] = { ...next[0]!, unparsedToolInput: next[0]!.unparsedToolInput + 'x' }
      return next
    })
    await sleep(10)
  }
  await sleep(40)
  const elapsed = Date.now() - t0
  check(`storm of 100 deltas commits ≤70 (got ${commits} in ${elapsed}ms)`, commits <= 70 && commits >= 1)
  check('ref stayed fresh through the storm (esc-interrupt read path)', b.current[0]!.unparsedToolInput.length === 100)
  b.dispose()
}

{
  let commits = 0
  let lastLen = -1
  const b = new StreamBatcher<Row[]>([], {
    sink: v => {
      commits++
      lastLen = v.length
    },
    flushNow: (prev, next) => prev.length !== next.length,
  })
  b.update(cur => [...cur, { index: 0, unparsedToolInput: '' }])
  check('append (content_block_start) commits SYNCHRONOUSLY', commits === 1 && lastLen === 1)
  b.update(cur => {
    const next = cur.slice()
    next[0] = { ...next[0]!, unparsedToolInput: 'a' }
    return next
  })
  check('a same-length delta right after does NOT commit synchronously', commits === 1)
  await sleep(30)
  check('…but the trailing frame flush lands it', commits === 2)
  b.dispose()
}

{
  let commits = 0
  const b = new StreamBatcher<Row[]>([], { sink: () => commits++ })
  b.update(cur => cur)
  await sleep(30)
  check('identity update schedules nothing', commits === 0)
  b.update(cur => [...cur, { index: 0, unparsedToolInput: '' }])
  b.reset([])
  check('reset flushes immediately and empties the value', b.current.length === 0 && commits >= 1)
  const before = commits
  b.update(cur => [...cur, { index: 1, unparsedToolInput: '' }])
  b.dispose()
  const wasFlushedAtDispose = commits
  await sleep(30)
  check('dispose kills the pending trailing flush', commits === wasFlushedAtDispose && commits >= before)
}

{
  const repl = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
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
