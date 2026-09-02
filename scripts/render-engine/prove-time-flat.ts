#!/usr/bin/env bun
// prove-time-flat — E11: time does not degrade the engine.
//
//   §1 per-frame COMPOSE COST is a function of the live tail, not of
//      session length: an identical tail burst over a 200-row ledger and a
//      20,000-row ledger writes the same frame bytes and touches the same
//      row counts.
//   §2 no per-row residue: settled rows hold no timers — the engine's timer
//      population after a long settle drive equals the idle population.
//   §3 settled truth is bytes, not subscriptions: painting N thousand rows
//      leaves the paint path reading only rows past the emitted mark (the
//      per-frame settled scan is O(new rows), shown by a constant frame
//      byte-size across session ages).

import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

function drive(sessionRows: number): {
  frameBytes: number
  tailWrites: number
  timersLeft: number
  clock: FakeClock
} {
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  // Age the session: settle rows in batches of 50 (cheap on the fake clock).
  let seq = 0
  for (let i = 0; i < sessionRows; i += 50) {
    const rows = []
    for (let j = i; j < Math.min(i + 50, sessionRows); j++) {
      rows.push({ identity: `row-${j}`, lines: [`settled row ${j}`] })
    }
    engine.submitSettled({ seq: ++seq, widthEpoch: engine.widthEpoch(), rows })
    clock.advance(20)
  }
  clock.advance(500)

  // The measured burst: identical tail activity regardless of age.
  const before = sink.stream().length
  const writesBefore = engine.metrics().tailRowWrites
  for (let i = 0; i < 30; i++) {
    engine.updateTail({
      streamRows: ['stream body line one', `stream body line ${i}`],
      toolRows: [`[ tool ⠋ ${i} ]`],
      composerRows: ['> steady input'],
      statusRows: ['status strip'],
      cursor: { rowOffset: 0, col: 2 },
    })
    clock.advance(20)
  }
  clock.advance(200)
  return {
    frameBytes: sink.stream().length - before,
    tailWrites: engine.metrics().tailRowWrites - writesBefore,
    timersLeft: clock.pendingTimers(),
    clock,
  }
}

section('§1 + §3 compose cost independent of session age')
{
  const young = drive(200)
  const old = drive(20_000)
  check(
    `identical tail burst writes identical bytes (young ${young.frameBytes}, old ${old.frameBytes})`,
    young.frameBytes === old.frameBytes && young.frameBytes > 0,
  )
  check(
    `identical row-write counts (young ${young.tailWrites}, old ${old.tailWrites})`,
    young.tailWrites === old.tailWrites,
  )

  section('§2 no per-row residue')
  check(
    `timer population is flat across 100× session age (young ${young.timersLeft}, old ${old.timersLeft})`,
    young.timersLeft === old.timersLeft && old.timersLeft <= 1,
  )
}

finish()
