
export const MISSION_REVIEW_VERDICTS = ['accept', 'revise', 'reject', 'indeterminate'] as const
export type MissionReviewVerdict = (typeof MISSION_REVIEW_VERDICTS)[number]

export interface MissionReviewResult {
  verdict: MissionReviewVerdict
  requirementIds: string[]
  evidenceRefs: string[]
  nextAction: string | null
}

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
  grader: 'pass' | 'fail' | 'absent'
  undeclaredEffectDivergence: number
  semanticRequired: boolean
  reviewer: MissionReviewResult | null
  implementerClaimedSuccess: boolean
}

export interface MissionAcceptance {
  state: 'accepted' | 'revise' | 'rejected' | 'indeterminate'
  decidedBy: 'mechanical-grader' | 'evidence-divergence' | 'reviewer' | 'unresolved-semantics'
  incorrectCompletionClaim: boolean
  notes: string[]
}

export function evaluateMissionCompletion(inputs: MissionCompletionInputs): MissionAcceptance {
  const notes: string[] = []

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

  if (inputs.undeclaredEffectDivergence > 0) {
    notes.push(inputs.undeclaredEffectDivergence + ' declared effect(s) without observed evidence')
    return {
      state: 'revise',
      decidedBy: 'evidence-divergence',
      incorrectCompletionClaim: inputs.implementerClaimedSuccess,
      notes,
    }
  }

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
