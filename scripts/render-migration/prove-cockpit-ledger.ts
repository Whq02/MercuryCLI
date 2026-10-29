#!/usr/bin/env bun
import { CockpitLedger, type ProjectedRow } from '../../src/render-engine/cockpit/cockpitLedger.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const row = (uuid: string, kind = 'assistant', text = `text of ${uuid}`): ProjectedRow => ({ uuid, kind, turnHead: false, text })
const head = (n: number): ProjectedRow => ({ uuid: `prompt-${n}`, kind: 'user', turnHead: true, text: `user prompt ${n}` })

console.log('cockpit-ledger laws')

{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })

  let projection: ProjectedRow[] = [head(1), row('a1')]
  let report = ledger.feed(projection)
  check('L1 one turn (live): nothing submits', report.settledCount === 0)

  projection = [head(1), row('a1'), head(2), row('a2')]
  report = ledger.feed(projection)
  check('L1 two turns (lag 1): the settled-but-adjacent turn stays unfrozen', report.settledCount === 0, String(report.settledCount))

  projection = [head(1), row('a1'), head(2), row('a2'), head(3), row('a3')]
  report = ledger.feed(projection)
  check('L2 the first turn froze whole (prompt-1 · a1)', report.settledCount === 2, String(report.settledCount))

  report = ledger.feed(projection)
  check('L2 re-feeding the same projection freezes nothing new', report.settledCount === 2 && report.divergences === 0)

  projection = [...projection, head(4), row('a4')]
  report = ledger.feed(projection)
  check('L2 the second turn froze when the fourth opened', report.settledCount === 4, String(report.settledCount))
  check('L1/L2 no violations on the lawful drive', violations.length === 0, JSON.stringify(violations))
}

{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  const projection = [head(1), row('dup'), row('mid'), row('dup'), head(2), row('a2'), head(3), row('a3')]
  const report = ledger.feed(projection)
  check('L3 the duplicate copy was dropped (one frozen row for the identity)', report.flatnessDrops === 1, String(report.flatnessDrops))
  check('L3 the drop was reported', violations.some(v => v.includes('dup')), JSON.stringify(violations))
}

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

{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  ledger.feed([head(1), row('a'), head(2), row('b'), head(3), row('c')])
  const report = ledger.feed([head(1)])
  check('L5 a projection shrinking below the frozen prefix is a divergence', report.divergences === 1 && violations.some(v => v.includes('shrank')), JSON.stringify(violations))
}

{
  const ledger = new CockpitLedger(120)
  ledger.feed([head(1), row('a'), head(2), row('b'), head(3), row('c')])
  const before = ledger.ledgerRef().widthEpoch()
  ledger.advanceWidth(100)
  check('L6 advanceWidth bumps the epoch and keeps the frozen rows', ledger.ledgerRef().widthEpoch() === before + 1 && ledger.report().settledCount === 2)
}

{
  const violations: string[] = []
  const ledger = new CockpitLedger(120, { onViolation: d => violations.push(d) })
  for (let n = 1; n <= 5; n++) ledger.feed(fiveTurns(n))
  const frozenBefore = ledger.report().settledCount
  check('L7 setup froze a prefix', frozenBefore > 0)
  const compacted = [row('compact-boundary', 'user', 'summary card'), head(4), row('d'), head(5), row('e'), head(6), row('f'), head(7), row('g')]
  ledger.feed(compacted)
  ledger.feed([...compacted, head(8), row('h')])
  check('L7 control: the compact-shaped re-feed WITHOUT a reset is a loud violation', violations.length > 0, JSON.stringify(violations.slice(0, 1)))

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
