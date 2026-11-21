#!/usr/bin/env bun
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
  check('the opening publishes synchronously', commits === 1, `commits ${commits} (expected 1): the first update from an empty tail must publish at once; check update in createStreamingTailStore, src/utils/messages/streamingTailStore.ts`)
  for (let i = 0; i < 100; i++) {
    tail.update(cur => (cur ?? '') + 'x')
    clock += 10
    const due = timer as { at: number; fire: () => void } | null
    if (due && due.at <= clock) due.fire()
  }
  const trailing = timer as { at: number; fire: () => void } | null
  if (trailing) { clock = trailing.at; trailing.fire() }
  check('100 deltas stay within the live tail cadence', commits >= 1 && commits <= 40, `${commits} commits (expected 1 to 40): update in createStreamingTailStore, src/utils/messages/streamingTailStore.ts, must hold deltas inside its interval for one trailing publish`)
  check('fresh and published tails contain every byte', tail.read() === 'x'.repeat(100) && tail.getSnapshot() === tail.read(), `read ${String(tail.read()).length} bytes and snapshot ${String(tail.getSnapshot()).length} bytes (expected 100 each): the trailing publish in src/utils/messages/streamingTailStore.ts must carry the latest text`)
  const before = commits
  tail.update(cur => cur)
  check('identity updates schedule no work', commits === before && timer === null, `commits ${commits} against ${before} before, timer ${timer === null ? 'none' : 'set'}: update in src/utils/messages/streamingTailStore.ts must do nothing when the function returns the current text`)
  tail.update(() => null)
  check('the close publishes immediately and retains the last text', tail.getSnapshot() === null && tail.readSettled() === 'x'.repeat(100) && timer === null, `snapshot ${String(tail.getSnapshot())}, settled length ${String(tail.readSettled()).length} (expected null and 100), timer ${timer === null ? 'none' : 'set'}: update to null in src/utils/messages/streamingTailStore.ts must publish at once, keep the last text for readSettled and clear the timer`)
  tail.update(() => 'next')
  tail.update(cur => cur + ' pending')
  tail.dispose()
  check('dispose cancels the trailing publish', timer === null, 'dispose in src/utils/messages/streamingTailStore.ts must call clearTimer for a pending trailing publish')
  const disposed = commits
  tail.update(() => 'late')
  check('late updates never resurrect the subscriber', commits === disposed, `commits ${commits} against ${disposed} at dispose: update in src/utils/messages/streamingTailStore.ts must return early once disposed`)
}

{
  const { TailPart } = await import('../../src/services/engine-connector/daemon/tail.ts')
  const fed = new TailPart({ sessionId: () => 'throttle', rows: () => [], model: () => 'the-model', paint: () => {} })
  const store = fed.store()
  let publishes = 0
  const unsubscribe = store.subscribe(() => publishes++)
  const clockOfTheStore = Object.getOwnPropertyDescriptor(performance, 'now')
  Object.defineProperty(performance, 'now', { value: () => 1000, configurable: true, writable: true })
  fed.takeTail({ schema: 1, sessionId: 'throttle', atMs: 1, text: 'the words', messageId: 'msg_1' })
  const opening = store.read()
  const publishedAtTheOpening = publishes
  fed.takeTail({ schema: 1, sessionId: 'throttle', atMs: 2, text: 'the words grow', messageId: 'msg_1' })
  const publishedInTheTick = publishes
  if (clockOfTheStore !== undefined) Object.defineProperty(performance, 'now', clockOfTheStore)
  else delete (performance as { now?: unknown }).now
  unsubscribe()
  check(
    'the connector feeds one streaming tail store from the seat tail feed, through its throttle (two feeds in one tick publish once)',
    opening === 'the words' && store.read() === 'the words grow' && fed.store() === store && publishedAtTheOpening === 1 && publishedInTheTick === 1,
    `${String(opening)} · ${String(store.read())} · published ${publishedAtTheOpening} at the opening and ${publishedInTheTick} after the second feed of the same tick (1 and 1): TailPart.takeTail in src/services/engine-connector/daemon/tail.ts feeds the store through update, which holds a second change inside the store's interval for one trailing publish; reset publishes every feed at once`,
  )
}

console.log(fail === 0 ? '\n✅ prove-stream-commit-throttle: ALL PASS' : `\n❌ prove-stream-commit-throttle: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
