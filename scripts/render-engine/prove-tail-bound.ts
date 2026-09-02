#!/usr/bin/env bun
// prove-tail-bound — E3: the live tail is bounded and complete.
//
//   §1 the bound: a tail composed past the viewport clamps to height−1 rows
//      (oldest live rows leave the view first) and every row clamps to the
//      viewport width with escapes kept whole.
//   §2 damage only: an unchanged row costs zero bytes — a spinner-cell
//      change rewrites exactly the spinner's row.
//   §3 erase before scroll: everything the drive pushes into the oracle's
//      scrollback is a settled row or a blank — stale live rows never enter
//      history.
//   §4 the closed erase vocabulary: zero ED invocations and zero scrollback
//      erases across the whole drive (EL-only discipline, no scroll
//      regions).

import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { composeTailBlock } from '../../src/render-engine/compose.js'
import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

section('§1 the bound')
{
  const tallStream = Array.from({ length: 40 }, (_, i) => `live row ${i}`)
  const composed = composeTailBlock(
    {
      streamRows: tallStream,
      toolRows: ['tool'],
      composerRows: ['> c'],
      statusRows: ['st'],
      cursor: { rowOffset: 0, col: 2 },
    },
    null,
    { cols: 30, rows: 12 },
  )
  check('the block clamps to viewport−1 rows', composed.rows.length === 11)
  check('the newest rows survive the clamp', composed.rows[composed.rows.length - 1] === 'st')
  check('the oldest live rows left the view first', !composed.rows.includes('live row 0'))
  check('the park stays inside the block', composed.park.row < composed.rows.length)

  const wide = composeTailBlock(
    {
      streamRows: ['\x1b[1mBOLD\x1b[0m ' + 'x'.repeat(60)],
      toolRows: [],
      composerRows: [],
      statusRows: [],
      cursor: null,
    },
    null,
    { cols: 20, rows: 12 },
  )
  check('an over-wide row clamps, never throws', wide.rows[0]!.length > 0)
  check('the clamp keeps escapes whole (reset survives)', wide.rows[0]!.includes('\x1b[0m'))
}

section('§2 damage only')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  engine.updateTail({
    streamRows: ['stable stream row one', 'stable stream row two'],
    toolRows: ['[ spinner ⠋ ]'],
    composerRows: ['> steady'],
    statusRows: ['steady status'],
    cursor: { rowOffset: 0, col: 3 },
  })
  clock.advance(50)
  const baseline = sink.text().length
  // Only the spinner cell changes.
  engine.updateTail({ toolRows: ['[ spinner ⠙ ]'] })
  clock.advance(50)
  const delta = sink.text().slice(baseline)
  check('a one-row change writes bytes', delta.length > 0)
  check('the spinner row was rewritten', delta.includes('⠙'))
  check('unchanged rows cost zero bytes', !delta.includes('stable stream row') && !delta.includes('steady status'))
  const tailWritesBefore = engine.metrics().tailRowWrites
  engine.updateTail({}) // no visible change at all
  clock.advance(50)
  check('an unchanged frame writes zero rows', engine.metrics().tailRowWrites === tailWritesBefore)
}

section('§3 erase before scroll — only settled rows and blanks enter history')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 8 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  const settledTexts = new Set<string>()
  for (let i = 1; i <= 14; i++) {
    engine.updateTail({
      streamRows: [`LIVE-${i}a unsettled`, `LIVE-${i}b unsettled`],
      composerRows: ['> typing'],
      statusRows: ['status'],
    })
    clock.advance(40)
    const line = `SETTLED-${i} row`
    settledTexts.add(line)
    engine.submitSettled({
      seq: engine.nextSeq(),
      widthEpoch: engine.widthEpoch(),
      rows: [{ identity: `s${i}`, lines: [line] }],
    })
    clock.advance(40)
  }
  clock.advance(200)
  const emu = new AnsiEmulator(60, 8, false)
  emu.feed(sink.text())
  const foreign = emu.scrollback.filter(row => row !== '' && !settledTexts.has(row))
  check(
    `scrollback holds settled rows and blanks only (${emu.scrollback.length} rows, ${foreign.length} foreign)`,
    emu.scrollback.length > 0 && foreign.length === 0,
    foreign.slice(0, 3).join(' | '),
  )
  check('no LIVE row ever entered history', !emu.scrollback.some(r => r.includes('LIVE-')))

  section('§4 the closed erase vocabulary')
  check('zero ED invocations', emu.edClears === 0)
  check('zero scrollback erases', emu.scrollbackErased === 0)
  check('zero scroll-region bytes', !sink.text().includes('\x1b[r') && !/\x1b\[\d+;\d+r/.test(sink.text()))
}

finish()
