// ============================================================================
//  src/types/permissions.ts — the permission vocabulary.
//
//  A pure type/constant module with NO runtime dependencies; it exists to
//  break import cycles (the permission engine, tools, dialogs and settings
//  all meet here). Wire spellings in this file are contract data.
//  Proof-locked: prove-carousel.ts pins the internal-mode union.
// ============================================================================

/**
 * The externally visible permission modes — what persistence, the SDK and
 * remote session metadata carry (contract data; declared alphabetically).
 * Internal-only modes are projected onto these before crossing a boundary.
 *
 * Mode identity: the ids are Mercury's own —
 * `strategy` (Strategy Mode), `implement` (Implement Mode), `flow` (Flow),
 * `sovereign` (Sovereign Mode). The retired external spellings decode
 * through {@link decodePermissionModeSpelling} at read boundaries only.
 */
export const EXTERNAL_PERMISSION_MODES = [
  'default',
  'dontAsk',
  'implement',
  'sovereign',
  'strategy',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

/**
 * Every mode the runtime can hold, internal ones included.
 * - `flow` is functional (its classifier path is live) and user-addressable.
 * - `bubble` projects externally to default.
 * - `autopilot` is a bypass-permission posture with self-serve tier control,
 *   reachable only when sovereign itself is reachable — never a consent
 *   backdoor. External projection: sovereign, so persistence and the SDK
 *   see its true posture.
 * - `apollo` is the pre-flight interview station (operator decision
 * permission-wise an ask-first posture exactly like default —
 *   its substance is the interview prompt pack, which rides ONLY the main
 *   REPL agent's prompt builds. External projection: default.
 */
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

/** The mode type consumers pass around (alias of the internal union). */
export type PermissionMode = InternalPermissionMode

/**
 * Runtime validation list: the USER-ADDRESSABLE modes — the five external
 * ones plus flow, autopilot and apollo (not bubble). Gates settings
 * default-mode values, the --permission-mode flag, and conversation
 * recovery. Entry to autopilot remains separately guarded; membership here
 * is shape validation only.
 */
export const PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'flow',
  'autopilot',
  'apollo',
] as const

/** Alias of the same list, kept for importers that expect this name. */
export const VALID_PERMISSION_MODES = PERMISSION_MODES

/**
 * THE bounded mode-spelling alias (the flagRegistry bounded-alias
 * pattern): the retired external mode ids mapped to
 * their Mercury replacements. Old spellings exist on disk (settings files,
 * session records, daemon/teammate records), in caller muscle memory
 * (`--permission-mode acceptEdits`, SDK options) and — permanently — in the
 * `.claude/` compatibility estate, so every READ boundary decodes through
 * {@link decodePermissionModeSpelling}; writers emit ONLY the new ids. This
 * table is the ONE place a retired spelling may appear in source.
 */
export const RETIRED_PERMISSION_MODE_SPELLINGS: Readonly<Record<string, PermissionMode>> = {
  acceptEdits: 'implement',
  auto: 'flow',
  bypassPermissions: 'sovereign',
  plan: 'strategy',
  // The retired two-seat coordination mode was permission-inert (external
  // projection: default); a persisted record still reads.
  scribe: 'default',
}

/**
 * Decode ONE mode spelling at a read boundary: a retired spelling maps to
 * its Mercury id, anything else passes through untouched (validation stays
 * the caller's job, exactly as before). Total and allocation-free — safe in
 * zod preprocess, argument parsers and hot read paths.
 */
export function decodePermissionModeSpelling(raw: string): string {
  return RETIRED_PERMISSION_MODE_SPELLINGS[raw] ?? raw
}

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/**
 * Where a permission rule can come from: the five settings sources, the
 * command line, a command, the session — plus two RUNTIME-DERIVED sources
 * honoured by the engine but not editable update destinations:
 * `toolsNarrowing` (synthesised from the active tools-narrowing set) and
 * `mcpServerPolicy` (MCP server policy and trust gating). All ten spellings
 * are contract data — they key the per-source rule maps.
 */
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

/** A rule's content: the tool it names and an optional argument pattern. */
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

/**
 * The additional-working-directory source — a distinct alias of the rule
 * sources, kept separate for semantic clarity and possible future
 * divergence.
 */
export type WorkingDirectorySource = PermissionRuleSource

export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

