import { getGlobalConfig } from '../utils/config.js'
import type { Settings } from '../utils/settings/types.js'
import type { ToolPermissionContext } from '../Tool.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentDefinition } from '../types/agent.js'
import type { MCPServerConnection } from '../utils/mcp/types.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../types/command.js'
import type { Message, UserMessage } from '../types/message.js'
import type { PastedContent } from '../utils/config/schema.js'
import type { ModelTransitionReceipt } from '../services/model/modelTransition.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../types/fileHistory.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Notification } from '../context/notifications.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type { ServerResource } from '../utils/mcp/types.js'
import type { RosterEntry, Health } from '../extensions/types.js'
import { createEmptyAttributionState, type AttributionState } from '../utils/commitAttribution.js'
import type { PromptVariant } from '../services/PromptSuggestion/promptSuggestion.js'
import type { TurnAnswerContext } from '../query/turnAnswerContext.js'
import type { Store } from './store.js'
import type { CrewLedger } from './crewLedger.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type ImmutablePrimitive =
  | undefined
  | null
  | boolean
  | string
  | number
  | Function

export type DeepImmutable<T> = unknown extends T
  ? T
  : T extends ImmutablePrimitive
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepImmutable<U>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepImmutable<U>>
        : { readonly [K in keyof T]: DeepImmutable<T[K]> }


export type FooterItem = Unbuilt


export type CompletionBoundary =
  Unbuilt

export type SpeculationState =
  Unbuilt

export const IDLE_SPECULATION_STATE: SpeculationState = unbuilt('src/state/AppStateStore.ts:81')

export type SpeculationResult = Unbuilt


export type InboxMessageStatus = 'pending' | 'processing' | 'processed' | 'held'

export type InboxMessage = Unbuilt


export type ExtensionsState = {
  roster: RosterEntry[]
  health: Record<string, Health | null>
  pending: boolean
  problems: string[]
  lastReloadLine: string | null
}


type AppStateImmutableHalf = {
  settings: Settings
  verbose: boolean
  expandedView: 'none' | 'tasks'
  spinnerTip?: string
  agent?: string
  footerSelection: FooterItem | null
  bagelActive?: boolean

  engineModel: string | null
  engineModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
  lastModelTransition?: ModelTransitionReceipt | null
  foregroundTurnActive: boolean

  toolPermissionContext: ToolPermissionContext

  remoteSessionUrl?: string
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  remoteBackgroundTaskCount: number
  remoteControlEnabled: boolean
  bridgeActivated: boolean
  remoteControlOutboundOnly: boolean
  bridgeRegistered: boolean
  bridgeIngressOpen: boolean
  bridgeInErrorBackoff: boolean
  bridgeConnectUrl?: string
  bridgeSessionUrl?: string
  bridgeEnvironmentId?: string
  bridgeSessionId?: string
  bridgeError?: string
  bridgeInitialSessionName?: string
  bridgeFirstRunCallout: boolean
}

export type AppState = Unbuilt

export type AppStateStore = Unbuilt

function rememberedExpandedView(): AppState['expandedView'] {
  try {
    const remembered = getGlobalConfig().expandedView
    return remembered === 'tasks' ? remembered : 'none'
  } catch (error) {
    passedOver(error)
    return 'none'
  }
}

export function getDefaultAppState(): AppState {
  return notBuilt('src/state/AppStateStore.ts:233')
}

