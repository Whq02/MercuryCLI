#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/distill-card.ts — operator-invoked distill-on-high-signal
//  write path (Feature 2). Writes one Experience Card into the auto-memory dir
//  and indexes it in MEMORY.md, but ONLY when the high-signal gate passes
//  (shouldDistill): a green-gate-passing commit OR an explicit --operator-signal,
//  a non-trivial transferable lesson, and no secrets.
//
//  This is the operator/harness entry point (analogous to /remember): the act of
//  invoking it is itself the trigger. It drives the SAME real production code
//  (src/memdir/experienceCards.ts) that the in-session, fork+TF-gated doctrine
//  instructs the model to use. Cards are born approved:false (candidate) — an
//  operator promotes one later by flipping metadata.approved: true.
//
//  Usage:
//    bun run scripts/memory/distill-card.ts \
//      --name <slug> --title "<title>" --summary "<one-line>" \
//      --problem-class <class> --lesson "<transferable lesson>" \
//      [--source-ref <ref> ...] [--green] [--operator-signal] \
//      [--confidence confirmed|likely|possible|unverified] \
//      [--freshness fresh|valid|stale|superseded] [--approved] \
//      [--dir <memoryDir>]   (defaults to the resolved auto-memory dir)
// ============================================================================

// Stamp-sim: this CLI ships in the STAMPED product, but under bare
// `bun run` the build-time MACRO is absent, so every stamp gate (promote-gate,
// dedup, supersede, rungate, outcome rows) silently read as UN-stamped ⇒ off —
// the operator got the bare flip while the docs promised the gated path. Gates
// read MACRO lazily, so seeding it here (imports hoist, reads happen at call
// time) turns the documented stamped defaults ON; per-flag `=0` opt-outs still
// apply. `??=` keeps a real build-embedded MACRO authoritative.
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

import { join } from 'node:path'
import {
  type CardConfidence,
  type CardFreshness,
  type CardScope,
  cardPromoteGateEnabled,
  experienceCardsEnabled,
  promoteExperienceCard,
  writeExperienceCard,
} from '../../src/memdir/experienceCards.js'
import { getAutoMemPath } from '../../src/memdir/paths.js'
import {
  cardPromoteRungateEnabled,
  runPromoteRungate,
} from '../../src/memdir/promoteRungate.js'
import {
  computeSubjectDrift,
  readEvolutionRows,
  renderEvolutionReport,
  summarizeEvolution,
  writeEvolutionRow,
} from '../../src/utils/evolution/evolutionLedger.js'

function argList(argv: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[++i])
  }
  return out
}
function arg(argv: string[], flag: string): string | undefined {
  return argList(argv, flag).at(-1)
}
function has(argv: string[], flag: string): boolean {
  return argv.includes(flag)
}

const argv = process.argv.slice(2)

// ── Subcommand: --drift — the read-only card-outcome drift report (adaptive
// follow-up #4): per-problemClass accept/refuse counts + recent-vs-prior rates
// over the memdir's evolution ledger. Pure read; prints and exits.
if (has(argv, '--drift')) {
  const dir = arg(argv, '--dir') ?? getAutoMemPath()
  const rows = await readEvolutionRows(join(dir, 'evolution'), 'memdir-cards')
  if (rows.length === 0) {
    console.log(`no card-outcome rows yet under ${join(dir, 'evolution')} (MERCURY_EVOLUTION_LEDGER writes them on distill/promote decisions)`)
    process.exit(0)
  }
  console.log(renderEvolutionReport(summarizeEvolution('memdir-cards', rows), rows))
  console.log('\nper-subject drift (accept-rate, recent half vs prior):')
  for (const d of computeSubjectDrift(rows)) {
    const pct = (v: number | null) => (v === null ? '  — ' : `${Math.round(v * 100)}%`.padStart(4))
    const trend =
      d.recentAcceptRate !== null && d.priorAcceptRate !== null
        ? d.recentAcceptRate > d.priorAcceptRate
          ? ' ↑'
          : d.recentAcceptRate < d.priorAcceptRate
            ? ' ↓'
            : ' ='
        : ''
    console.log(
      `  ${d.subject.padEnd(36).slice(0, 36)} n=${String(d.total).padStart(3)}  accepted=${String(d.accepted).padStart(3)}  refused=${String(d.refused).padStart(3)}  rate=${pct(d.acceptRate)}  recent=${pct(d.recentAcceptRate)} vs prior=${pct(d.priorAcceptRate)}${trend}`,
    )
  }
  process.exit(0)
}

