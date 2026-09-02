// ============================================================================
//  prove-completion-replan.ts — the H4 laws: independent completion
//  evaluation (§9) + bounded replanning (§8).
// ----------------------------------------------------------------------------
//  Completion: grader-first order · reviewer can never override a failing
//  grader · passing grader never settles unresolved semantics · evidence
//  divergence blocks acceptance · incorrect claims counted separately ·
//  typed REVIEW tail parses totally (garbage ⇒ indeterminate).
//  Replan: closed 8-trigger vocabulary · classification totality · the
//  routePlanOps trigger validation law rides the store note · the
//  MISSION_REPLAN_CEILING refuses plan-wide churn at the route store ·
//  failure isolation: a failed node becomes a NAMED synthesis gap while
//  sibling nodes continue.
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateMissionCompletion,
  parseReviewResult,
} from '../../src/services/mission/completion.js'
import {
  classifyReplanNote,
  isMissionReplanTrigger,
  MISSION_REPLAN_TRIGGERS,
} from '../../src/services/mission/replan.js'
import { composeMissionView } from '../../src/services/mission/projection.js'
import type { TaskRoutePlan } from '../../src/utils/router/contracts.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

// ── §9 completion order ─────────────────────────────────────────────────────
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

// ── the typed REVIEW tail ───────────────────────────────────────────────────
const parsed = parseReviewResult('work done.\nREVIEW: revise [reqs: r1, r2] [refs: mercury://test/x] [next: fix the edge case]')
check('review tail parses', parsed.verdict === 'revise' && parsed.requirementIds.join(',') === 'r1,r2' && parsed.nextAction === 'fix the edge case')
check('garbage parses to indeterminate', parseReviewResult('all done, looks great!').verdict === 'indeterminate')
check('malformed verdict parses to indeterminate', parseReviewResult('REVIEW: shipit').verdict === 'indeterminate')
check('the LAST review line wins', parseReviewResult('REVIEW: reject\nmore work\nREVIEW: accept').verdict === 'accept')

// ── §8 trigger vocabulary ───────────────────────────────────────────────────
check('eight trigger classes', MISSION_REPLAN_TRIGGERS.length === 8)
check('validation is closed', isMissionReplanTrigger('check-failed') && !isMissionReplanTrigger('vibes'))
check('tagged notes classify exactly', classifyReplanNote('[trigger: symbol-moved] the helper moved') === 'symbol-moved')
check('check failures classify', classifyReplanNote('the acceptance test failed with a new stack') === 'check-failed')
check('shared owners classify', classifyReplanNote('discovered a shared owner in registry.js') === 'undeclared-dependency')
check('free-form churn classifies to null', classifyReplanNote('try again please') === null)

// ── the plan-wide replan ceiling at the route store ──────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'helix-replan-'))
process.env.MERCURY_ROUTER_STATE_DIR = scratch
{
  const { MISSION_REPLAN_CEILING, routerRunStore, routerStoreWriters } = await import(
    '../../src/substrate/routerRunStore.js'
  )
  check('the ceiling is a small explicit number', MISSION_REPLAN_CEILING === 6)
  const node = (id: string, attempt: number, state: string) => ({
    id,
    title: id,
    task: id,
    dependsOn: [],
    ownsPaths: ['src/' + id + '.js'],
    acceptance: [],
    state,
    attempt,
    expectedResult: 'green',
  })
  const features = {
    taskShape: 'bounded',
    ambiguity: 1,
    coupling: 1,
    parallelism: 1,
    contextDemand: 1,
    verificationDemand: 1,
    estimatedFiles: 2,
    explicitPaths: [],
    requiresSynthesis: false,
  }
  const plan = {
    version: 1,
    id: 'rp-ceiling',
    revision: 1,
    mode: 'scribe',
    title: 'ceiling fixture',
    objective: 'ceiling fixture',
    features,
    profile: 'sonnet-direct',
    nodes: [node('n1', 3, 'failed'), node('n2', 3, 'failed'), node('n3', 3, 'failed'), node('n4', 1, 'failed')],
    synthesis: { required: false, owner: 'scribe', acceptance: [] },
    decision: {
      policyVersion: 'v1',
      source: 'local-fallback',
      posture: 'adaptive',
      selectedProfile: 'sonnet-direct',
      selectedModels: [],
      decisiveReasons: [],
      displayReasons: [],
      adjustments: [],
    },
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as TaskRoutePlan
  await routerStoreWriters.commitPlan(plan, 10)
  // n4 is under ITS OWN ceiling (attempt 1) but the plan's total revisions
  // (3× attempt-3 nodes = 6) sit AT the mission ceiling — refuse, named.
  await routerStoreWriters.reviseNode('rp-ceiling', 'n4', 'the acceptance test failed again', 20)
  const state = await routerRunStore().read()
  const stored = state.plans.find(p => p.id === 'rp-ceiling')
  check('the plan-wide ceiling refuses the revise', stored?.nodes.find(n => n.id === 'n4')?.state === 'failed')
  check('the refusal is a NAMED echo', state.events.some(e => e.to === 'refused:revise' && (e.reason ?? '').includes('mission replan ceiling')))
  // Per-node ceiling still speaks first for its own case.
  await routerStoreWriters.reviseNode('rp-ceiling', 'n1', 'again', 30)
  const after = await routerRunStore().read()
  check('the per-node ceiling still refuses first', after.events.some(e => e.nodeId === 'n1' && (e.reason ?? '').includes('attempt ceiling')))
}
delete process.env.MERCURY_ROUTER_STATE_DIR
rmSync(scratch, { recursive: true, force: true })

// ── failure isolation in the mission projection ─────────────────────────────
{
  const plan = {
    version: 1,
    id: 'rp-iso',
    revision: 1,
    mode: 'scribe',
    title: 'iso',
    objective: 'iso',
    features: {
      taskShape: 'bounded',
      ambiguity: 1,
      coupling: 1,
      parallelism: 2,
      contextDemand: 1,
      verificationDemand: 1,
      estimatedFiles: 2,
      explicitPaths: [],
      requiresSynthesis: true,
    },
    profile: 'parallel-sonnet',
    nodes: [
      { id: 'nA', title: 'lane A', task: 'a', dependsOn: [], ownsPaths: [], acceptance: [], state: 'failed', attempt: 3, expectedResult: 'x' },
      { id: 'nB', title: 'lane B', task: 'b', dependsOn: [], ownsPaths: [], acceptance: [], state: 'working', attempt: 1, expectedResult: 'x' },
    ],
    synthesis: { required: true, owner: 'scribe', acceptance: [] },
    decision: {
      policyVersion: 'v1',
      source: 'structured-intent',
      posture: 'adaptive',
      selectedProfile: 'parallel-sonnet',
      selectedModels: [],
      decisiveReasons: [],
      displayReasons: [],
      adjustments: [],
    },
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as TaskRoutePlan
  const view = composeMissionView({
    workspace: '/tmp/p',
    runObjective: 'iso',
    runLifecycle: 'active',
    plans: [plan],
    snapshot: null,
    memoryRefs: [],
    executions: [],
    evidenceDigest: null,
    posture: null,
    nodeAttemptCeiling: 3,
    now: 100,
  })
  check('a failed node becomes a NAMED synthesis gap', (view?.synthesisGaps ?? []).some(g => g.includes('nA') && g.includes('failed')))
  check('sibling work continues (failure isolated)', view?.plans[0]?.nodes.find(n => n.nodeId === 'nB')?.state === 'working')
  check('the mission stays live through a node failure', view?.outcome === null)
}

if (failures > 0) {
  console.error('prove-completion-replan: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-completion-replan: green')
