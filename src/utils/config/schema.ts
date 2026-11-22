import type { EffortLevel } from '../effortLadder.js'
import type { McpServerConfig } from '../mcp/types.js'
import type { BillingType } from '../oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'
import type { EDITOR_MODES } from '../configConstants.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export { EDITOR_MODES } from '../configConstants.js'

export type PastedContent = Unbuilt

export type SerializedStructuredHistoryEntry = Unbuilt

export type HistoryEntry = Unbuilt

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

export type ProjectConfig = Unbuilt

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpServers: {},
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasExternalIncludesApproved: false,
  hasExternalIncludesWarningShown: false,
}

export type AccountInfo = Unbuilt

export type EditorMode = Unbuilt

type BootRecord = Unbuilt

type Appearance = Unbuilt

type Credentials = Unbuilt

type Servers = Unbuilt

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

type ModelChoices = Unbuilt

type Hints = Unbuilt

type TerminalSetup = Unbuilt

type Voice = Unbuilt

type Bridge = Unbuilt

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

const keyGuard = <Key extends string>(keys: readonly Key[]) => {
  const known: ReadonlySet<string> = new Set(keys)
  return (key: string): key is Key => known.has(key)
}

export const GLOBAL_CONFIG_KEYS: Unbuilt = unbuilt('src/utils/config/schema.ts:305')

export type GlobalConfigKey = Unbuilt
export const isGlobalConfigKey: Unbuilt = unbuilt('src/utils/config/schema.ts:330')

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const satisfies readonly (keyof ProjectConfig)[]

export type ProjectConfigKey = Unbuilt
export const isProjectConfigKey = keyGuard(PROJECT_CONFIG_KEYS)
