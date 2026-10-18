import {
  evaluateMissionCompletion,
  parseReviewResult,
} from './live/completion.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

const acceptReview = { verdict: 'accept' as const, requirementIds: [], evidenceRefs: [], nextAction: null }
const failOverride = evaluateMissionCompletion({
  grader: 'fail',
  undeclaredEffectDivergence: 0,
  semanticRequired: true,
  reviewer: acceptReview,
  implementerClaimedSuccess: true,
})
check('reviewer never overrides a failing grader', failOverride.state === 'rejected' && failOverride.decidedBy === 'mechanical-grader')
check('the discarded override is named', failOverride.notes.some(n => n.includes('DISCARDED')))
check('claim over failure counted separately', failOverride.incorrectCompletionClaim === true)

const divergent = evaluateMissionCompletion({
  grader: 'pass',
  undeclaredEffectDivergence: 2,
  semanticRequired: false,
  reviewer: null,
  implementerClaimedSuccess: true,
})
check('declared-unobserved work blocks acceptance', divergent.state === 'revise' && divergent.decidedBy === 'evidence-divergence')

const unsettled = evaluateMissionCompletion({
  grader: 'pass',
  undeclaredEffectDivergence: 0,
  semanticRequired: true,
  reviewer: null,
  implementerClaimedSuccess: false,
})
check('passing grader never settles unresolved semantics', unsettled.state === 'indeterminate' && unsettled.decidedBy === 'unresolved-semantics')

const semantic = evaluateMissionCompletion({
  grader: 'pass',
  undeclaredEffectDivergence: 0,
  semanticRequired: true,
  reviewer: { verdict: 'revise', requirementIds: ['r1'], evidenceRefs: [], nextAction: 'tighten the contract' },
  implementerClaimedSuccess: false,
})
check('reviewer settles remaining semantics', semantic.state === 'revise' && semantic.decidedBy === 'reviewer')
check('plain mechanical pass accepts', evaluateMissionCompletion({ grader: 'pass', undeclaredEffectDivergence: 0, semanticRequired: false, reviewer: null, implementerClaimedSuccess: true }).state === 'accepted')

const parsed = parseReviewResult('work done.\nREVIEW: revise [reqs: r1, r2] [refs: mercury://test/x] [next: fix the edge case]')
check('review tail parses', parsed.verdict === 'revise' && parsed.requirementIds.join(',') === 'r1,r2' && parsed.nextAction === 'fix the edge case')
check('garbage parses to indeterminate', parseReviewResult('all done, looks great!').verdict === 'indeterminate')
check('malformed verdict parses to indeterminate', parseReviewResult('REVIEW: shipit').verdict === 'indeterminate')
check('the LAST review line wins', parseReviewResult('REVIEW: reject\nmore work\nREVIEW: accept').verdict === 'accept')

if (failures > 0) {
  console.error('prove-completion-replan: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-completion-replan: green')
