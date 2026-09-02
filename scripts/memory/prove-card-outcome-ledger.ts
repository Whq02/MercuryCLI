#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-card-outcome-ledger.ts
//  PROOF: the card-outcome ledger (the adaptive-promotion follow-up —
//  RoutingEntry minus git) end-to-end against the REAL production code, not a
//  reimplementation. writeExperienceCard/promoteExperienceCard are now thin
//  wrappers (src/memdir/experienceCards.ts:recordCardOutcome) that record one
//  row per distill/promote DECISION into the evolution ledger
//  (src/utils/evolution/evolutionLedger.ts), keyed by problemClass, so a
//  future round can read the per-class accept rate instead of re-deriving it.
//
//  Covers:
//   1. accepted distill  → 'accepted' row, mechanism 'distill', evidence = card path
//   2. refused distill (shouldDistill blocks: no green-gate, no operator signal) → 'refused' row
//   3. refused distill (distill-time dedup blocks a near-duplicate) → 'refused' row
//   4. promote → 'accepted' row, mechanism 'promote', subject = problemClass (NOT the slug)
//   5. MERCURY_EVOLUTION_LEDGER=0 → card still writes, but NO evolution/ dir at all
//   6. MERCURY_CARD_PROMOTE_RUNGATE[_CMD] — enable flag + RUN the (stubbed) gate command
//   7. computeSubjectDrift — recent-vs-prior accept-rate arithmetic (pure)
//
//  Under bun-run the build stamp is false (no MACRO); we set globalThis.MACRO
//  to simulate a stamped build so the stamp-gated flags (MERCURY_EVOLUTION_LEDGER,
//  MERCURY_CARD_DEDUP, MERCURY_CARD_PROMOTE_GATE, MERCURY_CARD_PROMOTE_RUNGATE) are live.
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-card-outcome-ledger.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  promoteExperienceCard,
  writeExperienceCard,
  type BuildCardInput,
} from '../../src/memdir/experienceCards.js'
import {
  computeSubjectDrift,
  readEvolutionRows,
  type EvolutionOutcome,
  type EvolutionRow,
} from '../../src/utils/evolution/evolutionLedger.js'
import {
  cardPromoteRungateEnabled,
  promoteRungateCommand,
  runPromoteRungate,
} from '../../src/memdir/promoteRungate.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function clearEnv(): void {
  delete process.env.MERCURY_EVOLUTION_LEDGER
  delete process.env.MERCURY_CARD_DEDUP
  delete process.env.MERCURY_CARD_PROMOTE_GATE
  delete process.env.MERCURY_CARD_SUPERSEDE
  delete process.env.MERCURY_CARD_PROMOTE_RUNGATE
  delete process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD
}
clearEnv()

console.log('============================================================')
console.log(' card-outcome ledger — proof')
console.log('============================================================')

const LEDGER_PROGRAM = 'memdir-cards'

/** A well-formed candidate card input. `scope: 'general'` deliberately avoids
 *  the promote-gate's Applies-when requirement so the happy-path promote in
 *  §4 isn't incidentally refused by an unrelated structural check. */
function cardInput(over: Partial<BuildCardInput>): BuildCardInput {
  return {
    name: 'outcome-a',
    title: 'Outcome ledger demo card',
    summary: 'a demo candidate for the outcome-ledger proof',
    problemClass: 'outcome-ledger-class-a',
    lesson:
      'Record one ledger row per distill/promote decision so a future round can read the per-class accept rate instead of re-deriving it.',
    sourceRefs: ['commit:cafef00d'],
    scope: 'general',
    createdAt: '2026-07-02T00:00:00.000Z',
    greenGate: true,
    ...over,
  }
}

// ── 1. Accepted distill ──────────────────────────────────────────────────
section('1. Accepted distill → one "accepted" row, mechanism "distill"')
const dir1 = mkdtempSync(join(tmpdir(), 'hermes-outcome-ledger-'))
const ledgerDir1 = join(dir1, 'evolution')
let w1path = ''
{
  const w1 = await writeExperienceCard(dir1, cardInput({}))
  check('writeExperienceCard ok', w1.ok === true, JSON.stringify(w1))
  if (w1.ok) w1path = w1.path

  const rows = await readEvolutionRows(ledgerDir1, LEDGER_PROGRAM)
  check('ledger has exactly 1 row after the accepted distill', rows.length === 1, `rows=${rows.length}`)
  check(
    'row is outcome=accepted, mechanism=distill, subject=problemClass',
    rows[0]?.outcome === 'accepted' &&
      rows[0]?.mechanism === 'distill' &&
      rows[0]?.subject === 'outcome-ledger-class-a',
    JSON.stringify(rows[0]),
  )
  check(
    'evidenceRefs[0] === the written card path',
    rows[0]?.evidenceRefs?.[0] === w1path && w1path !== '',
    `${rows[0]?.evidenceRefs?.[0]} vs ${w1path}`,
  )
}

