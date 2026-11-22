import type { EffortLevel } from '../effortLadder.js'
import type { McpServerConfig } from '../mcp/types.js'
import type { BillingType } from '../oauth/types.js'
import type { ImageDimensions } from '../imageResizer.js'
import { DEFAULT_THEME_SETTING } from '../systemTheme.js'
import type { ThemeSetting } from '../theme.js'
import type { EDITOR_MODES } from '../configConstants.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = unbuilt('src/utils/config/schema.ts:111')

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
  return notBuilt('src/utils/config/schema.ts:279')
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = unbuilt('src/utils/config/schema.ts:298')

const keyGuard = <Key extends string>(keys: readonly Key[]): Unbuilt => notBuilt('src/utils/config/schema.ts:300')

export const GLOBAL_CONFIG_KEYS: Unbuilt = unbuilt('src/utils/config/schema.ts:305')

export type GlobalConfigKey = Unbuilt
export const isGlobalConfigKey: Unbuilt = unbuilt('src/utils/config/schema.ts:330')

export const PROJECT_CONFIG_KEYS: Unbuilt = unbuilt('src/utils/config/schema.ts:332')

export type ProjectConfigKey = Unbuilt
export const isProjectConfigKey = keyGuard(PROJECT_CONFIG_KEYS)
