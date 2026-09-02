#!/usr/bin/env bun
// ============================================================================
//  scripts/render-migration/prove-cockpit-ledger.ts — the cockpit's settled-
//  prefix ledger laws (E1/E2/E10 under the pane).
//
//  L1  the stable boundary lags the live edge by whole turns (turn heads —
//      visible user prompts — as boundaries): nothing before a head submits
//      until `turnLag` whole turns stand between that head and the live one.
//  L2  newly-stable rows submit as ordered batches; the frozen count only
//      grows; re-feeding the same projection submits nothing new (E2's
//      repeat path — acks without effect).
//  L3  a duplicate identity inside the stable prefix is dropped + reported
//      (E10's flatness edge).
//  L4  a projection that RENAMES or REORDERS the frozen prefix is a
//      divergence: reported, frozen truth stands, feeding stops.
//  L5  a projection that SHRINKS below the frozen prefix is a divergence.
//  L6  advanceWidth (the preserve policy) bumps the epoch and keeps truth.
//  L7  A COMPACTION BOUNDARY (app-declared history replacement,
//      resetForReplacement): the frozen truth restarts — a projection that
//      re-yields ALREADY-FROZEN identities at new positions freezes cleanly
//      with zero violations; the SAME re-yield WITHOUT the reset trips the
//      laws (the crash class the compact30b drive found live: armed builds
//      died on the first /compact with "duplicate settled identity").
//
//  Run: ~/.bun/bin/bun run scripts/render-migration/prove-cockpit-ledger.ts
// ============================================================================
import { CockpitLedger, type ProjectedRow } from '../../src/render-engine/cockpit/cockpitLedger.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const row = (uuid: string, kind = 'assistant', text = `text of ${uuid}`): ProjectedRow => ({ uuid, kind, turnHead: false, text })
/** A turn head: the visible user prompt that opens turn n. */
const head = (n: number): ProjectedRow => ({ uuid: `prompt-${n}`, kind: 'user', turnHead: true, text: `user prompt ${n}` })

console.log('cockpit-ledger laws')

// ── L1/L2 ──────────────────────────────────────────────────────────────────
{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })

  // Turn 1 in flight: one head — nothing stable.
  let projection: ProjectedRow[] = [head(1), row('a1')]
  let report = ledger.feed(projection)
  check('L1 one turn (live): nothing submits', report.settledCount === 0)

  // Turn 2 opens: turn 1 is settled but ADJACENT to the live turn (lag 1) —
  // still nothing before the lagged head.
  projection = [head(1), row('a1'), head(2), row('a2')]
  report = ledger.feed(projection)
  check('L1 two turns (lag 1): the settled-but-adjacent turn stays unfrozen', report.settledCount === 0, String(report.settledCount))

  // Turn 3 opens: turn 1 now has a whole settled turn between it and the
  // live edge — it freezes (prompt-1 · a1).
  projection = [head(1), row('a1'), head(2), row('a2'), head(3), row('a3')]
  report = ledger.feed(projection)
  check('L2 the first turn froze whole (prompt-1 · a1)', report.settledCount === 2, String(report.settledCount))

  // Re-feed identical: nothing new (the repeat path).
  report = ledger.feed(projection)
  check('L2 re-feeding the same projection freezes nothing new', report.settledCount === 2 && report.divergences === 0)

  // Turn 4 opens: turn 2 freezes.
  projection = [...projection, head(4), row('a4')]
  report = ledger.feed(projection)
  check('L2 the second turn froze when the fourth opened', report.settledCount === 4, String(report.settledCount))
  check('L1/L2 no violations on the lawful drive', violations.length === 0, JSON.stringify(violations))
}

// ── L3: duplicate identity in the stable prefix ────────────────────────────
{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  const projection = [head(1), row('dup'), row('mid'), row('dup'), head(2), row('a2'), head(3), row('a3')]
  const report = ledger.feed(projection)
  check('L3 the duplicate copy was dropped (one frozen row for the identity)', report.flatnessDrops === 1, String(report.flatnessDrops))
  check('L3 the drop was reported', violations.some(v => v.includes('dup')), JSON.stringify(violations))
}

