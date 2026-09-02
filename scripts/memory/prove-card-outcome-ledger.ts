#!/usr/bin/env bun
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

section('3. Refused distill (distill-time dedup blocks a near-duplicate) → "refused" row')
{
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

section('7. computeSubjectDrift — recent-vs-prior accept-rate arithmetic (pure)')
{
  const rowFor = (subject: string, outcome: EvolutionOutcome): EvolutionRow => ({
    ts: '2026-07-02T00:00:00.000Z',
    program: LEDGER_PROGRAM,
    subject,
    outcome,
  })
  const subjectA: EvolutionRow[] = [
    ...Array.from({ length: 4 }, () => rowFor('drift-subject-a', 'accepted')),
    ...Array.from({ length: 4 }, () => rowFor('drift-subject-a', 'refused')),
  ]
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
