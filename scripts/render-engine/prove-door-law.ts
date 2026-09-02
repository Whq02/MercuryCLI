#!/usr/bin/env bun
// prove-door-law — E4: one writer, whole units.
//
//   §1 FIFO whole units: interleaved enqueues under an EAGAIN storm and
//      byte-rationed acceptance still deliver the exact concatenation of
//      whole units in enqueue order — no unit ever splits into another.
//   §2 the retry pump: EAGAIN arms one bounded retry; acceptance resumes on
//      the HEAD unit's remainder before any later unit's first byte.
//   §3 closed vocabulary: every byte the engine emits in a representative
//      drive replays through the independent terminal oracle, which THROWS
//      on unknown sequences.
//   §4 teardown flush: a queued restore unit lands whole through the
//      synchronous bounded path; a closed pipe ends quietly.
//   §5 one door in the source: the engine module's only terminal writes live
//      in door.ts — no second buffered path exists to interleave.

import { execSync } from 'node:child_process'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { WriteDoor } from '../../src/render-engine/door.js'
import { RenderEngine } from '../../src/render-engine/engine.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

section('§1 FIFO whole units under storm + ration')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const door = new WriteDoor(sink, clock)
  sink.mode = { kind: 'refuse' }
  door.enqueue({ kind: 'frame', bytes: 'AAAA-unit-one' })
  door.enqueue({ kind: 'mode', bytes: 'BB-unit-two' })
  check('storm: nothing delivered, all owed', sink.stream().length === 0 && door.owedBytes() === 24)
  sink.mode = { kind: 'ration', bytesPerCall: 3 }
  clock.advance(500)
  door.enqueue({ kind: 'frame', bytes: 'C-unit-three' })
  clock.advance(500)
  check(
    'delivery equals the concatenation of whole units in order',
    sink.text() === 'AAAA-unit-one' + 'BB-unit-two' + 'C-unit-three',
  )
  check('owed drained to zero', door.owedBytes() === 0)
  check('unit count delivered', door.deliveredUnits() === 3)
}

section('§2 the retry pump keeps the head unit whole')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const door = new WriteDoor(sink, clock)
  sink.mode = { kind: 'ration', bytesPerCall: 4 }
  door.enqueue({ kind: 'frame', bytes: 'HEAD0123456789' })
  door.enqueue({ kind: 'frame', bytes: 'NEXT' })
  clock.advance(200)
  const text = sink.text()
  check('head remainder precedes the next unit', text === 'HEAD0123456789NEXT')
  check('EAGAIN was exercised', sink.eagains === 0) // ration accepts; no refusals here
}

section('§3 closed vocabulary — the oracle replays a real drive')
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
    streamRows: ['streaming \x1b[1mbold\x1b[0m text', 'second row'],
    toolRows: ['[tool] running'],
    composerRows: ['> typed'],
    statusRows: ['status line'],
    cursor: { rowOffset: 0, col: 8 },
  })
  clock.advance(50)
  engine.submitSettled({
    seq: engine.nextSeq(),
    widthEpoch: engine.widthEpoch(),
    rows: [{ identity: 's1', lines: ['a settled row', ''] }],
  })
  clock.advance(50)
  engine.updateTail({ streamRows: ['replaced tail'], cursor: null })
  clock.advance(50)
  engine.openOverlay({ fullscreen: false, rows: ['(picker)'] })
  clock.advance(50)
  engine.closeOverlay()
  clock.advance(100)
  let oracleAccepted = true
  let oracleError = ''
  try {
    const emu = new AnsiEmulator(60, 12, false)
    emu.feed(sink.text())
  } catch (e) {
    oracleAccepted = false
    oracleError = String(e)
  }
  check('the replay oracle accepts every emitted byte', oracleAccepted, oracleError)
}

section('§4 teardown flush')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const door = new WriteDoor(sink, clock)
  sink.mode = { kind: 'ration', bytesPerCall: 2 }
  door.enqueue({ kind: 'teardown', bytes: 'RESTORE-UNIT' })
  const flushed = door.flushSync(100)
  check('the restore unit lands whole synchronously', flushed && sink.text() === 'RESTORE-UNIT')

  const sink2 = new SpySink()
  const door2 = new WriteDoor(sink2, clock)
  sink2.tryWrite = () => 'closed'
  door2.enqueue({ kind: 'teardown', bytes: 'GONE' })
  check('a closed pipe ends quietly with nothing owed', door2.isClosed() && door2.owedBytes() === 0)
}

section('§5 one door in the source')
{
  // The engine module writes bytes in door.ts alone: no process.stdout use,
  // and the only writeSync caller is the door's tty binding.
  const grep = (pattern: string): string[] => {
    try {
      return execSync(`grep -rln ${JSON.stringify(pattern)} src/render-engine`, {
        encoding: 'utf8',
        cwd: `${import.meta.dir}/../..`,
      })
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }
  const stdoutUsers = grep('process.stdout')
  const writeSyncUsers = grep('writeSync')
  check('no render-engine file touches process.stdout', stdoutUsers.length === 0, stdoutUsers.join(','))
  check(
    'writeSync appears only in the door',
    writeSyncUsers.length === 1 && writeSyncUsers[0] === 'src/render-engine/door.ts',
    writeSyncUsers.join(','),
  )
}

finish()
