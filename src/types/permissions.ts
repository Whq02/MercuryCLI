export const EXTERNAL_PERMISSION_MODES = ['default', 'dontAsk', 'implement', 'sovereign'] as const
export const INTERNAL_PERMISSION_MODES = [...EXTERNAL_PERMISSION_MODES, 'flow', 'bubble', 'apollo'] as const
export const PERMISSION_MODES = [...EXTERNAL_PERMISSION_MODES, 'flow', 'apollo'] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]
export type InternalPermissionMode = (typeof INTERNAL_PERMISSION_MODES)[number]
export type PermissionMode = InternalPermissionMode

export type PermissionBehavior = 'allow' | 'deny' | 'ask'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

type SettingsRuleSource = 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
type RuntimeRuleSource = 'cliArg' | 'command' | 'session' | 'toolsNarrowing' | 'mcpServerPolicy'
export type PermissionRuleSource = SettingsRuleSource | RuntimeRuleSource
export type PermissionUpdateDestination = Exclude<SettingsRuleSource, 'flagSettings' | 'policySettings'> | 'session' | 'cliArg'

export type PermissionRuleValue = { toolName: string; ruleContent?: string; reason?: string }
export type PermissionRule = { source: PermissionRuleSource; ruleBehavior: PermissionBehavior; ruleValue: PermissionRuleValue }

type RuleListUpdate<Kind extends string> = Kind extends unknown
  ? { type: Kind; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  : never

export type PermissionUpdate =
  | RuleListUpdate<'addRules' | 'replaceRules' | 'removeRules'>
  | { type: 'setMode'; mode: ExternalPermissionMode; destination: PermissionUpdateDestination }

export type PermissionCommandMetadata = { name: string; description?: string; [key: string]: unknown }
export type PermissionMetadata = { command: PermissionCommandMetadata } | undefined

export type BypassedAskRoad = 'toolAskRule' | 'contentAskRule' | 'orgAskCeiling' | 'safetyCheckAsk'

export const BYPASSED_ASK_ROAD_WORDS: Readonly<Record<BypassedAskRoad, string>> = Object.freeze({
  toolAskRule: 'a tool ask rule',
  contentAskRule: 'an ask rule',
  orgAskCeiling: "the server's ask ceiling",
  safetyCheckAsk: 'the path-safety check',
})

type ReasonPayloads = {
  rule: { rule: PermissionRule }
  mode: { mode: PermissionMode }
  subcommandResults: { reasons: Map<string, PermissionResult> }
  permissionPromptTool: { permissionPromptToolName?: string; toolResult?: unknown }
  hook: { hookName: string; hookSource?: string; reason?: string }
  guard: { guard: string; reason: string }
  asyncAgent: { reason: string }
  workingDir: { reason: string }
  safetyCheck: { reason: string; operatorOnly: boolean }
  other: { reason: string }
  bypassedAsk: { mode: PermissionMode; road: BypassedAskRoad; reason: PermissionDecisionReason }
}

export type PermissionDecisionReason = { [Kind in keyof ReasonPayloads]: { type: Kind } & ReasonPayloads[Kind] }[keyof ReasonPayloads]

type Reasoned = { decisionReason?: PermissionDecisionReason }
type Steered = { suggestions?: PermissionUpdate[]; blockedPath?: string }
type Answered<Behavior extends string, Fields> = { behavior: Behavior } & Fields

export type PermissionAllowDecision<ToolInput = Record<string, unknown>> = Answered<
  'allow',
  Reasoned & { updatedInput?: ToolInput; userModified?: boolean; toolUseID?: string; acceptFeedback?: string; contentBlocks?: unknown[] }
>

export type PermissionAskDecision<ToolInput = Record<string, unknown>> = Answered<
  'ask',
  Reasoned & Steered & { message: string; updatedInput?: ToolInput; metadata?: PermissionMetadata; contentBlocks?: unknown[] }
>

export type PermissionDenyDecision = Answered<'deny', { message: string; decisionReason: PermissionDecisionReason; toolUseID?: string; unanswered?: true }>

export type PermissionDecision<ToolInput = Record<string, unknown>> =
  | PermissionAllowDecision<ToolInput>
  | PermissionAskDecision<ToolInput>
  | PermissionDenyDecision

export type PermissionResult<ToolInput = Record<string, unknown>> =
  | PermissionDecision<ToolInput>
  | Answered<'passthrough', Reasoned & Steered & { message: string }>

export type PermissionExplanation = { risk: RiskLevel; explanation: string; reasoning: string; riskStatement: string }

export type ToolPermissionRulesBySource = Partial<Record<PermissionRuleSource, string[]>>
export type PermissionRuleReasonsBySource = Partial<Record<PermissionRuleSource, Record<string, string>>>

export type ToolPermissionContext = {
  mode: InternalPermissionMode
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  ruleReasons?: PermissionRuleReasonsBySource
  isBypassPermissionsModeAvailable: boolean
  strippedDangerousRules?: string[]
  shouldAvoidPermissionPrompts?: boolean
  awaitAutomatedChecksBeforeDialog?: boolean
}
