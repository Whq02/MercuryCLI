import type { EffortLevel } from '../effortLadder.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import type { BillingType } from '../../services/oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'
import type { EDITOR_MODES } from '../configConstants.js'

export { EDITOR_MODES } from '../configConstants.js'

export type PastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
  contentHash?: string
  mediaType?: string
  filename?: string
  dimensions?: ImageDimensions
  sourcePath?: string
}

export type SerializedStructuredHistoryEntry = {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}

export type HistoryEntry = {
  display: string
  pastedContents: Record<number, PastedContent>
}

type UsageFigures = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
}

type LastSessionFigure =
  | 'lastAPIDuration'
  | 'lastAPIDurationWithoutRetries'
  | 'lastToolDuration'
  | 'lastCost'
  | 'lastDuration'
  | 'lastLinesAdded'
  | 'lastLinesRemoved'
  | 'lastTotalInputTokens'
  | 'lastTotalOutputTokens'
  | 'lastTotalCacheCreationInputTokens'
  | 'lastTotalCacheReadInputTokens'
  | 'lastTotalWebSearchRequests'
  | 'lastFpsAverage'
  | 'lastFpsLow1Pct'

type LastSession = Partial<Record<LastSessionFigure, number>> & {
  lastSessionId?: string
  lastCostWindow?: {
    kind: 'session-cumulative'
    sessionId?: string
    savedAtMs: number
  }
  lastSessionMetricsWindow?: {
    kind: 'process-leg'
    pid: number
    savedAtMs: number
  }
  lastModelUsage?: Record<string, UsageFigures>
  lastUnpricedTurns?: Record<string, number>
  lastWorkloadUsage?: Record<string, Record<string, UsageFigures>>
  lastWorkloadUnpricedTurns?: Record<string, Record<string, number>>
  lastSessionMetrics?: Record<string, number>
}

type ProjectPosture = {
  permissionPosture?: {
    mode: 'bypass' | 'standard'
    armedBy?: 'env-standing-consent' | 'cli-flag' | 'session-choice'
    consentDialog: 'shown-accepted' | 'suppressed-by-standing-consent' | 'not-required'
    trustDialogAccepted: boolean
    recordedAtMs: number
  }
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasExternalIncludesApproved?: boolean
  hasExternalIncludesWarningShown?: boolean
}

type ProjectKit = {
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  disabledMcpServers?: string[]
  enabledMcpServers?: string[]
  skillStates?: Record<string, 'off' | 'invocable'>
  extensionStates?: Record<string, 'off'>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
  }
}

export type ProjectConfig = ProjectKit & ProjectPosture & LastSession

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpServers: {},
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasExternalIncludesApproved: false,
  hasExternalIncludesWarningShown: false,
}

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  displayName?: string
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

type BootRecord = {
  numStartups: number
  headlessActivity?: {
    print: number
    sdk: number
    verbs: Record<string, number>
    lastKind: string
    lastAt: number
  }
  firstStartTime?: string
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  tipsHistory: { [tipId: string]: number }
  projects?: Record<string, ProjectConfig>
}

type Appearance = {
  theme: ThemeSetting
  motion?: 'auto' | 'full' | 'reduced' | 'off'
  toolOutput: 'compact' | 'full'
  expandedView?: 'none' | 'tasks'
  showTurnDuration: boolean
  showExpandedTasks?: boolean
  defaultCritter?: string
  editorMode?: EditorMode
  copyFullResponse: boolean
  copyOnSelect?: boolean
  mouseCapture?: boolean
  terminalProgressBarEnabled: boolean
}

type Credentials = {
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string
  anthropicApiKeyWorkspace?: { keyFingerprint: string; workspaceId: string }
  hasAcknowledgedCostThreshold?: boolean
  oauthAccount?: AccountInfo
  anthropicPreferredSource?: 'subscription' | 'api-key'
  defaultProvider?: string
  compatProvider?: import('../settings/compatProvider.js').CompatProviderSettings
  videoProvider?: import('../../services/video/types.js').VideoProviderSettings
}

