
export type DecisionEntry = 'full' | 'ruleSubset'

export type DecisionStageId =
  | 'killSwitch'
  | 'toolDenyRule'
  | 'toolAskRule'
  | 'toolVerdict'
  | 'toolVerdictDeny'
  | 'userInteractionAsk'
  | 'contentAskRule'
  | 'orgAskCeiling'
  | 'safetyCheckAsk'
  | 'bypassPosture'
  | 'toolAllowRule'
  | 'resolution'

export const DECISION_STAGE_ORDER: Record<
  DecisionEntry,
  readonly DecisionStageId[]
> = {
  full: [
    'killSwitch',
    'toolDenyRule',
    'toolAskRule',
    'toolVerdict',
    'toolVerdictDeny',
    'userInteractionAsk',
    'contentAskRule',
    'orgAskCeiling',
    'safetyCheckAsk',
    'bypassPosture',
    'toolAllowRule',
    'resolution',
  ],
  ruleSubset: [
    'toolDenyRule',
    'toolAskRule',
    'toolVerdict',
    'toolVerdictDeny',
    'contentAskRule',
    'orgAskCeiling',
    'safetyCheckAsk',
  ],
} as const

export interface DecisionStageRecord {
  stage: DecisionStageId
  outcome: 'pass' | 'decided'
  note?: string
}

export interface DecisionTrace {
  entry: DecisionEntry
  toolName: string
  mode: string
  stages: DecisionStageRecord[]
  decidedBy: DecisionStageId | 'none'
}

export type WrapperStageId =
  | 'allowDenialReset'
  | 'dontAskConversion'
  | 'autoSafetyImmunity'
  | 'autoUserInteraction'
  | 'autoFloors'
  | 'powershellGuard'
  | 'fastPathDangerFilter'
  | 'acceptEditsFastPath'
  | 'allowlistFastPath'
  | 'classifier'
  | 'denialLimit'
  | 'headlessHooks'
  | 'headlessAutoDeny'

export const WRAPPER_STAGE_ORDER: readonly WrapperStageId[] = [
  'allowDenialReset',
  'dontAskConversion',
  'autoSafetyImmunity',
  'autoUserInteraction',
  'autoFloors',
  'powershellGuard',
  'fastPathDangerFilter',
  'acceptEditsFastPath',
  'allowlistFastPath',
  'classifier',
  'denialLimit',
  'headlessHooks',
  'headlessAutoDeny',
] as const

export interface WrapperStageRecord {
  stage: WrapperStageId
  outcome: 'pass' | 'decided'
  note?: string
}

export interface WrapperTrace {
  stages: WrapperStageRecord[]
  decidedBy: WrapperStageId | 'engine'
}

export function formatDecisionTrace(trace: DecisionTrace): string {
  const walk = trace.stages
    .map(s =>
      s.outcome === 'decided'
        ? `${s.stage.toUpperCase()}${s.note ? `(${s.note})` : ''}`
        : `${s.stage}${s.note ? `(${s.note})` : ''}`,
    )
    .join(' → ')
  return `decision[${trace.entry}] ${trace.toolName} mode=${trace.mode}: ${walk} ⇒ ${trace.decidedBy}`
}
