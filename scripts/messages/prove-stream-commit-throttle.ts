#!/usr/bin/env bun
import { createStreamingTailStore } from '../../src/engine/message-shapes/streamingTailStore.js'

let fail = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
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
  check('the opening publishes synchronously', commits === 1, '', 'the first update in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must notify subscribers at once')
  for (let i = 0; i < 100; i++) {
    tail.update(cur => (cur ?? '') + 'x')
    clock += 10
    const due = timer as { at: number; fire: () => void } | null
    if (due && due.at <= clock) due.fire()
  }
  const trailing = timer as { at: number; fire: () => void } | null
  if (trailing) { clock = trailing.at; trailing.fire() }
  check('100 deltas stay within the live tail cadence', commits >= 1 && commits <= 40, String(commits), 'update in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must hold changes inside its interval for one trailing publish')
  check('fresh and published tails contain every byte', tail.read() === 'x'.repeat(100) && tail.getSnapshot() === tail.read(), '', 'createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must publish the trailing text so the snapshot equals read() and no delta is lost')
  const before = commits
  tail.update(cur => cur)
  check('identity updates schedule no work', commits === before && timer === null, '', 'update in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must return early when the updater gives back the same value')
  tail.update(() => null)
  check('the close publishes immediately and retains the last text', tail.getSnapshot() === null && tail.readSettled() === 'x'.repeat(100) && timer === null, '', 'update in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must publish a close (null) at once, clear the timer and keep the last text for readSettled')
  tail.update(() => 'next')
  tail.update(cur => cur + ' pending')
  tail.dispose()
  check('dispose cancels the trailing publish', timer === null, '', 'dispose in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must clear the pending timer')
  const disposed = commits
  tail.update(() => 'late')
  check('late updates never resurrect the subscriber', commits === disposed, '', 'update in createStreamingTailStore in src/engine/message-shapes/streamingTailStore.ts must do nothing once dispose has run')
}

{
  const { TailPart } = await import('../../src/engine/connector/daemon/tail.ts')
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
    `${String(opening)} · ${String(store.read())} · published ${publishedAtTheOpening} at the opening and ${publishedInTheTick} after the second feed of the same tick (1 and 1): TailPart.takeTail in src/engine/connector/daemon/tail.ts feeds the store through update, which holds a second change inside the store's interval for one trailing publish; reset publishes every feed at once`,
  )
}

console.log(fail === 0 ? '\n✅ prove-stream-commit-throttle: ALL PASS' : `\n❌ prove-stream-commit-throttle: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
