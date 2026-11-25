import type { EffortLevel } from '../../models/effort/effortLadder.js'
import type { McpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { BillingType } from '../../models/sign-in/oauth-shapes/types.js'
import type { ImageDimensions } from '../images/imageResizer.js'
import type { CompatProviderSettings } from '../settings/compatProvider.js'
import { DEFAULT_THEME_SETTING } from '../../screen/theme/systemTheme.js'
import type { ThemeSetting } from '../../screen/theme/theme.js'
import type { VideoProviderSettings } from '../../integrations/video-shapes/types.js'
import type { EDITOR_MODES } from '../settings/configConstants.js'

export { EDITOR_MODES } from '../settings/configConstants.js'

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
export type HistoryEntry = {
  display: string
  pastedContents: Record<number, PastedContent>
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

type UsageFigures = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
}

type SkillStates = Record<string, 'off' | 'invocable'>

type ProjectRecord = {
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  enabledMcpServers?: string[]
  disabledMcpServers?: string[]
  skillStates?: SkillStates
  extensionStates?: Record<string, 'off'>
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasExternalIncludesApproved?: boolean
  hasExternalIncludesWarningShown?: boolean
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
  }
  permissionPosture?: {
    mode: 'bypass' | 'standard'
    consentDialog: 'shown-accepted' | 'suppressed-by-standing-consent' | 'not-required'
    trustDialogAccepted: boolean
    recordedAtMs: number
    armedBy?: 'env-standing-consent' | 'cli-flag' | 'session-choice'
  }
}

type LastSessionRecord = { [Figure in LastSessionFigure]?: number } & {
  lastSessionId?: string
  lastCostWindow?: { kind: 'session-cumulative'; savedAtMs: number; sessionId?: string }
  lastSessionMetricsWindow?: { kind: 'process-leg'; pid: number; savedAtMs: number }
  lastModelUsage?: Record<string, UsageFigures>
  lastUnpricedTurns?: Record<string, number>
  lastWorkloadUsage?: Record<string, Record<string, UsageFigures>>
  lastWorkloadUnpricedTurns?: Record<string, Record<string, number>>
  lastSessionMetrics?: Record<string, number>
}

export type ProjectConfig = ProjectRecord & LastSessionRecord

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
  firstStartTime?: string
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  fileCheckpointingEnabled: boolean
  hasHomeTrustDialogAccepted?: boolean
  projects?: Record<string, ProjectConfig>
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  headlessActivity?: {
    print: number
    sdk: number
    verbs: Record<string, number>
    lastKind: string
    lastAt: number
  }
}

type Appearance = {
  theme: ThemeSetting
  toolOutput: 'compact' | 'full'
  editorMode?: EditorMode
  motion?: 'auto' | 'full' | 'reduced' | 'off'
  mouseCapture?: boolean
  copyOnSelect?: boolean
  defaultCritter?: string
  expandedView?: 'none' | 'tasks'
  showExpandedTasks?: boolean
  showTurnDuration: boolean
  prStatusFooterEnabled?: boolean
  terminalProgressBarEnabled: boolean
}

type Credentials = {
  primaryApiKey?: string
  oauthAccount?: AccountInfo
  anthropicPreferredSource?: 'subscription' | 'api-key'
  anthropicApiKeyWorkspace?: {
    keyFingerprint: string
    workspaceId: string
  }
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
}

type Servers = {
  mcpServers?: Record<string, McpServerConfig>
  claudeAiMcpEverConnected?: string[]
  githubRepoPaths?: Record<string, string[]>
  kitPresets?: Record<string, { mcpOff: string[]; skillStates: SkillStates; extensionsOff: string[] }>
  inheritedSkillsOff?: string[]
  duckduckgoScraping?: boolean
}

type Concourse = {
  concourseEnabled?: boolean
  switchboardCapacity?: {
    askedAt?: number
    allowed?: boolean
    recommendedSeats?: number
    operatorSeats?: number
  }
  backgroundSessionsLaunchCrewmates?: boolean
}

type ModelChoices = {
  defaultProvider?: string
  compatProvider?: CompatProviderSettings
  videoProvider?: VideoProviderSettings
  responseProfile?: 'balanced' | 'concise'
  autoCompactEnabled: boolean
  autoCompactWindow?: number
  localModelBatch?: Record<string, number>
  localModelWindows?: Record<string, 'server' | 'max' | number>
  agents?: {
    defaultEffort?: EffortLevel
    defaultModel?: string
    maxConcurrent?: number
  }
  advisor?: {
    enabled?: boolean
    minutes?: number
  }
  subModels?: {
    advisor?: string
    effort?: { advisor?: string }
  }
  helperModel?: {
    size?: 'off' | '2b' | '4b' | 'session'
    compaction?: boolean
  }
  jev?: {
    enabled?: boolean
    subagents?: boolean
    road?: 'official' | 'openrouter'
    openrouterAllowanceUsd?: number
    allowanceUsd?: number
    pacePerMinute?: number
    requestCeiling?: number
  }
  launchEffortUnpins?: {
    opus47?: boolean
    opus48?: boolean
    fable5?: boolean
    fable51?: boolean
    fable52?: boolean
    opus55?: boolean
    sonnet55?: boolean
  }
}

type Hints = {
  tipsHistory: Record<string, number>
  hasSeenTasksHint?: boolean
  hasUsedStash?: boolean
  hasUsedBackslashReturn?: boolean
  hasAcknowledgedCostThreshold?: boolean
  permissionExplainerEnabled?: boolean
}

type TerminalSetup = {
  shiftEnterKeyBindingInstalled?: boolean
  optionAsMetaKeyInstalled?: boolean
  appleTerminalSetupInProgress?: boolean
  appleTerminalBackupPath?: string
  terminalChecksContinued?: Record<string, true>
}

type Voice = {
  voiceInputEnabled?: boolean
}

type Bridge = {
  remoteControlAtStartup?: boolean
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
    expandedView: 'none',
    customApiKeyResponses: { approved: [], rejected: [] },
    tipsHistory: {},
    showExpandedTasks: false,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

const keyGuard = <Key extends string>(keys: readonly Key[]): ((key: string) => key is Key) => {
  const names = new Set<string>(keys)
  return (key): key is Key => names.has(key)
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
  'copyOnSelect',
  'mouseCapture',
  'defaultCritter',
  'defaultProvider',
  'concourseEnabled',
  'backgroundSessionsLaunchCrewmates',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'agents',
] as const satisfies readonly (keyof GlobalConfig)[]

export const isGlobalConfigKey = keyGuard(GLOBAL_CONFIG_KEYS)
