#!/usr/bin/env bun
// prove-ledger-law — E1 (settlement is an application decision) and E2
// (settled rows are written once) at the ledger seam.
//
//   §1 append-once + monotonic acceptance: novel batches append frozen rows;
//      a seq at/below the high-water mark acknowledges WITHOUT effect.
//   §2 immutability: accepted rows are frozen objects; the settled list is
//      a copy — no caller can reach in and rewrite history.
//   §3 identity flatness edge: a fresh-seq batch repeating a settled
//      identity drops the copy, counts it, and fires the fixture hook.
//   §4 nothing else settles: time passing, viewport pressure and paint
//      traffic leave the ledger untouched — only submit() moves it.
//   §5 width epochs: advanceWidth (preserve) keeps rows/identities/mark and
//      stales in-flight batches; beginWidthEpoch (rebuild replay) resets the
//      mark and reissues from one.

import { SettledRowLedger } from '../../src/render-engine/ledger.js'
import { check, finish, section } from './harness.js'

section('§1 append-once + monotonic acceptance (E1/E2)')
{
  const ledger = new SettledRowLedger(80)
  const b1 = {
    seq: 1,
    widthEpoch: 1,
    rows: [
      { identity: 'a', lines: ['row a'] },
      { identity: 'b', lines: ['row b'] },
    ],
  }
  const ack1 = ledger.submit(b1)
  check('novel batch accepted', ack1.kind === 'accepted' && ack1.novelRows === 2)
  check('rows appended in order', ledger.settledRows().map(r => r.identity).join(',') === 'a,b')
  const ack1again = ledger.submit(b1)
  check('same seq resubmission acknowledges WITHOUT effect', ack1again.kind === 'repeat')
  check('resubmission appended nothing', ledger.size() === 2)
  const ackBelow = ledger.submit({ seq: 0, widthEpoch: 1, rows: [{ identity: 'z', lines: ['x'] }] })
  check('seq below the mark acknowledges WITHOUT effect', ackBelow.kind === 'repeat')
  check('below-mark rows never land', !ledger.has('z'))
  check('mark advanced to 1, next seq 2', ledger.acceptedMark() === 1 && ledger.nextSeq() === 2)
}

section('§2 frozen rows')
{
  const ledger = new SettledRowLedger(80)
  ledger.submit({ seq: 1, widthEpoch: 1, rows: [{ identity: 'a', lines: ['row a'] }] })
  const row = ledger.settledRows()[0]!
  let threwOnRowMutation = false
  try {
    ;(row as { identity: string }).identity = 'hacked'
  } catch {
    threwOnRowMutation = true
  }
  let threwOnLineMutation = false
  try {
    ;(row.lines as string[]).push('smuggled')
  } catch {
    threwOnLineMutation = true
  }
  check('row object is frozen', threwOnRowMutation && ledger.settledRows()[0]!.identity === 'a')
  check('line list is frozen', threwOnLineMutation && ledger.settledRows()[0]!.lines.length === 1)
  const copy = ledger.settledRows() as unknown as { identity: string }[]
  copy.pop()
  check('settled list is a copy — history unreachable', ledger.size() === 1)
}

section('§3 identity flatness edge (E10 at the ledger)')
{
  let hookFired = 0
  const ledger = new SettledRowLedger(80, { onFlatnessViolation: () => hookFired++ })
  ledger.submit({ seq: 1, widthEpoch: 1, rows: [{ identity: 'a', lines: ['first'] }] })
  const ack = ledger.submit({
    seq: 2,
    widthEpoch: 1,
    rows: [
      { identity: 'a', lines: ['copy'] },
      { identity: 'b', lines: ['novel'] },
    ],
  })
  check('fresh-seq batch accepted for its novel rows', ack.kind === 'accepted' && ack.novelRows === 1)
  check('the identity copy was dropped', ledger.size() === 2 && ledger.settledRows()[0]!.lines[0] === 'first')
  check('the drop was counted', ledger.flatnessDrops() === 1)
  check('the fixture hook fired loudly', hookFired === 1)
}

section('§4 nothing else settles (E1)')
{
  const ledger = new SettledRowLedger(80)
  // Paint traffic, time, and pressure have no ledger verbs at all — the only
  // mutators are submit/advanceWidth/beginWidthEpoch. Read every probe port
  // and confirm zero movement.
  const before = { size: ledger.size(), mark: ledger.acceptedMark(), epoch: ledger.widthEpoch() }
  ledger.settledRows()
  ledger.has('anything')
  ledger.rowAt(0)
  ledger.nextSeq()
  check(
    'reads move nothing',
    ledger.size() === before.size &&
      ledger.acceptedMark() === before.mark &&
      ledger.widthEpoch() === before.epoch,
  )
}

section('§5 width epochs (E7 at the ledger)')
{
  const ledger = new SettledRowLedger(80)
  ledger.submit({ seq: 1, widthEpoch: 1, rows: [{ identity: 'a', lines: ['a@80'] }] })

  // preserve: epoch bumps, truth survives.
  const e2 = ledger.advanceWidth(100)
  check('advanceWidth bumps the epoch', e2 === 2 && ledger.widthEpoch() === 2)
  check('advanceWidth keeps rows + mark', ledger.size() === 1 && ledger.acceptedMark() === 1)
  const stale = ledger.submit({ seq: 2, widthEpoch: 1, rows: [{ identity: 'b', lines: ['b@80'] }] })
  check('an old-epoch in-flight batch is acknowledged stale', stale.kind === 'stale-epoch')
  check('stale batch landed nothing', !ledger.has('b'))
  const rerendered = ledger.submit({ seq: 2, widthEpoch: 2, rows: [{ identity: 'b', lines: ['b @ 100'] }] })
  check('the re-rendered batch lands in the new epoch', rerendered.kind === 'accepted')
  const dupeAcross = ledger.submit({ seq: 3, widthEpoch: 2, rows: [{ identity: 'a', lines: ['a again'] }] })
  check(
    'identities survive advanceWidth — a late duplicate still deduplicates',
    dupeAcross.kind === 'accepted' && dupeAcross.novelRows === 0 && ledger.size() === 2,
  )

  // rebuild: the replay resets the mark and reissues from one.
  const e3 = ledger.beginWidthEpoch(60)
  check('beginWidthEpoch resets the accepted mark', e3 === 3 && ledger.acceptedMark() === 0 && ledger.nextSeq() === 1)
  check('rebuild clears rows for the replay', ledger.size() === 0)
  const replay = ledger.submit({ seq: 1, widthEpoch: 3, rows: [{ identity: 'a', lines: ['a@60'] }] })
  check('the replay resubmits the same identities freshly', replay.kind === 'accepted' && ledger.size() === 1)
}

finish()
