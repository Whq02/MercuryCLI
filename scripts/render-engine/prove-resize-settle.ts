#!/usr/bin/env bun

import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

section('§1 the storm: zero mid-storm reflows, one settled end')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  engine.updateTail({ streamRows: ['before the storm'], statusRows: ['s'] })
  clock.advance(50)

  const framesBefore = engine.metrics().framesComposed
  const stormStart = clock.now()
  let lastWinchAt = stormStart
  const sizes: [number, number][] = [
    [100, 30],
    [90, 28],
    [84, 26],
    [76, 22],
    [60, 20],
  ]
  for (const [c, r] of sizes) {
    engine.winch(c, r)
    lastWinchAt = clock.now()
    clock.advance(60)
  }
  const framesDuringStorm = engine.metrics().framesComposed - framesBefore
  check(`zero reflows during the storm (${framesDuringStorm})`, framesDuringStorm === 0)
  check('the gate reports one holding mark per storm', engine.metrics().holdingPaints === 1)

  clock.advance(59)
  check('no reflow before the settle window closes (+119ms)', engine.metrics().settledReflows === 0)
  clock.advance(2)
  check('exactly ONE settled reflow at the window edge (+121ms ≤ 300ms)', engine.metrics().settledReflows === 1)
  void lastWinchAt
  clock.advance(200)
  check('quiet stays quiet — still exactly one', engine.metrics().settledReflows === 1)
  const framesAfter = engine.metrics().framesComposed - framesBefore
  check(`exactly one frame for the whole storm (${framesAfter})`, framesAfter === 1)
}

section('§2 nothing lost across the storm')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  engine.updateTail({ streamRows: ['start'], statusRows: ['s'] })
  clock.advance(50)
  engine.winch(70, 20)
  clock.advance(40)
  engine.updateTail({ streamRows: ['start', 'delta-one landed mid-storm'], statusRows: ['s'] })
  engine.winch(64, 18)
  clock.advance(40)
  engine.updateTail({
    streamRows: ['start', 'delta-one landed mid-storm', 'delta-two landed mid-storm'],
    statusRows: ['s'],
  })
  clock.advance(500)
  check('one settled reflow', engine.metrics().settledReflows === 1)
  const text = sink.text()
  check(
    'every mid-storm delta is in the settled frame',
    text.includes('delta-one landed mid-storm') && text.includes('delta-two landed mid-storm'),
  )
}

section('§3 a single isolated resize')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  engine.updateTail({ streamRows: ['content'], statusRows: ['s'] })
  clock.advance(50)
  engine.winch(100, 30)
  clock.advance(119)
  check('quiet window still open at +119ms', engine.metrics().settledReflows === 0)
  clock.advance(2)
  check('one settled reflow at +121ms (≤300ms budget)', engine.metrics().settledReflows === 1)
}

section('§4 the epoch break at the ledger + the settled geometry')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  const epochBefore = engine.widthEpoch()
  const staleBatch = {
    seq: engine.nextSeq(),
    widthEpoch: epochBefore,
    rows: [{ identity: 'in-flight', lines: ['rendered at 80'] }],
  }
  engine.winch(60, 20)
  clock.advance(400)
  check('the epoch advanced at settle', engine.widthEpoch() === epochBefore + 1)
  check('the engine reports the new settle width', engine.settleWidth() === 60)
  const ack = engine.submitSettled(staleBatch)
  check('an in-flight old-width batch comes back stale-epoch', ack.kind === 'stale-epoch')
  const rerendered = engine.submitSettled({
    seq: staleBatch.seq,
    widthEpoch: engine.widthEpoch(),
    rows: [{ identity: 'in-flight', lines: ['rendered at 60'] }],
  })
  check('the re-rendered batch lands', rerendered.kind === 'accepted')
  clock.advance(200)
  check('the re-rendered row painted', sink.text().includes('rendered at 60'))
  check('the old-width render never painted', !sink.text().includes('rendered at 80'))
}

finish()
