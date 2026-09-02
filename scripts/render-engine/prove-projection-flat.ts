#!/usr/bin/env bun
// prove-projection-flat — E10: the transcript is a projection, and it is flat.
//
//   §1 purity: project() is a pure function of (record, live) — same inputs,
//      same output; no hidden state.
//   §2 the flatness assertion bites: a poisoned projection (duplicate
//      identity) throws FlatnessViolation; a lawful one stays silent.
//   §3 agreement: projection == settled ledger + live tail exactly; a drift
//      on either side throws.
//   §4 the record-ingestion fold: wire re-presentations with FRESH wire ids
//      refold onto the EXISTING record row by foldKey — replay bookkeeping
//      never mints renderables (the seam the migration lane wires the real
//      dialect layer to).

import {
  FlatnessViolation,
  RecordIngestion,
  assertFlat,
  assertProjectionAgreement,
  project,
} from '../../src/render-engine/projection.js'
import { SettledRowLedger } from '../../src/render-engine/ledger.js'
import { check, finish, section } from './harness.js'

section('§1 purity')
{
  const record = {
    rows: [
      { identity: 'r1', foldKey: 'k1', text: 'one' },
      { identity: 'r2', foldKey: 'k2', text: 'two' },
    ],
  }
  const live = { identity: 'live-1', text: 'streaming…' }
  const a = project(record, live)
  const b = project(record, live)
  check('same inputs, same identities', a.identities.join('|') === b.identities.join('|'))
  check('order is record order then live', a.identities.join('|') === 'r1|r2|live-1')
  check('null live projects the record alone', project(record, null).identities.length === 2)
}

section('§2 the flatness assertion bites')
{
  let threw = false
  try {
    assertFlat({ identities: ['a', 'b', 'a'] })
  } catch (e) {
    threw = e instanceof FlatnessViolation
  }
  check('duplicate identity throws FlatnessViolation', threw)
  let silent = true
  try {
    assertFlat({ identities: ['a', 'b', 'c'] })
  } catch {
    silent = false
  }
  check('a lawful projection stays silent', silent)
}

section('§3 projection/ledger agreement')
{
  const ledger = new SettledRowLedger(80)
  ledger.submit({
    seq: 1,
    widthEpoch: 1,
    rows: [
      { identity: 'r1', lines: ['one'] },
      { identity: 'r2', lines: ['two'] },
    ],
  })
  const record = {
    rows: [
      { identity: 'r1', foldKey: 'k1', text: 'one' },
      { identity: 'r2', foldKey: 'k2', text: 'two' },
    ],
  }
  const live = { identity: 'live-1', text: 'streaming…' }
  let agreed = true
  try {
    assertProjectionAgreement(project(record, live), ledger, live)
  } catch {
    agreed = false
  }
  check('lawful state agrees silently', agreed)

  let caughtExtra = false
  try {
    assertProjectionAgreement(
      project({ rows: [...record.rows, { identity: 'r3', foldKey: 'k3', text: 'ghost' }] }, live),
      ledger,
      live,
    )
  } catch (e) {
    caughtExtra = e instanceof FlatnessViolation
  }
  check('a renderable the ledger does not hold throws', caughtExtra)

  let caughtMissing = false
  try {
    assertProjectionAgreement(project({ rows: record.rows.slice(0, 1) }, live), ledger, live)
  } catch (e) {
    caughtMissing = e instanceof FlatnessViolation
  }
  check('a settled row missing from the projection throws', caughtMissing)
}

section('§4 the record-ingestion fold (the dialect seam)')
{
  const ingestion = new RecordIngestion()
  // Round 1: the wire presents one assistant row.
  const p1 = ingestion.ingest({ foldKey: 'round1/assistant/0', wireId: 'wire-aaa', text: 'answer one' })
  check('a genuinely new presentation records a row', p1.outcome === 'recorded')
  // Round 2: the wire RE-PRESENTS round 1 (fresh id) beside a new row —
  // the OpenAI-family per-request replay shape.
  const p1again = ingestion.ingest({ foldKey: 'round1/assistant/0', wireId: 'wire-bbb', text: 'answer one' })
  const p2 = ingestion.ingest({ foldKey: 'round2/assistant/0', wireId: 'wire-ccc', text: 'answer two' })
  check('the re-presentation refolds onto the EXISTING row', p1again.outcome === 'refolded')
  check('the refold returns the same identity', p1again.row.identity === p1.row.identity)
  check('the new round records', p2.outcome === 'recorded')
  check('the record holds each row once', ingestion.record().rows.length === 2)
  check('refolds are counted', ingestion.refolds() === 1)
  const projection = project(ingestion.record(), null)
  let silent = true
  try {
    assertFlat(projection)
  } catch {
    silent = false
  }
  check('the projection over the folded record is flat', silent && projection.identities.length === 2)
}

finish()