// ── L4: rename in the frozen prefix ────────────────────────────────────────
{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  const stable = [head(1), row('a'), head(2), row('b'), head(3), row('c')]
  ledger.feed(stable)
  const renamed = [head(1), row('a-RENAMED'), head(2), row('b'), head(3), row('c')]
  const report = ledger.feed(renamed)
  check('L4 a renamed frozen row is a divergence', report.divergences === 1 && violations.some(v => v.includes('a-RENAMED')), JSON.stringify(violations))
  check('L4 frozen truth stands', report.settledCount === 2)
}

// ── L5: shrink below the frozen prefix ─────────────────────────────────────
{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  ledger.feed([head(1), row('a'), head(2), row('b'), head(3), row('c')])
  const report = ledger.feed([head(1)])
  check('L5 a projection shrinking below the frozen prefix is a divergence', report.divergences === 1 && violations.some(v => v.includes('shrank')), JSON.stringify(violations))
}

// ── L6: width epochs (preserve) ────────────────────────────────────────────
{
  const ledger = new CockpitLedger(120)
  ledger.feed([head(1), row('a'), head(2), row('b'), head(3), row('c')])
  const before = ledger.ledgerRef().widthEpoch()
  ledger.advanceWidth(100)
  check('L6 advanceWidth bumps the epoch and keeps the frozen rows', ledger.ledgerRef().widthEpoch() === before + 1 && ledger.report().settledCount === 2)
}

// ── L7: compaction = app-declared replacement resets the frozen truth ──────
{
  // WITHOUT the reset: the compact-shaped re-feed (boundary + re-yielded
  // frozen identities at shifted positions) trips the laws — the tripwire
  // that killed the armed cockpit on its first /compact.
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  for (let n = 1; n <= 5; n++) ledger.feed(fiveTurns(n))
  const frozenBefore = ledger.report().settledCount
  check('L7 setup froze a prefix', frozenBefore > 0)
  const compacted = [row('compact-boundary', 'user', 'summary card'), head(4), row('d'), head(5), row('e'), head(6), row('f'), head(7), row('g')]
  ledger.feed(compacted)
  ledger.feed([...compacted, head(8), row('h')])
  check('L7 control: the compact-shaped re-feed WITHOUT a reset is a loud violation', violations.length > 0, JSON.stringify(violations.slice(0, 1)))

  // WITH the reset: fresh truth, the re-yielded identities freeze cleanly.
  const violations2: string[] = []
  const ledger2 = new CockpitLedger(120, { onViolation: d => violations2.push(d) })
  for (let n = 1; n <= 5; n++) ledger2.feed(fiveTurns(n))
  ledger2.resetForReplacement()
  check('L7 resetForReplacement counts and empties the frozen truth', ledger2.historyReplacements() === 1 && ledger2.report().settledCount === 0)
  ledger2.feed(compacted)
  const after = ledger2.feed([...compacted, head(8), row('h'), head(9), row('i')])
  check(
    'L7 after the reset the re-yielded identities freeze cleanly: zero violations, a fresh prefix',
    violations2.length === 0 && after.divergences === 0 && after.flatnessDrops === 0 && after.settledCount > 0,
    JSON.stringify({ violations: violations2, report: after }),
  )
  // and the laws stay armed within the NEW history:
  const renamedTail = [row('compact-boundary', 'user', 'summary card'), head(4), row('d-RENAMED')]
  ledger2.feed(renamedTail.concat([head(5), row('e'), head(6), row('f'), head(7), row('g'), head(8), row('h'), head(9), row('i')]))
  check('L7 the agreement law stays armed within the replaced history', violations2.length > 0, JSON.stringify(violations2.slice(0, 1)))
}

function fiveTurns(upto: number): ProjectedRow[] {
  const rows: ProjectedRow[] = []
  for (let n = 1; n <= upto; n++) {
    rows.push(head(n), row(String.fromCharCode(96 + n)))
  }
  return rows
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