// ── 2. Refused distill (shouldDistill blocks) ────────────────────────────
section('2. Refused distill (shouldDistill blocks: no green-gate, no operator signal) → "refused" row')
{
  const w2 = await writeExperienceCard(
    dir1,
    cardInput({ name: 'outcome-b', problemClass: 'outcome-ledger-class-b' }),
    {
      signal: {
        greenGatePassed: false,
        operatorSignal: false,
        lesson: 'a signal lesson long enough to clear the trivial-length check on its own merit.',
      },
    },
  )
  check(
    'writeExperienceCard blocked "skipped"',
    w2.ok === false && (w2 as { blocked: string }).blocked === 'skipped',
    JSON.stringify(w2),
  )

  const rows = await readEvolutionRows(ledgerDir1, LEDGER_PROGRAM)
  check('ledger has 2 rows now', rows.length === 2, `rows=${rows.length}`)
  check(
    'new row is outcome=refused, mechanism=distill, subject=class-b',
    rows[1]?.outcome === 'refused' &&
      rows[1]?.mechanism === 'distill' &&
      rows[1]?.subject === 'outcome-ledger-class-b',
    JSON.stringify(rows[1]),
  )
}

// ── 3. Refused distill (dedup blocks a near-duplicate) ───────────────────
section('3. Refused distill (distill-time dedup blocks a near-duplicate) → "refused" row')
{
  // Same problemClass + same (normalized) lesson as card #1, different name — the
  // dedup collision. No `signal` here, so shouldDistill is never consulted; this
  // exercises the build→dedup path directly (writeExperienceCardInner).
  const w3 = await writeExperienceCard(dir1, cardInput({ name: 'outcome-a-dup' }))
  check(
    'writeExperienceCard blocked "duplicate"',
    w3.ok === false && (w3 as { blocked: string }).blocked === 'duplicate',
    JSON.stringify(w3),
  )

  const rows = await readEvolutionRows(ledgerDir1, LEDGER_PROGRAM)
  check('ledger has 3 rows now', rows.length === 3, `rows=${rows.length}`)
  check(
    'new row is outcome=refused, mechanism=distill, subject=class-a (the dup shares class-a)',
    rows[2]?.outcome === 'refused' &&
      rows[2]?.mechanism === 'distill' &&
      rows[2]?.subject === 'outcome-ledger-class-a',
    JSON.stringify(rows[2]),
  )
}

// ── 4. Promote ────────────────────────────────────────────────────────────
section('4. Promote → one "accepted" row, mechanism "promote", subject = problemClass (not the slug)')
{
  const p1 = await promoteExperienceCard(dir1, 'outcome-a')
  check('promoteExperienceCard ok', p1.ok === true, JSON.stringify(p1))

  const rows = await readEvolutionRows(ledgerDir1, LEDGER_PROGRAM)
  check('ledger has 4 rows now', rows.length === 4, `rows=${rows.length}`)
  check(
    'new row is outcome=accepted, mechanism=promote, subject=problemClass "outcome-ledger-class-a" (NOT the slug "outcome-a")',
    rows[3]?.outcome === 'accepted' &&
      rows[3]?.mechanism === 'promote' &&
      rows[3]?.subject === 'outcome-ledger-class-a',
    JSON.stringify(rows[3]),
  )
}

// ── 5. Gate-off byte-identity ────────────────────────────────────────────
section('5. MERCURY_EVOLUTION_LEDGER=0 → card still writes, but no evolution/ dir at all')
{
  process.env.MERCURY_EVOLUTION_LEDGER = '0'
  const dir2 = mkdtempSync(join(tmpdir(), 'hermes-outcome-ledger-off-'))
  const w5 = await writeExperienceCard(
    dir2,
    cardInput({ name: 'outcome-off', problemClass: 'outcome-ledger-class-off' }),
  )
  check('card still writes ok with the ledger gated off', w5.ok === true, JSON.stringify(w5))
  check(
    'no evolution/ dir was created at all (byte-identical off — no file touched)',
    !existsSync(join(dir2, 'evolution')),
  )
  delete process.env.MERCURY_EVOLUTION_LEDGER
}

