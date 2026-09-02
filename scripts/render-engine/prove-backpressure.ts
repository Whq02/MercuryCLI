#!/usr/bin/env bun

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
    chokeHighWaterBytes: 64,
  })

  sink.mode = { kind: 'refuse' }
  engine.updateTail({
    streamRows: ['first frame with plenty of bytes to owe — padded well past the tiny high water mark'],
    statusRows: ['status row with some weight'],
  })
  clock.advance(50)
  const owedAfterFirst = engine.doorRef().owedBytes()
  check('the first frame is owed (choke armed)', owedAfterFirst > 64)

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
