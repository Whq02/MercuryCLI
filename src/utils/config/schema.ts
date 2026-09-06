import type { McpServerConfig } from '../../services/mcp/types.js'
import type { BillingType } from '../../services/oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import type { ModelOption } from '../model/modelOptions.js'
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'

export type PastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
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
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasExternalIncludesApproved?: boolean
  hasExternalIncludesWarningShown?: boolean
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
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
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasExternalIncludesApproved: false,
  hasExternalIncludesWarningShown: false,
}

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from '../configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from '../configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

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

export type DiffTool = 'terminal' | 'auto'

export type GlobalConfig = {
  apiKeyHelper?: string
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
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  kitPresets?: Record<string, { mcpOff: string[]; skillStates: Record<string, 'off' | 'invocable'>; extensionsOff: string[] }>
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  concourseHostSignals?: {
    started?: boolean
    needsYou?: boolean
    readyToReview?: boolean
    settled?: boolean
    detailedPreview?: boolean
  }
  concourseCoordinator?: {
    mode?: 'off' | 'rules-only' | 'agent-assisted'
    assistModel?: string
    effort?: string
  }
  supervisorEnabled?: boolean
  pingsBell?: boolean
  subModels?: {
    minerva?: string
    console?: string
    effort?: {
      minerva?: string
      console?: string
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
  showTurnDuration: boolean
  env: { [key: string]: string }
  hasSeenTasksHint?: boolean
  hasUsedStash?: boolean
  hasUsedBackgroundTask?: boolean
  expandedView?: 'none' | 'tasks' | 'teammates'
  diffTool?: DiffTool
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string
  appleTerminalBackupPath?: string
  appleTerminalSetupInProgress?: boolean

  shiftEnterKeyBindingInstalled?: boolean
  optionAsMetaKeyInstalled?: boolean

  autoConnectIde?: boolean
  autoInstallIdeExtension?: boolean

  hasIdeOnboardingBeenShown?: Record<string, boolean>
  ideHintShownCount?: number
  hasIdeAutoConnectDialogBeenShown?: boolean

  tipsHistory: {
    [tipId: string]: number
  }

  companionEnabled?: boolean
  defaultProvider?: string
  concourseEnabled?: boolean
  defaultCritter?: string

  voiceNoticeSeenCount?: number
  voiceLangHintShownCount?: number
  voiceLangHintLastLanguage?: string
  voiceFooterHintSeenCount?: number

  promptQueueUseCount: number

  lastStrategyModeUse?: number

  subscriptionNoticeCount?: number
  hasAvailableSubscription?: boolean

  showExpandedTasks?: boolean
  showSpinnerTree?: boolean

  firstStartTime?: string

  messageIdleNotifThresholdMs: number

  fileCheckpointingEnabled: boolean

  terminalProgressBarEnabled: boolean

  showStatusInTerminalTab?: boolean

  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  remoteDialogSeen?: boolean

  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  idleReturnDismissed?: boolean

  respectGitignore: boolean

  copyFullResponse: boolean

  copyOnSelect?: boolean

  mouseCapture?: boolean

  githubRepoPaths?: Record<string, string[]>

  iterm2It2SetupComplete?: boolean
  preferTmuxOverIterm2?: boolean

  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>

  lspRecommendationIgnoredCount?: number

  permissionExplainerEnabled?: boolean

  teammateMode?: 'auto' | 'tmux' | 'in-process'
  teammateDefaultModel?: string | null

  prStatusFooterEnabled?: boolean

  voiceInputEnabled?: boolean

  startupPrefetchedAt?: number

  remoteControlAtStartup?: boolean

  clientDataCache?: Record<string, unknown> | null

  launchEffortUnpins?: {
    opus47?: boolean
    opus48?: boolean
    fable5?: boolean
    fable51?: boolean
  }

  additionalModelOptionsCache?: ModelOption[]

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
    preferredNotifChannel: 'auto',
    toolOutput: 'compact',
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    expandedView: 'none',
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    promptQueueUseCount: 0,
    showExpandedTasks: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'theme',
  'toolOutput',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'showExpandedTasks',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
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