/** The three writable settings sources plus session and cliArg. */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/** Permission updates, discriminated by `type` (six members). */
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

/**
 * Minimal command metadata for permission dialogs. Deliberately carries an
 * index signature for forward compatibility rather than importing the full
 * command type — another cycle break (the index signature is the spec'd
 * design here, not an escape hatch).
 */
export type PermissionCommandMetadata = {
  name: string
  description?: string
  [key: string]: unknown
}

/** Decision metadata: a command wrapper, or nothing. */
export type PermissionMetadata = { command: PermissionCommandMetadata } | undefined

/**
 * Why a decision was reached (eleven members, discriminated by `type`).
 * `safetyCheck.classifierApprovable` is REQUIRED: true for sensitive-path
 * cases where a classifier can see context and decide; false for
 * path-bypass attempts and cross-machine bridge messages.
 */
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

/**
 * A pending allow-classifier check attached to an ask: the classifier runs
 * asynchronously and may auto-approve before the user answers.
 */
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
  /**
   * The ask came from a shell-safety check for patterns the legacy command
   * splitter could misparse (line continuations, quote transformations);
   * it blocks BEFORE the splitter transforms the command. Explicitly
   * not set for simple newline-joined compounds.
   */
  isBashSecurityCheckForMisparsing?: boolean
  pendingClassifierCheck?: PendingClassifierCheck
  /** Content blocks (e.g. pasted images) shown beside the rejection message. */
  contentBlocks?: unknown[]
}

/** Deny is not generic and requires both its message and its reason. */
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

/**
 * A permission RESULT additionally allows passthrough. Passthrough carries a
 * required message plus only four optionals — it deliberately does NOT
 * carry the metadata, content blocks or shell-misparse marker the ask
 * decision has; do not widen it to match.
 */
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

/** A generic classifier verdict. */
export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason?: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

/** Token counters for one classifier call. */
export type ClassifierUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/** Per-stage telemetry for the two-stage permissive-mode classifier. */
export type YoloClassifierStageTelemetry = {
  usage?: ClassifierUsage
  durationMs?: number
  requestId?: string
  messageId?: string
}

/**
 * The permissive-mode ("yolo") classifier result.
 * - `retryable`: the classifier responded but its output did not parse —
 *   sampling noise, not a policy verdict and not an availability failure;
 *   the caller re-asks the same model once before letting a fail-closed
 *   block stand. Carries real usage; must NOT enter the availability
 *   ladder.
 * - `transcriptTooLong`: the request exceeded the context window —
 *   deterministic; fall back to normal prompting rather than retry.
 */
export type YoloClassifierResult = {
  shouldBlock: boolean
  reason: string
  model: string
  /** Model reasoning text extracted from the thinking stage, when present. */
  thinking?: string
  unavailable?: boolean
  retryable?: boolean
  transcriptTooLong?: boolean
  usage?: ClassifierUsage
  durationMs?: number
  /** Prompt component lengths, for overhead analysis. */
  promptComponentLengths?: Record<string, number>
  /** Path of the error dump written on a failure, when one was written. */
  errorDumpPath?: string
  /** Which stage decided. */
  stage?: 'fast' | 'thinking'
  fastStage?: YoloClassifierStageTelemetry
  thinkingStage?: YoloClassifierStageTelemetry
}

/** Risk levels are upper-case, unlike every other union in this module. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  risk: RiskLevel
  explanation: string
  reasoning: string
  riskStatement: string
}

/** Per-source rule maps (keyed by rule source; missing key = no rules). */
export type ToolPermissionRulesBySource = {
  [K in PermissionRuleSource]?: string[]
}

/**
 * The tool permission context carried through a turn. The runtime's
 * deeply-readonly declaration lives beside the tool contract; this is the
 * cycle-breaking vocabulary form.
 */
export type ToolPermissionContext = {
  mode: InternalPermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  /** Dangerous blanket-allow rules stripped by the auto-mode posture. */
  strippedDangerousRules?: string[]
  /** Background agents that cannot show UI auto-deny prompts. */
  shouldAvoidPermissionPrompts?: boolean
  /** Coordinator workers await automated checks before showing the dialog. */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** The mode in force before entering strategy mode (field name predates the
   *  mode-identity migration; the VALUES it carries are new-id). */
  prePlanMode?: InternalPermissionMode
}
