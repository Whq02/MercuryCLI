
export const EXTERNAL_PERMISSION_MODES = [
  'default',
  'dontAsk',
  'implement',
  'sovereign',
  'strategy',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

export type InternalPermissionMode =
  | ExternalPermissionMode
  | 'flow'
  | 'bubble'
  | 'autopilot'
  | 'apollo'

export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'flow',
  'bubble',
  'autopilot',
  'apollo',
] as const satisfies readonly InternalPermissionMode[]

export type PermissionMode = InternalPermissionMode

export const PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'flow',
  'autopilot',
  'apollo',
] as const

export const VALID_PERMISSION_MODES = PERMISSION_MODES

export const RETIRED_PERMISSION_MODE_SPELLINGS: Readonly<Record<string, PermissionMode>> = {
  acceptEdits: 'implement',
  auto: 'flow',
  bypassPermissions: 'sovereign',
  plan: 'strategy',
  scribe: 'default',
}

export function decodePermissionModeSpelling(raw: string): string {
  return RETIRED_PERMISSION_MODE_SPELLINGS[raw] ?? raw
}

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'
  | 'toolsNarrowing'
  | 'mcpServerPolicy'

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

export type WorkingDirectorySource = PermissionRuleSource

export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export type PermissionUpdate =
  | {
      type: 'addRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'replaceRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeRules'
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
      destination: PermissionUpdateDestination
    }
  | {
      type: 'setMode'
      mode: ExternalPermissionMode
      destination: PermissionUpdateDestination
    }
  | {
      type: 'addDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }
  | {
      type: 'removeDirectories'
      directories: string[]
      destination: PermissionUpdateDestination
    }

export type PermissionCommandMetadata = {
  name: string
  description?: string
  [key: string]: unknown
}

export type PermissionMetadata = { command: PermissionCommandMetadata } | undefined

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'subcommandResults'; reasons: Map<string, PermissionResult> }
  | { type: 'permissionPromptTool'; permissionPromptToolName?: string; toolResult?: unknown }
  | { type: 'hook'; hookName: string; hookSource?: string; reason?: string }
  | { type: 'asyncAgent'; reason: string }
  | { type: 'sandboxOverride'; reason: 'excludedCommand' | 'sandboxDisabled' }
  | { type: 'classifier'; classifier: string; reason?: string }
  | { type: 'workingDir'; reason: string }
  | { type: 'safetyCheck'; reason: string; classifierApprovable: boolean }
  | { type: 'other'; reason: string }

export type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}

export type PermissionAllowDecision<
  ToolInput = Record<string, unknown>,
> = {
  behavior: 'allow'
  updatedInput?: ToolInput
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
  contentBlocks?: unknown[]
}

export type PermissionAskDecision<
  ToolInput = Record<string, unknown>,
> = {
  behavior: 'ask'
  message: string
  updatedInput?: ToolInput
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  isBashSecurityCheckForMisparsing?: boolean
  pendingClassifierCheck?: PendingClassifierCheck
  contentBlocks?: unknown[]
}

export type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

export type PermissionDecision<ToolInput = Record<string, unknown>> =
  | PermissionAllowDecision<ToolInput>
  | PermissionAskDecision<ToolInput>
  | PermissionDenyDecision

export type PermissionResult<ToolInput = Record<string, unknown>> =
  | PermissionDecision<ToolInput>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecisionReason
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      pendingClassifierCheck?: PendingClassifierCheck
    }

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason?: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export type ClassifierUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export type YoloClassifierStageTelemetry = {
  usage?: ClassifierUsage
  durationMs?: number
  requestId?: string
  messageId?: string
}

export type YoloClassifierResult = {
  shouldBlock: boolean
  reason: string
  model: string
  thinking?: string
  unavailable?: boolean
  retryable?: boolean
  transcriptTooLong?: boolean
  usage?: ClassifierUsage
  durationMs?: number
  promptComponentLengths?: Record<string, number>
  errorDumpPath?: string
  stage?: 'fast' | 'thinking'
  fastStage?: YoloClassifierStageTelemetry
  thinkingStage?: YoloClassifierStageTelemetry
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  risk: RiskLevel
  explanation: string
  reasoning: string
  riskStatement: string
}

export type ToolPermissionRulesBySource = {
  [K in PermissionRuleSource]?: string[]
}

export type ToolPermissionContext = {
  mode: InternalPermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  strippedDangerousRules?: string[]
  shouldAvoidPermissionPrompts?: boolean
  awaitAutomatedChecksBeforeDialog?: boolean
  prePlanMode?: InternalPermissionMode
}
