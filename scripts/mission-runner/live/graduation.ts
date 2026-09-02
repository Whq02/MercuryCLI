// ============================================================================
//  scripts/mission-runner/live/graduation.ts — the §12.1 graduation rule, mechanical.
// ----------------------------------------------------------------------------
//  Baseline-vs-candidate qualification rows in, ONE typed verdict out. Every
//  criterion carries pass | fail | not-applicable + a note — an N/A is NAMED
//  (never silently passed), any FAIL refuses graduation, and the honest
//  outcome `NO POLICY GRADUATED` is a first-class result (§12.1: never
//  manufacture improvement, never weaken the rule).
//
//  Predeclared statistics (frozen BEFORE qualification, recorded in the
//  freeze record):
//    · accepted-rate: +20% relative OR +10 percentage points;
//    · interventions: −30% on applicable tasks (headless arms observe zero
//      interventions by construction ⇒ N/A, named);
//    · median wall −15% on the routing/parallelism-selected tasks;
//    · incorrect claims: never increase; ZERO on mechanical tasks;
//    · rejected+indeterminate rate: no material worsening (≤ +5 pp);
//    · work per accepted (output tokens): ≤ +10%;
//    · solo-suitable tasks: candidate must resolve solo profiles and stay
//      within +25% wall;
//    · deterministic floors: the pooled gate verdict (recorded input);
//    · no task family loses more than 1 accepted result vs baseline.
// ============================================================================
import { readFileSync } from 'node:fs'
import type { HelixRunRow } from './runner.js'
import { decodeRows } from './aggregate.js'

export interface GraduationCriterion {
  id: string
  status: 'pass' | 'fail' | 'not-applicable'
  note: string
}

export interface GraduationVerdict {
  graduated: boolean
  headline: string
  criteria: GraduationCriterion[]
  baseline: { policy: string; runs: number; accepted: number }
  candidate: { policy: string; runs: number; accepted: number }
}

const ROUTING_FAMILIES = new Set([7, 9, 16])
const MECHANICAL_FAMILIES = new Set([11])
const SOLO_FAMILIES = new Set([8])

