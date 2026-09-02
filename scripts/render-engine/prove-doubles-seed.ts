#!/usr/bin/env bun
// prove-doubles-seed — the doubled-reply class, killed at the engine seam.
//
//  The OpenAI-family wire shape re-presents EVERY prior round on EVERY
//  request with fresh wire ids — the exact shape behind sheet bug #1 (the
//  same reply painted ×2…×6, worsening with session length). This fixture
//  drives that shape through the engine's dialect seam for N rounds and
//  takes a physical paint census on the replay oracle:
//
//   §1 the folded drive: re-presentations refold by foldKey; each settled
//      row's text occurs EXACTLY ONCE across screen+scrollback at every
//      round index (the constant-1 curve), the raw stream writes each
//      settled row's bytes exactly once, retries ack 'repeat' without
//      painting, and the E10 agreement assertion stays silent throughout.
//   §2 the harness bites: an UNFOLDED control (fresh record identity per
//      re-presentation — the defective shape) drives the same census past 1,
//      so a silent regression of the fold cannot pass this file.
//   §3 a poisoned direct submit (same identity, fresh seq) drops the copy,
//      fires the fixture hook, and leaves the census at 1.
//
//  The migration lane wires the real dialect layer to exactly this seam:
//  fold first (RecordIngestion.ingest by durable foldKey), settle record
//  rows once, and the constant-1 curve is yours by construction.

import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import { RenderEngine } from '../../src/render-engine/engine.js'
import {
  RecordIngestion,
  assertProjectionAgreement,
  project,
  type UnsettledTurn,
} from '../../src/render-engine/projection.js'
import { check, FakeClock, finish, section, SpySink } from './harness.js'

const ROUNDS = 12

function countOccurrences(haystack: string[], needle: string): number {
  let n = 0
  for (const line of haystack) {
    let at = line.indexOf(needle)
    while (at !== -1) {
      n++
      at = line.indexOf(needle, at + needle.length)
    }
  }
  return n
}

section('§1 the folded drive: constant-1 paint census over the wire-replay shape')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  let violations = 0
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
    onFlatnessViolation: () => violations++,
  })
  const ingestion = new RecordIngestion()
  const settledTexts: string[] = []
  let curveHolds = true
  let agreementSilent = true
  let repeatsPainted = 0
  let lastBatch: { seq: number; widthEpoch: number; rows: { identity: string; lines: string[] }[] } | null =
    null

  for (let round = 1; round <= ROUNDS; round++) {
    // The wire presents rounds 1..round, each with a FRESH wire id.
    for (let r = 1; r <= round; r++) {
      const { row, outcome } = ingestion.ingest({
        foldKey: `round${r}/assistant/0`,
        wireId: `wire-${round}-${r}-${Math.random().toString(36).slice(2)}`,
        text: `SETLD-${r} the reply of round ${r}`,
      })
      if (outcome === 'recorded') {
        // A genuinely new record row settles once.
        const batch = {
          seq: engine.nextSeq(),
          widthEpoch: engine.widthEpoch(),
          rows: [{ identity: row.identity, lines: [row.text, ''] }],
        }
        const ack = engine.submitSettled(batch)
        if (ack.kind !== 'accepted') curveHolds = false
        settledTexts.push(`SETLD-${r} `) // delimited — SETLD-1 must not match SETLD-10
        lastBatch = batch
      }
    }
    // The retry/coalesce path: the previous batch resubmitted verbatim.
    if (lastBatch) {
      const framesBefore = engine.metrics().framesComposed
      const ack = engine.submitSettled(lastBatch)
      if (ack.kind !== 'repeat') curveHolds = false
      clock.advance(50)
      // A repeat schedules nothing; frames may still advance for tail work,
      // so assert at the ledger: no new settled rows appeared.
      if (engine.ledgerRef().size() !== settledTexts.length) repeatsPainted++
      void framesBefore
    }
    // Live tail between rounds, distinct vocabulary from settled texts.
    const live: UnsettledTurn = { identity: `live-${round}`, text: `tail-${round}` }
    engine.updateTail({ streamRows: [`tail-${round} composing`], statusRows: ['status'] })
    clock.advance(40)
    try {
      assertProjectionAgreement(project(ingestion.record(), live), engine.ledgerRef(), live)
    } catch {
      agreementSilent = false
    }
    clock.advance(200)

    // The census at THIS round index: every settled text occurs exactly once.
    const emu = new AnsiEmulator(80, 24, false)
    emu.feed(sink.text())
    const everywhere = [...emu.scrollback, ...emu.lines()]
    for (const text of settledTexts) {
      if (countOccurrences(everywhere, text) !== 1) {
        curveHolds = false
        console.log(`    round ${round}: ${text} occurs ${countOccurrences(everywhere, text)}×`)
      }
    }
  }

  check(`occurrences-per-row curve is CONSTANT 1 across all ${ROUNDS} round indices`, curveHolds)
  check('every settled row settled exactly once at the ledger', engine.ledgerRef().size() === ROUNDS)
  check('retries acknowledged without settling', repeatsPainted === 0)
  check('the E10 agreement assertion stayed silent all drive', agreementSilent)
  check('no flatness drops were needed on the folded path', violations === 0)
  // Raw-stream print-once: each settled marker written exactly once ever.
  const raw = sink.text()
  let rawOnce = true
  for (const text of settledTexts) {
    const n = raw.split(text).length - 1
    if (n !== 1) {
      rawOnce = false
      console.log(`    raw stream writes ${text} ${n}×`)
    }
  }
  check('the raw stream writes each settled row exactly once (print-once)', rawOnce)
}