type Servers = {
  mcpServers?: Record<string, McpServerConfig>
  kitPresets?: Record<string, { mcpOff: string[]; skillStates: Record<string, 'off' | 'invocable'>; extensionsOff: string[] }>
  claudeAiMcpEverConnected?: string[]
}

type Concourse = {
  concourseEnabled?: boolean
  concourseCoordinator?: {
    mode?: 'off' | 'rules-only' | 'agent-assisted'
    assistModel?: string
    effort?: string
  }
  switchboardCapacity?: {
    askedAt?: number
    allowed?: boolean
    recommendedSeats?: number
    operatorSeats?: number
  }
  hasSeenCoordinatorOffHint?: boolean
  backgroundSessionsLaunchCrewmates?: boolean
}

type ModelChoices = {
  duckduckgoScraping?: boolean
  responseProfile?: 'balanced' | 'concise'
  jev?: {
    enabled?: boolean
    road?: 'official' | 'openrouter'
    openrouterAllowanceUsd?: number
    allowanceUsd?: number
    pacePerMinute?: number
    requestCeiling?: number
    subagents?: boolean
  }
  advisor?: {
    enabled?: boolean
    minutes?: number
  }
  subModels?: {
    console?: string
    advisor?: string
    effort?: {
      console?: string
      advisor?: string
    }
  }
  agents?: {
    defaultEffort?: EffortLevel
    defaultModel?: string
    maxConcurrent?: number
  }
  launchEffortUnpins?: {
    opus47?: boolean
    opus48?: boolean
    fable5?: boolean
    fable51?: boolean
    opus55?: boolean
    sonnet55?: boolean
  }
  autoCompactEnabled: boolean
  autoCompactWindow?: number
  localModelWindows?: { [model: string]: 'server' | 'max' | number }
  localModelBatch?: { [model: string]: number }
  fileCheckpointingEnabled: boolean
  permissionExplainerEnabled?: boolean
  prStatusFooterEnabled?: boolean
  lspRecommendationIgnoredCount?: number
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  githubRepoPaths?: Record<string, string[]>
}

type Hints = {
  hasUsedBackslashReturn?: boolean
  hasSeenTasksHint?: boolean
  hasUsedStash?: boolean
  hasUsedBackgroundTask?: boolean
  promptQueueUseCount: number
}

type TerminalSetup = {
  appleTerminalBackupPath?: string
  appleTerminalSetupInProgress?: boolean
  shiftEnterKeyBindingInstalled?: boolean
  optionAsMetaKeyInstalled?: boolean
}

type Voice = {
  voiceInputEnabled?: boolean
  voiceNoticeSeenCount?: number
  voiceLangHintShownCount?: number
  voiceLangHintLastLanguage?: string
  voiceFooterHintSeenCount?: number
}

type Bridge = {
  remoteDialogSeen?: boolean
  remoteControlAtStartup?: boolean
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number
}

export type GlobalConfig = BootRecord &
  Appearance &
  Credentials &
  Servers &
  Concourse &
  ModelChoices &
  Hints &
  TerminalSetup &
  Voice &
  Bridge

export function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    theme: DEFAULT_THEME_SETTING,
    toolOutput: 'compact',
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    expandedView: 'none',
    customApiKeyResponses: { approved: [], rejected: [] },
    tipsHistory: {},
    promptQueueUseCount: 0,
    showExpandedTasks: false,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

const keyGuard = <Key extends string>(keys: readonly Key[]) => {
  const known: ReadonlySet<string> = new Set(keys)
  return (key: string): key is Key => known.has(key)
}

export const GLOBAL_CONFIG_KEYS = [
  'theme',
  'toolOutput',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'tipsHistory',
  'showExpandedTasks',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'mouseCapture',
  'defaultCritter',
  'defaultProvider',
  'concourseEnabled',
  'backgroundSessionsLaunchCrewmates',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
  'agents',
] as const satisfies readonly (keyof GlobalConfig)[]

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]
export const isGlobalConfigKey = keyGuard(GLOBAL_CONFIG_KEYS)

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const satisfies readonly (keyof ProjectConfig)[]

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]
export const isProjectConfigKey = keyGuard(PROJECT_CONFIG_KEYS)