// ── 6. Promote rungate flags ─────────────────────────────────────────────
section('6. MERCURY_CARD_PROMOTE_RUNGATE[_CMD] — enable flag + RUN the (stubbed) gate command')
{
  check('default (unset) ⇒ cardPromoteRungateEnabled() false', cardPromoteRungateEnabled() === false)
  process.env.MERCURY_CARD_PROMOTE_RUNGATE = '1'
  check('MERCURY_CARD_PROMOTE_RUNGATE=1 (stamp-sim ON) ⇒ enabled', cardPromoteRungateEnabled() === true)

  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'exit 0'
  const r0 = runPromoteRungate({ stdio: 'ignore' })
  check('CMD="exit 0" ⇒ pass true, exitCode 0', r0.pass === true && r0.exitCode === 0, `pass=${r0.pass} exitCode=${r0.exitCode}`)

  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'exit 3'
  const r3 = runPromoteRungate({ stdio: 'ignore' })
  check('CMD="exit 3" ⇒ pass false, exitCode 3', r3.pass === false && r3.exitCode === 3, `pass=${r3.pass} exitCode=${r3.exitCode}`)

  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'definitely-not-a-real-cmd-xyz'
  const rMissing = runPromoteRungate({ stdio: 'ignore' })
  check(
    'CMD=nonexistent binary ⇒ pass false (fail-closed, bash "command not found")',
    rMissing.pass === false,
    `pass=${rMissing.pass} exitCode=${rMissing.exitCode}`,
  )

  delete process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD
  check(
    'command override cleared ⇒ promoteRungateCommand() back to the default gate',
    promoteRungateCommand() === 'bash scripts/run-all-suites.sh',
  )
  delete process.env.MERCURY_CARD_PROMOTE_RUNGATE
}

// ── 7. computeSubjectDrift ────────────────────────────────────────────────
section('7. computeSubjectDrift — recent-vs-prior accept-rate arithmetic (pure)')
{
  const rowFor = (subject: string, outcome: EvolutionOutcome): EvolutionRow => ({
    ts: '2026-07-02T00:00:00.000Z',
    program: LEDGER_PROGRAM,
    subject,
    outcome,
  })
  // subject A: 8 rows, first 4 accepted (prior half) then 4 refused (recent half) —
  // an unambiguous negative-drift signal.
  const subjectA: EvolutionRow[] = [
    ...Array.from({ length: 4 }, () => rowFor('drift-subject-a', 'accepted')),
    ...Array.from({ length: 4 }, () => rowFor('drift-subject-a', 'refused')),
  ]
  // subject B: 3 rows (odd length ⇒ recentN = floor(3/2) = 1) — first 2 accepted, last 1 refused.
  const subjectB: EvolutionRow[] = [
    rowFor('drift-subject-b', 'accepted'),
    rowFor('drift-subject-b', 'accepted'),
    rowFor('drift-subject-b', 'refused'),
  ]
  const drift = computeSubjectDrift([...subjectA, ...subjectB])

  check(
    'two subjects present, sorted by total desc (subject-a total=8 first)',
    drift.length === 2 && drift[0]?.subject === 'drift-subject-a' && drift[0]?.total === 8,
    JSON.stringify(drift.map(d => [d.subject, d.total])),
  )
  const a = drift.find(d => d.subject === 'drift-subject-a')
  const b = drift.find(d => d.subject === 'drift-subject-b')
  check(
    'subject-a total=8 accepted=4 refused=4 error=0',
    a?.total === 8 && a?.accepted === 4 && a?.refused === 4 && a?.error === 0,
    JSON.stringify(a),
  )
  check('subject-a acceptRate = 0.5 (4/8 over all rows)', a?.acceptRate === 0.5)
  check('subject-a recentAcceptRate = 0 (last 4 rows = all refused)', a?.recentAcceptRate === 0)
  check('subject-a priorAcceptRate = 1 (first 4 rows = all accepted)', a?.priorAcceptRate === 1)
  check(
    'subject-b total=3 accepted=2 refused=1 error=0',
    b?.total === 3 && b?.accepted === 2 && b?.refused === 1 && b?.error === 0,
    JSON.stringify(b),
  )
  check(
    'subject-b recentAcceptRate = 0 (last 1 row = refused) and priorAcceptRate = 1 (first 2 rows = accepted)',
    b?.recentAcceptRate === 0 && b?.priorAcceptRate === 1,
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CARD-OUTCOME-LEDGER PROOFS PASS')
else console.log(`❌ ${failures} CARD-OUTCOME-LEDGER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