section('§2 the harness bites: the unfolded control shows the rising curve')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
  })
  // The DEFECTIVE shape: every re-presentation mints a fresh record identity
  // (no fold) — exactly what the uuid-keyed append guard cannot stop.
  let mint = 0
  for (let round = 1; round <= 4; round++) {
    for (let r = 1; r <= round; r++) {
      engine.submitSettled({
        seq: engine.nextSeq(),
        widthEpoch: engine.widthEpoch(),
        rows: [{ identity: `unfolded-${++mint}`, lines: [`CTRL-${r} control text ${r}`, ''] }],
      })
    }
    clock.advance(250)
  }
  const emu = new AnsiEmulator(80, 24, false)
  emu.feed(sink.text())
  const everywhere = [...emu.scrollback, ...emu.lines()]
  const n1 = countOccurrences(everywhere, 'CTRL-1 ')
  check(`the census DETECTS the defect (CTRL-1 painted ${n1}× > 1)`, n1 > 1)
}

section('§3 a poisoned duplicate submit cannot reach the screen twice')
{
  const clock = new FakeClock()
  const sink = new SpySink()
  let violations = 0
  const engine = new RenderEngine({
    syscalls: sink,
    viewport: { cols: 80, rows: 24 },
    profile: { syncOutput: false, syncWhy: 'fixture' },
    clock,
    onFlatnessViolation: () => violations++,
  })
  engine.submitSettled({
    seq: engine.nextSeq(),
    widthEpoch: engine.widthEpoch(),
    rows: [{ identity: 'poisoned', lines: ['POISN once only', ''] }],
  })
  clock.advance(100)
  engine.submitSettled({
    seq: engine.nextSeq(),
    widthEpoch: engine.widthEpoch(),
    rows: [{ identity: 'poisoned', lines: ['POISN once only', ''] }],
  })
  clock.advance(300)
  const emu = new AnsiEmulator(80, 24, false)
  emu.feed(sink.text())
  const everywhere = [...emu.scrollback, ...emu.lines()]
  check('the copy was dropped loudly', violations === 1)
  check('the screen holds the row once', countOccurrences(everywhere, 'POISN') === 1)
  check('the metric recorded the drop', engine.metrics().flatnessViolationsDropped === 1)
}

finish()
