#!/usr/bin/env bun
// prove-overlay-law — E8: transient surfaces never touch history.
//
//   §1 a compositing overlay opens and closes during streaming: settled
//      history bytes on the oracle are IDENTICAL before, during and after;
//      closing repaints the tail only.
//   §2 an open/close storm mid-stream leaves history untouched and the tail
//      current.
//   §3 a fullscreen surface borrows the alternate screen: enter/exit mode
//      bytes bracket its lifetime, inline paints pause while borrowed, and
//      the main-screen content + scrollback replay identically with the
//      whole borrow spliced out (what happened on alt never reaches
//      history).

import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../../src/ink/termio/dec.js'
import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

const historyOf = (bytes: string): string[] => {
  const emu = new AnsiEmulator(60, 12, false)
  emu.feed(bytes)
  return emu.scrollback.slice()
}

function freshEngine(): { clock: FakeClock; sink: SpySink; engine: RenderEngine } {
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 60, rows: 12 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  return { clock, sink, engine }
}

function settleRows(engine: RenderEngine, clock: FakeClock, n: number): void {
  for (let i = 1; i <= n; i++) {
    engine.submitSettled({
      seq: engine.nextSeq(),
      widthEpoch: engine.widthEpoch(),
      rows: [{ identity: `h${i}`, lines: [`HIST-${i} settled row`, ''] }],
    })
    clock.advance(60)
  }
}

section('§1 composite over the tail, history identical')
{
  const { clock, sink, engine } = freshEngine()
  engine.updateTail({ streamRows: ['streaming row'], composerRows: ['> input'], statusRows: ['st'] })
  clock.advance(50)
  settleRows(engine, clock, 8) // enough to push rows into scrollback
  const before = historyOf(sink.text())
  check('history exists for the check to bite', before.length > 0)

  engine.openOverlay({ fullscreen: false, rows: ['(picker) choose one', '(picker) row two'] })
  clock.advance(60)
  const during = historyOf(sink.text())
  engine.closeOverlay()
  clock.advance(60)
  const after = historyOf(sink.text())

  check('history identical while the overlay is open', during.join('\n') === before.join('\n'))
  check('history identical after close', after.join('\n') === before.join('\n'))

  const emu = new AnsiEmulator(60, 12, false)
  emu.feed(sink.text())
  const screen = emu.lines().join('\n')
  check('the tail is current after close (overlay gone)', !screen.includes('(picker)'))
  check('the composer row is back', screen.includes('> input'))
}

section('§2 an open/close storm mid-stream')
{
  const { clock, sink, engine } = freshEngine()
  engine.updateTail({ streamRows: ['stream v0'], statusRows: ['st'] })
  clock.advance(50)
  settleRows(engine, clock, 6)
  const before = historyOf(sink.text())
  for (let i = 1; i <= 10; i++) {
    engine.openOverlay({ fullscreen: false, rows: [`(storm ${i})`] })
    engine.updateTail({ streamRows: [`stream v${i}`], statusRows: ['st'] })
    clock.advance(25)
    engine.closeOverlay()
    clock.advance(25)
  }
  clock.advance(100)
  check('history identical through the storm', historyOf(sink.text()).join('\n') === before.join('\n'))
  const emu = new AnsiEmulator(60, 12, false)
  emu.feed(sink.text())
  check('the tail shows the latest stream state', emu.lines().join('\n').includes('stream v10'))
}

section('§3 the fullscreen borrow')
{
  const { clock, sink, engine } = freshEngine()
  engine.updateTail({ streamRows: ['inline tail'], statusRows: ['st'] })
  clock.advance(50)
  settleRows(engine, clock, 6)
  const beforeBytes = sink.text()
  const framesBefore = engine.metrics().framesComposed

  engine.openOverlay({ fullscreen: true, rows: ['FULLSCREEN help', 'second row'] })
  clock.advance(60)
  engine.updateTail({ streamRows: ['inline tail updated under the surface'], statusRows: ['st'] })
  clock.advance(120)
  const framesDuringBorrow = engine.metrics().framesComposed - framesBefore
  check('inline paints pause while borrowed', framesDuringBorrow === 0)

  engine.closeOverlay()
  clock.advance(120)
  const all = sink.text()
  const enterAt = all.indexOf(ENTER_ALT_SCREEN)
  const exitAt = all.indexOf(EXIT_ALT_SCREEN)
  check('the borrow is bracketed by enter/exit alt', enterAt !== -1 && exitAt > enterAt)
  check('the surface painted inside the borrow', all.indexOf('FULLSCREEN help') > enterAt && all.indexOf('FULLSCREEN help') < exitAt)

  // Replay the main screen with the borrow spliced out: history identical to
  // the pre-borrow bytes' history; the post-exit tail repaint continues it.
  const spliced = all.slice(0, enterAt) + all.slice(exitAt + EXIT_ALT_SCREEN.length)
  check(
    'history identical with the whole borrow spliced out',
    historyOf(spliced).join('\n') === historyOf(beforeBytes).join('\n'),
  )
  const emu = new AnsiEmulator(60, 12, false)
  emu.feed(spliced)
  check('the parked update painted after release', emu.lines().join('\n').includes('inline tail updated'))
}

finish()
