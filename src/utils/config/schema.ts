import type { EffortLevel } from '../effortLadder.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import type { BillingType } from '../../services/oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'

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

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ProjectConfig = {
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  permissionPosture?: {
    mode: 'bypass' | 'standard'
    armedBy?: 'env-standing-consent' | 'cli-flag' | 'session-choice'
    consentDialog: 'shown-accepted' | 'suppressed-by-standing-consent' | 'not-required'
    trustDialogAccepted: boolean
    recordedAtMs: number
  }
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
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastUnpricedTurns?: Record<string, number>
  lastWorkloadUsage?: Record<
    string,
    Record<
      string,
      {
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens: number
        cacheCreationInputTokens: number
        webSearchRequests: number
        costUSD: number
      }
    >
  >
  lastWorkloadUnpricedTurns?: Record<string, Record<string, number>>
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasExternalIncludesApproved?: boolean
  hasExternalIncludesWarningShown?: boolean
  disabledMcpServers?: string[]
  enabledMcpServers?: string[]
  skillStates?: Record<string, 'off' | 'invocable'>
  extensionStates?: Record<string, 'off'>
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpServers: {},
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasExternalIncludesApproved: false,
  hasExternalIncludesWarningShown: false,
}

export {
  EDITOR_MODES,
} from '../configConstants.js'

import type { EDITOR_MODES } from '../configConstants.js'

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

export type GlobalConfig = {
  projects?: Record<string, ProjectConfig>
  numStartups: number
  headlessActivity?: {
    print: number
    sdk: number
    verbs: Record<string, number>
    lastKind: string
    lastAt: number
  }
  harnessProfilePin?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  kitPresets?: Record<string, { mcpOff: string[]; skillStates: Record<string, 'off' | 'invocable'>; extensionsOff: string[] }>
  claudeAiMcpEverConnected?: string[]
  concourseCoordinator?: {
    mode?: 'off' | 'rules-only' | 'agent-assisted'
    assistModel?: string
    effort?: string
  }
  motion?: 'auto' | 'full' | 'reduced' | 'off'
  jev?: {
    enabled?: boolean
    road?: 'official' | 'openrouter'
    openrouterAllowanceUsd?: number
    allowanceUsd?: number
    pacePerMinute?: number
    requestCeiling?: number
    subagents?: boolean
  }
  supervisorEnabled?: boolean
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
  switchboardCapacity?: {
    askedAt?: number
    allowed?: boolean
    recommendedSeats?: number
    operatorSeats?: number
  }
  hasSeenCoordinatorOffHint?: boolean
  responseProfile?: 'balanced' | 'concise'
  toolOutput: 'compact' | 'full'
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string
  hasAcknowledgedCostThreshold?: boolean
  oauthAccount?: AccountInfo
  anthropicPreferredSource?: 'subscription' | 'api-key'
  editorMode?: EditorMode
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean
  autoCompactWindow?: number
  localModelWindows?: { [model: string]: 'server' | 'max' | number }
  localModelBatch?: { [model: string]: number }
  showTurnDuration: boolean
  hasSeenTasksHint?: boolean
  hasUsedStash?: boolean
  hasUsedBackgroundTask?: boolean
  expandedView?: 'none' | 'tasks' | 'crewmates'
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string
  appleTerminalBackupPath?: string
  appleTerminalSetupInProgress?: boolean

  shiftEnterKeyBindingInstalled?: boolean
  optionAsMetaKeyInstalled?: boolean

  tipsHistory: {
    [tipId: string]: number
  }

  defaultProvider?: string
  concourseEnabled?: boolean
  defaultCritter?: string

  voiceNoticeSeenCount?: number
  voiceLangHintShownCount?: number
  voiceLangHintLastLanguage?: string
  voiceFooterHintSeenCount?: number

  promptQueueUseCount: number


  showExpandedTasks?: boolean
  showSpinnerTree?: boolean

  firstStartTime?: string

  fileCheckpointingEnabled: boolean

  terminalProgressBarEnabled: boolean

  remoteDialogSeen?: boolean

  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  copyFullResponse: boolean

  copyOnSelect?: boolean

  mouseCapture?: boolean

  githubRepoPaths?: Record<string, string[]>

  iterm2It2SetupComplete?: boolean

  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>

  lspRecommendationIgnoredCount?: number

  permissionExplainerEnabled?: boolean

  crewmateDefaultModel?: string | null

  agents?: {
    defaultEffort?: EffortLevel
    defaultModel?: string
    maxConcurrent?: number
  }

  prStatusFooterEnabled?: boolean

  voiceInputEnabled?: boolean

  voiceTranscriber?: string

  remoteControlAtStartup?: boolean

  launchEffortUnpins?: {
    opus47?: boolean
    opus48?: boolean
    fable5?: boolean
    fable51?: boolean
    opus55?: boolean
    sonnet55?: boolean
  }

  compatProvider?: {
    baseUrl?: string
    label?: string
    models?: string[]
  }

  migrationVersion?: number
}

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
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    tipsHistory: {},
    promptQueueUseCount: 0,
    showExpandedTasks: false,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

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
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
  'harnessProfilePin',
  'agents',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}
