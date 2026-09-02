#!/usr/bin/env bun
// prove-backpressure — E6: never compose for a choked terminal.
//
//   §1 the choke gate: while the door owes more than the high water, the
//      engine does not COMPOSE at all — compose count stays flat while the
//      demand survives as a pending intent.
//   §2 fresh, not stale: the frame composed after the drain reflects the
//      LATEST model state — intermediate updates made during the choke never
//      become frames of their own (fewer, fresher frames).
//   §3 the retry is bounded and the queue cannot compound: owed bytes stay
//      at one frame above the high water, never a growing backlog.

import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

section('§1 + §2 + §3 the choked drive')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
    chokeHighWaterBytes: 64, // a tiny bound so the fixture chokes instantly
  })

  // Refuse all drain FIRST: the first frame composes (nothing owed yet) and
  // its bytes stay owed — the choke arms.
  sink.mode = { kind: 'refuse' }
  engine.updateTail({
    streamRows: ['first frame with plenty of bytes to owe — padded well past the tiny high water mark'],
    statusRows: ['status row with some weight'],
  })
  clock.advance(50)
  const owedAfterFirst = engine.doorRef().owedBytes()
  check('the first frame is owed (choke armed)', owedAfterFirst > 64)

  // Twenty updates while choked: composition must not run for any of them.
  const composedBefore = engine.metrics().framesComposed
  for (let i = 0; i < 20; i++) {
    engine.updateTail({ streamRows: [`update ${i} while choked`], statusRows: ['s'] })
    clock.advance(30)
  }
  const composedDuring = engine.metrics().framesComposed - composedBefore
  check(`zero frames composed while choked (${composedDuring})`, composedDuring === 0)
  check('the deferral was counted', engine.metrics().framesDeferredByChoke > 0)
  check(
    'owed bytes never compound past one frame',
    engine.doorRef().owedBytes() === owedAfterFirst,
  )

  // Drain opens: exactly ONE fresh frame lands, showing the LATEST update.
  sink.mode = { kind: 'accept-all' }
  clock.advance(100)
  const composedAfter = engine.metrics().framesComposed - composedBefore
  check(`exactly one fresh frame after the drain (${composedAfter})`, composedAfter === 1)
  const text = sink.text()
  check('the fresh frame shows the LATEST state', text.includes('update 19 while choked'))
  let staleFrames = 0
  for (let i = 0; i < 19; i++) if (text.includes(`update ${i} while choked`)) staleFrames++
  check(`no intermediate update became a frame (${staleFrames} stale)`, staleFrames === 0)
  check('owed drained to zero', engine.doorRef().owedBytes() === 0)
}

finish()
