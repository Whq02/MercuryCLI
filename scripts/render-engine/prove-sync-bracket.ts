#!/usr/bin/env bun
// prove-sync-bracket — spec 03 (synchronized output), probed once.
//
//   §1 probe-once outcomes: a DECRPM reply saying set/reset arms; saying
//      "not recognized" leaves off; silence past the budget leaves off; a
//      withheld probe (Apple-Terminal class) sends ZERO probe bytes.
//   §2 armed wrapping: every frame unit is bracketed begin→end, never
//      nested, never left open; count(begin) == count(end) == frame count;
//      zero unbracketed writes between frames.
//   §3 refused wrapping: zero 2026 bytes in the whole stream.
//   §4 teardown closes: the restore unit carries one extra end so a killed
//      paint cannot leave the terminal frozen.

import { BSU, ESU } from '../../src/ink/termio/dec.js'
import { probeProfile, APPLE_TERMINAL_CLASS_POLICY, MODERN_PROBE_POLICY, SYNC_PROBE } from '../../src/render-engine/capabilities.js'
import { WriteDoor } from '../../src/render-engine/door.js'
import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

section('§1 probe-once outcomes')
{
  // Supported (set): arms.
  {
    const clock = new FakeClock()
    const sink = new SpySink()
    const door = new WriteDoor(sink, clock)
    let feed: ((chunk: string) => void) | null = null
    const p = probeProfile(door, MODERN_PROBE_POLICY, l => ((feed = l), () => (feed = null)), clock)
    clock.advance(1)
    feed!('\x1b[?2026;2$y')
    const profile = await p
    check('a supporting reply arms', profile.syncOutput === true)
    check('the probe was sent once', count(sink.text(), SYNC_PROBE) === 1)
  }
  // Not recognized (0): off.
  {
    const clock = new FakeClock()
    const sink = new SpySink()
    const door = new WriteDoor(sink, clock)
    let feed: ((chunk: string) => void) | null = null
    const p = probeProfile(door, MODERN_PROBE_POLICY, l => ((feed = l), () => (feed = null)), clock)
    clock.advance(1)
    feed!('\x1b[?2026;0$y')
    check('a not-recognized reply leaves off', (await p).syncOutput === false)
  }
  // Silence: off at budget.
  {
    const clock = new FakeClock()
    const sink = new SpySink()
    const door = new WriteDoor(sink, clock)
    const p = probeProfile(door, MODERN_PROBE_POLICY, () => () => {}, clock)
    clock.advance(MODERN_PROBE_POLICY.budgetMs + 10)
    const profile = await p
    check('silence past the budget leaves off', profile.syncOutput === false)
    check('the silent path still sent exactly one probe', count(sink.text(), SYNC_PROBE) === 1)
  }
  // Withheld (Apple class): zero probe bytes.
  {
    const clock = new FakeClock()
    const sink = new SpySink()
    const door = new WriteDoor(sink, clock)
    const profile = await probeProfile(door, APPLE_TERMINAL_CLASS_POLICY, () => () => {}, clock)
    check('the Apple class never probes', profile.syncOutput === false && sink.text() === '')
  }
}

section('§2 armed wrapping — every frame bracketed, never nested, never open')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: true, syncWhy: 'fixture armed' },
    clock,
  })
  for (let i = 1; i <= 8; i++) {
    engine.updateTail({ streamRows: [`row v${i}`], statusRows: ['s'] })
    clock.advance(40)
    if (i % 3 === 0) {
      engine.submitSettled({
        seq: engine.nextSeq(),
        widthEpoch: engine.widthEpoch(),
        rows: [{ identity: `s${i}`, lines: [`settled ${i}`] }],
      })
      clock.advance(40)
    }
  }
  clock.advance(300)
  const text = sink.text()
  const begins = count(text, BSU)
  const ends = count(text, ESU)
  const frames = engine.metrics().framesComposed
  const emitted = engine.metrics().bracketsOpened
  check(`count(begin) == count(end) (${begins}==${ends})`, begins === ends && begins > 0)
  check(
    `every EMITTED frame is bracketed (${begins} brackets, ${emitted} emitting frames of ${frames} composed)`,
    begins === emitted && emitted <= frames,
  )
  // Never nested, never left open, and nothing lives outside a bracket
  // except brackets themselves: walk the stream.
  let depth = 0
  let nested = false
  let outside = 0
  let i = 0
  while (i < text.length) {
    if (text.startsWith(BSU, i)) {
      depth++
      if (depth > 1) nested = true
      i += BSU.length
      continue
    }
    if (text.startsWith(ESU, i)) {
      depth--
      i += ESU.length
      continue
    }
    if (depth === 0) outside++
    i++
  }
  check('never nested', !nested)
  check('never left open', depth === 0)
  check('zero bytes outside brackets between frames', outside === 0)
}

section('§3 refused wrapping — zero 2026 bytes ever')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: false, syncWhy: 'fixture refused' },
    clock,
  })
  engine.updateTail({ streamRows: ['hello'], statusRows: ['s'] })
  clock.advance(50)
  engine.submitSettled({
    seq: engine.nextSeq(),
    widthEpoch: engine.widthEpoch(),
    rows: [{ identity: 's', lines: ['settled'] }],
  })
  clock.advance(200)
  engine.detach()
  check('zero 2026 sequences in the whole stream', !sink.text().includes('2026'))
}

section('§4 teardown closes a bracket a crash left open')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: true, syncWhy: 'fixture armed' },
    clock,
  })
  engine.updateTail({ streamRows: ['x'], statusRows: ['s'] })
  clock.advance(50)
  engine.detach()
  const text = sink.text()
  check('the stream ends with a closing end (teardown emits one extra)', text.endsWith(ESU))
  check('ends ≥ begins after teardown', count(text, ESU) >= count(text, BSU))
}

finish()
