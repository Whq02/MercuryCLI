// ============================================================================
// services/mission/completion — independent completion evaluation (H4).
//
//  The ORDERED evaluator — the implementer is never the sole judge:
//    1 · the mechanical grader /-selected checks;
//    2 · observed effects/evidence versus DECLARED work;
//    3 · the independent reviewer, only where semantic judgment remains;
//    4 · the final mission acceptance projection.
//
//  Hard laws (each proved):
//    · a reviewer statement can NEVER override a failing mechanical grader;
//    · a passing mechanical grader does NOT settle an underspecified
//      semantic requirement (semanticRequired without a reviewer verdict ⇒
//      'indeterminate', never silent acceptance);
//    · incorrect completion CLAIMS are counted separately from ordinary
//      failed attempts;
//    · every verdict names its deciding stage.
//
//  The reviewer seat is the CURRENT strongest review seam (the verification
//  red-team subagent / Counsel) — this module owns only the typed result
//  contract and the composition order, never a provider path.
// ============================================================================

export const MISSION_REVIEW_VERDICTS = ['accept', 'revise', 'reject', 'indeterminate'] as const
export type MissionReviewVerdict = (typeof MISSION_REVIEW_VERDICTS)[number]

export interface MissionReviewResult {
  verdict: MissionReviewVerdict
  requirementIds: string[]
  evidenceRefs: string[]
  /** ONE bounded next action (revise/reject carry it). */
  nextAction: string | null
}

/** Total parse of the reviewer's typed tail line:
 *  `REVIEW: <verdict> [reqs: a,b] [refs: x,y] [next: …]`
 *  Anything unparseable is 'indeterminate' — never a guessed acceptance. */
export function parseReviewResult(text: string): MissionReviewResult {
  const line = text
    .split('\n')
    .reverse()
    .find(l => /^\s*REVIEW:/i.test(l))
  if (!line) return { verdict: 'indeterminate', requirementIds: [], evidenceRefs: [], nextAction: null }
  const verdictMatch = /^\s*REVIEW:\s*(accept|revise|reject|indeterminate)\b/i.exec(line)
  if (!verdictMatch) return { verdict: 'indeterminate', requirementIds: [], evidenceRefs: [], nextAction: null }
  const grab = (key: string): string | null => {
    const m = new RegExp('\\[' + key + ':\\s*([^\\]]+)\\]', 'i').exec(line)
    return m ? m[1].trim() : null
  }
  const list = (raw: string | null): string[] =>
    raw === null ? [] : raw.split(',').map(s => s.trim()).filter(s => s !== '').slice(0, 8)
  return {
    verdict: verdictMatch[1].toLowerCase() as MissionReviewVerdict,
    requirementIds: list(grab('reqs')),
    evidenceRefs: list(grab('refs')),
    nextAction: grab('next'),
  }
}

export interface MissionCompletionInputs {
  /** Stage 1 — the mechanical oracle ('absent' = no grader exists for this
   *  work; graded work always supplies pass/fail). */
  grader: 'pass' | 'fail' | 'absent'
  /** Stage 2 — declared work whose effects were NOT observed (envelope
   *  divergence count from the evidence spine). */
  undeclaredEffectDivergence: number
  /** Does semantic judgment remain after the mechanical stages? */
  semanticRequired: boolean
  /** Stage 3 — the independent reviewer's typed result, when consulted. */
  reviewer: MissionReviewResult | null
  /** The implementer's own success claim (for separate claim accounting). */
  implementerClaimedSuccess: boolean
}

export interface MissionAcceptance {
  state: 'accepted' | 'revise' | 'rejected' | 'indeterminate'
  decidedBy: 'mechanical-grader' | 'evidence-divergence' | 'reviewer' | 'unresolved-semantics'
  /** Counted separately from ordinary failures. */
  incorrectCompletionClaim: boolean
  notes: string[]
}

export function evaluateMissionCompletion(inputs: MissionCompletionInputs): MissionAcceptance {
  const notes: string[] = []

  // 1 · the mechanical grader is FIRST and cannot be overridden upward.
  if (inputs.grader === 'fail') {
    if (inputs.reviewer?.verdict === 'accept') {
      notes.push('reviewer acceptance DISCARDED — a reviewer never overrides a failing mechanical grader')
    }
    return {
      state: 'rejected',
      decidedBy: 'mechanical-grader',
      incorrectCompletionClaim: inputs.implementerClaimedSuccess,
      notes,
    }
  }

  // 2 · declared-but-unobserved work blocks acceptance (prose mints nothing).
  if (inputs.undeclaredEffectDivergence > 0) {
    notes.push(inputs.undeclaredEffectDivergence + ' declared effect(s) without observed evidence')
    return {
      state: 'revise',
      decidedBy: 'evidence-divergence',
      incorrectCompletionClaim: inputs.implementerClaimedSuccess,
      notes,
    }
  }

  // 3 · semantic judgment, only where it remains.
  if (inputs.semanticRequired) {
    if (inputs.reviewer === null) {
      notes.push('semantic requirement present but no reviewer verdict — a passing grader does not settle it')
      return {
        state: 'indeterminate',
        decidedBy: 'unresolved-semantics',
        incorrectCompletionClaim: false,
        notes,
      }
    }
    const map: Record<MissionReviewVerdict, MissionAcceptance['state']> = {
      accept: 'accepted',
      revise: 'revise',
      reject: 'rejected',
      indeterminate: 'indeterminate',
    }
    return {
      state: map[inputs.reviewer.verdict],
      decidedBy: 'reviewer',
      incorrectCompletionClaim:
        inputs.implementerClaimedSuccess && inputs.reviewer.verdict === 'reject',
      notes,
    }
  }

  // 4 · mechanical-only work with a passing (or absent-but-evidenced) oracle.
  if (inputs.grader === 'absent') {
    notes.push('no mechanical grader — acceptance rests on evidence + (optional) review')
    if (inputs.reviewer !== null && inputs.reviewer.verdict !== 'accept') {
      const map: Record<MissionReviewVerdict, MissionAcceptance['state']> = {
        accept: 'accepted',
        revise: 'revise',
        reject: 'rejected',
        indeterminate: 'indeterminate',
      }
      return {
        state: map[inputs.reviewer.verdict],
        decidedBy: 'reviewer',
        incorrectCompletionClaim:
          inputs.implementerClaimedSuccess && inputs.reviewer.verdict === 'reject',
        notes,
      }
    }
  }
  return {
    state: 'accepted',
    decidedBy: 'mechanical-grader',
    incorrectCompletionClaim: false,
    notes,
  }
}