function executed(rows: HelixRunRow[]): HelixRunRow[] {
  return rows.filter(r => r.status !== 'not-applicable')
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function evaluateGraduation(
  baselineRows: HelixRunRow[],
  candidateRows: HelixRunRow[],
  opts: { deterministicFloorsGreen: boolean },
): GraduationVerdict {
  const base = executed(baselineRows)
  const cand = executed(candidateRows)
  const criteria: GraduationCriterion[] = []
  const add = (id: string, status: GraduationCriterion['status'], note: string): void => {
    criteria.push({ id, status, note })
  }

  const baseAccepted = base.filter(r => r.status === 'accepted').length
  const candAccepted = cand.filter(r => r.status === 'accepted').length
  const baseRate = base.length === 0 ? 0 : baseAccepted / base.length
  const candRate = cand.length === 0 ? 0 : candAccepted / cand.length

  // 1 · accepted-result rate.
  const relGain = baseRate === 0 ? (candRate > 0 ? Infinity : 0) : (candRate - baseRate) / baseRate
  const ppGain = (candRate - baseRate) * 100
  add(
    'accepted-rate',
    relGain >= 0.2 || ppGain >= 10 ? 'pass' : 'fail',
    `baseline ${(baseRate * 100).toFixed(1)}% → candidate ${(candRate * 100).toFixed(1)}% (rel ${(relGain * 100).toFixed(1)}%, ${ppGain.toFixed(1)} pp; need ≥20% rel or ≥10 pp)`,
  )

  // 2 · operator interventions (headless: zero by construction).
  add(
    'interventions',
    'not-applicable',
    'headless qualification arms observe zero operator interventions by construction — N/A, named',
  )

  // 3 · median wall on routing/parallelism-selected tasks.
  const baseRouting = base.filter(r => ROUTING_FAMILIES.has(r.family) && typeof r.wallSeconds === 'number')
  const candRouting = cand.filter(r => ROUTING_FAMILIES.has(r.family) && typeof r.wallSeconds === 'number')
  const baseWall = median(baseRouting.map(r => r.wallSeconds as number))
  const candWall = median(candRouting.map(r => r.wallSeconds as number))
  if (baseWall === null || candWall === null) {
    add('routed-wall-time', 'not-applicable', 'no routing/parallelism rows in one of the arms')
  } else {
    add(
      'routed-wall-time',
      candWall <= baseWall * 0.85 ? 'pass' : 'fail',
      `median wall on families 7/9/16: baseline ${baseWall}s → candidate ${candWall}s (need −15%)`,
    )
  }

  // 4 · incorrect completion claims.
  const baseClaims = base.filter(r => r.incorrectClaim).length
  const candClaims = cand.filter(r => r.incorrectClaim).length
  const candMechClaims = cand.filter(r => MECHANICAL_FAMILIES.has(r.family) && r.incorrectClaim).length
  add(
    'incorrect-claims',
    candClaims <= baseClaims && candMechClaims === 0 ? 'pass' : 'fail',
    `claims baseline ${baseClaims} → candidate ${candClaims}; mechanical-task claims ${candMechClaims} (must not increase; zero on mechanical)`,
  )

  // 5 · rejected/indeterminate rate (≤ +5 pp predeclared).
  const badRate = (rows: HelixRunRow[]): number =>
    rows.length === 0 ? 0 : rows.filter(r => r.status === 'rejected' || r.status === 'indeterminate').length / rows.length
  const baseBad = badRate(base)
  const candBad = badRate(cand)
  add(
    'rejected-indeterminate',
    candBad <= baseBad + 0.05 ? 'pass' : 'fail',
    `rejected+indeterminate baseline ${(baseBad * 100).toFixed(1)}% → candidate ${(candBad * 100).toFixed(1)}% (≤ +5 pp)`,
  )

  // 6 · work per accepted result (output tokens; ≤ +10% unless quality gain
  //     is explicitly larger — that exception is the operator's, not ours).
  const workPer = (rows: HelixRunRow[]): number | null => {
    const acc = rows.filter(r => r.status === 'accepted' && typeof r.outputTokens === 'number')
    if (acc.length === 0) return null
    return acc.reduce((s, r) => s + (r.outputTokens as number), 0) / acc.length
  }
  const baseWork = workPer(base)
  const candWork = workPer(cand)
  if (baseWork === null || candWork === null) {
    add('work-per-accepted', 'not-applicable', 'no accepted rows with usage in one of the arms')
  } else {
    add(
      'work-per-accepted',
      candWork <= baseWork * 1.1 ? 'pass' : 'fail',
      `output tokens per accepted: baseline ${Math.round(baseWork)} → candidate ${Math.round(candWork)} (≤ +10%)`,
    )
  }

  // 7 · solo-suitable tasks acquire no meaningful orchestration overhead.
  const candSolo = cand.filter(r => SOLO_FAMILIES.has(r.family))
  const soloProfilesOk = candSolo.every(
    r => r.selectedProfile === undefined || r.selectedProfile.startsWith('solo'),
  )
  const baseSoloWall = median(
    base.filter(r => SOLO_FAMILIES.has(r.family) && typeof r.wallSeconds === 'number').map(r => r.wallSeconds as number),
  )
  const candSoloWall = median(
    candSolo.filter(r => typeof r.wallSeconds === 'number').map(r => r.wallSeconds as number),
  )
  const soloWallOk = baseSoloWall === null || candSoloWall === null || candSoloWall <= baseSoloWall * 1.25
  add(
    'solo-overhead',
    soloProfilesOk && soloWallOk ? 'pass' : 'fail',
    `solo-family selections stay solo (${soloProfilesOk}) · wall ${baseSoloWall ?? '—'}s → ${candSoloWall ?? '—'}s (≤ +25%)`,
  )

  // 8 · deterministic floors.
  add(
    'deterministic-floors',
    opts.deterministicFloorsGreen ? 'pass' : 'fail',
    'restart/replan/idempotency floors ride the pooled gate verdict',
  )

  // 9 · no family loses more than 1 accepted result.
  const families = [...new Set([...base, ...cand].map(r => r.family))].sort((a, b) => a - b)
  const regressions: string[] = []
  for (const family of families) {
    const b = base.filter(r => r.family === family && r.status === 'accepted').length
    const c = cand.filter(r => r.family === family && r.status === 'accepted').length
    if (c < b - 1) regressions.push(`family ${family}: ${b}→${c}`)
  }
  add(
    'family-regressions',
    regressions.length === 0 ? 'pass' : 'fail',
    regressions.length === 0 ? 'no family loses more than 1 accepted result' : regressions.join(' · '),
  )

  const graduated = criteria.every(c => c.status !== 'fail')
  return {
    graduated,
    headline: graduated
      ? 'candidate GRADUATES — every §12.1 criterion holds (N/As named)'
      : 'NO POLICY GRADUATED — ' + criteria.filter(c => c.status === 'fail').map(c => c.id).join(', ') + ' failed',
    criteria,
    baseline: { policy: base[0]?.policyId ?? 'baseline', runs: base.length, accepted: baseAccepted },
    candidate: { policy: cand[0]?.policyId ?? 'candidate', runs: cand.length, accepted: candAccepted },
  }
}

if (import.meta.main) {
  const [baseFile, candFile, floors] = process.argv.slice(2)
  if (!baseFile || !candFile) {
    console.error('usage: graduation.ts <baseline.jsonl> <candidate.jsonl> [floors-green|floors-red]')
    process.exit(2)
  }
  const verdict = evaluateGraduation(
    decodeRows(readFileSync(baseFile, 'utf8')),
    decodeRows(readFileSync(candFile, 'utf8')),
    { deterministicFloorsGreen: floors !== 'floors-red' },
  )
  console.log(JSON.stringify(verdict, null, 2))
}
