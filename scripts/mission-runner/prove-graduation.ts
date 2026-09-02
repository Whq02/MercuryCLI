import { evaluateGraduation } from './live/graduation.js'
import type { HelixRunRow } from './live/runner.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

let seq = 0
function row(partial: Partial<HelixRunRow>): HelixRunRow {
  seq += 1
  return {
    ts: '2026-07-21T00:00:00.000Z',
    taskId: 'T' + seq,
    family: 2,
    partition: 'qualification',
    policyId: 'solo',
    policyDigest: 'hp1-x',
    corpusDigest: 'hc1-x',
    mercurySha: 'sha',
    artifactTree: 'tree',
    model: 'claude-opus-4-8',
    effortIntent: 'high',
    status: 'accepted',
    accepted: true,
    wallSeconds: 100,
    outputTokens: 1000,
    ...partial,
  }
}

const floors = { deterministicFloorsGreen: true }

const baseline: HelixRunRow[] = [
  row({ family: 9, wallSeconds: 200 }),
  row({ family: 9, wallSeconds: 220, status: 'rejected', accepted: false }),
  row({ family: 7, wallSeconds: 300 }),
  row({ family: 16, wallSeconds: 260, status: 'rejected', accepted: false }),
  row({ family: 8, wallSeconds: 60 }),
  row({ family: 11, status: 'rejected', accepted: false, incorrectClaim: true }),
  row({ family: 12, status: 'rejected', accepted: false }),
  row({ family: 14 }),
  row({ family: 5 }),
  row({ family: 6 }),
]

const candidate: HelixRunRow[] = [
  row({ policyId: 'selected', family: 9, wallSeconds: 120, selectedProfile: 'routed-wide' }),
  row({ policyId: 'selected', family: 9, wallSeconds: 130, selectedProfile: 'routed-wide' }),
  row({ policyId: 'selected', family: 7, wallSeconds: 200, selectedProfile: 'workflow-deep' }),
  row({ policyId: 'selected', family: 16, wallSeconds: 170, selectedProfile: 'routed-wide' }),
  row({ policyId: 'selected', family: 8, wallSeconds: 62, selectedProfile: 'solo-default' }),
  row({ policyId: 'selected', family: 11, selectedProfile: 'specialist-sol' }),
  row({ policyId: 'selected', family: 12, selectedProfile: 'solo-reviewer' }),
  row({ policyId: 'selected', family: 14, selectedProfile: 'solo-reviewer' }),
  row({ policyId: 'selected', family: 5, status: 'rejected', accepted: false, selectedProfile: 'solo-default' }),
  row({ policyId: 'selected', family: 6, selectedProfile: 'solo-reviewer' }),
]

const good = evaluateGraduation(baseline, candidate, floors)
check('a strictly better candidate graduates', good.graduated, good.headline)
check('interventions criterion is NAMED not-applicable', good.criteria.some(c => c.id === 'interventions' && c.status === 'not-applicable'))
check('every criterion carries a note', good.criteria.every(c => c.note.length > 0))

const tie = evaluateGraduation(baseline, baseline.map(r => ({ ...r, policyId: 'selected' })), floors)
check('a tie never graduates', !tie.graduated && tie.headline.startsWith('NO POLICY GRADUATED'))

const claimy = candidate.map(r =>
  r.family === 11 ? { ...r, incorrectClaim: true, status: 'rejected' as const, accepted: false } : r,
)
const claimVerdict = evaluateGraduation(baseline, claimy, floors)
check('mechanical-task claims refuse graduation', !claimVerdict.graduated && claimVerdict.criteria.some(c => c.id === 'incorrect-claims' && c.status === 'fail'))

const redFloors = evaluateGraduation(baseline, candidate, { deterministicFloorsGreen: false })
check('red deterministic floors refuse graduation', !redFloors.graduated)

const regressed = candidate.map(r => (r.family === 14 || r.family === 6 ? { ...r, status: 'rejected' as const, accepted: false } : r))
const regressedMore = regressed.map(r => (r.family === 5 ? { ...r, status: 'accepted' as const, accepted: true } : r))
const famVerdict = evaluateGraduation(baseline, regressedMore, floors)
check(
  'a family regression is not hidden by the aggregate',
  famVerdict.criteria.some(c => c.id === 'family-regressions') ,
)

check('verdict is deterministic', JSON.stringify(good) === JSON.stringify(evaluateGraduation(baseline, candidate, floors)))

if (failures > 0) {
  console.error('prove-graduation: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-graduation: green')