// ── Subcommand: --promote <slug> — flip a candidate card to approved, GATED by
// cardPromoteGate (the accept-boundary layer) against the dir's
// already-approved siblings. When the gate is off this is the bare frontmatter
// flip an operator would do by hand.
const promoteName = arg(argv, '--promote')
if (promoteName) {
  const dir = arg(argv, '--dir') ?? getAutoMemPath()
  console.log(
    `distill-card --promote: dir=${dir} gate=${cardPromoteGateEnabled() ? 'ON' : 'off'} card=${promoteName}`,
  )
  // Promote-rungate (opt-in MERCURY_CARD_PROMOTE_RUNGATE): actually RUN the
  // executable gate before flipping approved:true — a self-asserted
  // greenGatePassed boolean is not verification (MUSE: unit-test before
  // registration). Fail-closed: non-zero exit (or an unrunnable gate) refuses
  // the promote and records the refusal in the card-outcome ledger.
  if (cardPromoteRungateEnabled()) {
    console.log('rungate: MERCURY_CARD_PROMOTE_RUNGATE=1 — running the executable gate before the flip…')
    const gate = runPromoteRungate()
    const ledgerDir = join(dir, 'evolution')
    if (!gate.pass) {
      const why = gate.timedOut
        ? `TIMED OUT at the ceiling (exit ${gate.exitCode ?? 'none'} after the kill — an unfinished gate is never green)`
        : `failed (exit ${gate.exitCode ?? 'spawn-error'})`
      console.error(
        `⛔ promote refused: the executable gate \`${gate.command}\` ${why} in ${Math.round(gate.durationMs / 1000)}s — the card stays a candidate.` +
          `\n   (exit 127 usually means the command wasn't found from cwd=${process.cwd()} — run from the repo root, or point MERCURY_CARD_PROMOTE_RUNGATE_CMD at a reachable gate)`,
      )
      await writeEvolutionRow(ledgerDir, {
        program: 'memdir-cards',
        subject: promoteName,
        outcome: 'refused',
        mechanism: 'promote-rungate',
        notes: `gate failed: ${gate.command} → exit ${gate.exitCode ?? 'spawn-error'}`,
      })
      process.exit(1)
    }
    console.log(`rungate: ✅ gate green (\`${gate.command}\` → exit 0 in ${Math.round(gate.durationMs / 1000)}s)`)
    await writeEvolutionRow(ledgerDir, {
      program: 'memdir-cards',
      subject: promoteName,
      outcome: 'accepted',
      mechanism: 'promote-rungate',
      notes: 'executable gate green at promote time',
      evidenceRefs: [`${gate.command} → exit 0 (${Math.round(gate.durationMs / 1000)}s)`],
    })
  }
  const result = await promoteExperienceCard(dir, promoteName)
  if (result.ok) {
    console.log(
      result.alreadyApproved
        ? `✓ already approved (no-op): ${result.path}`
        : `✅ promoted to approved: ${result.path}${result.supersededPath ? ` (pre-promote copy preserved: ${result.supersededPath})` : ''}${result.indexUpdated ? ' · MEMORY.md index refreshed' : ''}`,
    )
    process.exit(0)
  }
  if (result.blocked === 'gate') {
    console.error(`⛔ promote refused by gate: ${result.reason}`)
  } else {
    console.error(`⛔ promote failed (${result.blocked}): ${result.reason}`)
  }
  process.exit(1)
}

const name = arg(argv, '--name')
const title = arg(argv, '--title')
const summary = arg(argv, '--summary')
const problemClass = arg(argv, '--problem-class')
const lesson = arg(argv, '--lesson')
if (!name || !title || !summary || !problemClass || !lesson) {
  console.error(
    'distill-card: --name, --title, --summary, --problem-class, and --lesson are required.',
  )
  process.exit(2)
}

const greenGatePassed = has(argv, '--green')
const operatorSignal = has(argv, '--operator-signal')
if (!greenGatePassed && !operatorSignal) {
  console.error(
    'distill-card: pass --green (the commit passed the green-gate) and/or --operator-signal — without a high-signal trigger nothing is carded.',
  )
  process.exit(2)
}

const dir = arg(argv, '--dir') ?? getAutoMemPath()
const sourceRefs = argList(argv, '--source-ref')
const confidence = arg(argv, '--confidence') as CardConfidence | undefined
const freshness = arg(argv, '--freshness') as CardFreshness | undefined
const approved = has(argv, '--approved')
// Transferability triage: classify the lesson and,
// for regime-specific ones, give the applies/not cues that stop universal recall.
const scope = arg(argv, '--scope') as CardScope | undefined
const appliesWhen = arg(argv, '--applies-when')
const notWhen = arg(argv, '--not-when')
const createdAt = arg(argv, '--created-at') ?? new Date().toISOString()

console.log(
  `distill-card: in-session live cards are ${experienceCardsEnabled() ? 'ENABLED' : 'disabled (fork+MERCURY_EXPERIENCE_CARDS off)'}; this CLI is the explicit operator/green trigger and runs regardless.`,
)

const result = await writeExperienceCard(
  dir,
  {
    name,
    title,
    summary,
    problemClass,
    lesson,
    sourceRefs,
    confidence,
    freshness,
    approved,
    scope,
    appliesWhen,
    notWhen,
    createdAt,
    greenGate: greenGatePassed,
  },
  { signal: { greenGatePassed, operatorSignal, lesson, sourceRefs } },
)

if (result.ok) {
  console.log(`✅ carded: ${result.path}`)
  console.log(
    `   index: ${result.indexPath} (${result.indexUpdated ? 'pointer added' : 'pointer already present'})`,
  )
  console.log(
    `   lifecycle: ${approved ? 'approved (trusted)' : 'candidate — unverified (operator flips metadata.approved to trust it)'}`,
  )
  process.exit(0)
}

switch (result.blocked) {
  case 'secret-bearing':
    console.error(
      `⛔ refused: secret-bearing content (${result.matches.map(m => m.kind).join(', ')}) — not carded.`,
    )
    break
  case 'skipped':
    console.error(`⏭️  skipped: ${result.reason}`)
    break
  case 'duplicate':
    console.error(`⏭️  duplicate: ${result.reason}`)
    break
  case 'supersede-failed':
    console.error(`⛔ supersede failed: ${result.reason}`)
    break
  default:
    console.error(`⛔ invalid input: ${result.reason}`)
}
process.exit(1)
