import { getGlobalConfig } from '../../platform/settings/config.js'
import type { Settings } from '../../platform/settings/settingsSchema.js'
import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { getEmptyToolPermissionContext } from '../../tools/kit/tool.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { Tool } from '../../tools/kit/tool.js'
import type { Command } from '../../commands/catalogue/command.js'
import type { Message, UserMessage } from '../../engine/message-shapes/message.js'
import type { PastedContent } from '../../platform/config/schema.js'
import type { ModelTransitionReceipt } from '../../models/catalogue/modelTransition.js'
import type { EffortValue } from '../../models/effort/effort.js'
import type { FileHistoryState } from '../../sessions/transcripts/fileHistory.js'
import type { SessionHooksState } from '../../integrations/event-hooks/sessionHooks.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { shouldEnableThinkingByDefault } from '../../models/effort/thinking.js'
import type { Notification } from '../notifications/notifications.js'
import type { ElicitationRequestEvent } from '../../integrations/mcp/elicitationHandler.js'
import type { ServerResource } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { RosterEntry, Health } from '../../integrations/extensions/types.js'
import { createEmptyAttributionState, type AttributionState } from './commitAttribution.js'
import type { PromptVariant } from '../prompt-suggestion/promptSuggestion.js'
import type { TurnAnswerContext } from '../../engine/turn-entry/turnAnswerContext.js'
import type { Store } from '../../platform/primitives/store.js'
import type { CrewLedger } from './crewLedger.js'
import { passedOver } from '../../platform/errors/passedOver.js'


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


export type FooterItem = 'tasks' | 'bagel' | 'bridge'


export type CompletionBoundary =
  | { type: 'completion'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | { type: 'denied_tool'; toolName: string; detail: string; completedAt: number }

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: unknown[] }
      writtenPathsRef: { current: Set<string> }
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: TurnAnswerContext }
      pipelinedSuggestion?: {
        text: string
        promptId: PromptVariant
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type SpeculationResult = {
  messages: Message[]
  completionBoundary?: CompletionBoundary
  timeSavedMs: number
}


export type InboxMessageStatus = 'pending' | 'processing' | 'processed' | 'held'

export type InboxMessage = {
  id: string
  from: string
  text: string
  timestamp: string
  status: InboxMessageStatus
  color?: string
  summary?: string
}


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

type AppStateLiveHalf = {
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, string>
  foregroundedTaskId?: string
  viewingAgentTaskId?: string | undefined
  mainChatTaskId?: string | undefined
  crewLedger: CrewLedger
  selectedIPAgentIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  standaloneAgentContext?: { name: string; color?: string }

  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    extensionReconnectKey: number
  }
  extensions: ExtensionsState

  notifications: { current: Notification | null; queue: Notification[] }
  elicitation: { queue: ElicitationRequestEvent[] }
  inbox: { messages: InboxMessage[] }

  fileHistory: FileHistoryState
  attribution: AttributionState

  agentDefinitions: { activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }
  sessionHooks: SessionHooksState

  remoteAgentTaskSuggestions?: { summary: string; task: string }[]
  skillImprovement?: { skillName: string; updates: { section: string; change: string; reason: string }[] }
  webBrowser?: { active: boolean; currentUrl?: string; stickyPanelVisible?: boolean }
  channelPermissionCallbacks?: { [key: string]: (result: unknown) => void }

  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  promptSuggestion: {
    text: string | null
    promptId: PromptVariant | null
    shownAt: number
    acceptedAt: number
    generationRequestId?: string | null
  }
  promptSuggestionEnabled: boolean

  pendingWorkerRequest: { toolName: string; toolUseId: string; description: string } | null
  effortValue: EffortValue | undefined
  authVersion: number
  initialMessage: {
    message: UserMessage
    bashMode?: boolean
    armedAtLanding?: boolean
    pastedContents?: Record<number, PastedContent>
    armedBehind?: { message: UserMessage; bashMode?: boolean; pastedContents?: Record<number, PastedContent> }[]
  } | null
  thinkingEnabled: boolean
}

export type AppState = DeepImmutable<AppStateImmutableHalf> & AppStateLiveHalf

export type AppStateStore = Store<AppState>

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
  return {
    settings: getInitialSettings(),
    verbose: false,
    expandedView: rememberedExpandedView(),
    footerSelection: null,

    engineModel: null,
    engineModelForSession: null,
    pendingModelSwitch: null,
    lastModelTransition: null,
    foregroundTurnActive: false,

    toolPermissionContext: getEmptyToolPermissionContext(),

    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    remoteControlEnabled: false,
    bridgeActivated: false,
    remoteControlOutboundOnly: false,
    bridgeRegistered: false,
    bridgeIngressOpen: false,
    bridgeInErrorBackoff: false,
    bridgeFirstRunCallout: false,

    tasks: {},
    agentNameRegistry: new Map(),
    crewLedger: {},
    selectedIPAgentIndex: -1,
    viewSelectionMode: 'none',

    mcp: { clients: [], tools: [], commands: [], resources: {}, extensionReconnectKey: 0 },
    extensions: { roster: [], health: {}, pending: false, problems: [], lastReloadLine: null },

    notifications: { current: null, queue: [] },
    elicitation: { queue: [] },
    inbox: { messages: [] },

    fileHistory: { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 },
    attribution: createEmptyAttributionState(),

    agentDefinitions: { activeAgents: [], allAgents: [] },
    sessionHooks: new Map(),

    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    promptSuggestion: { text: null, promptId: null, shownAt: 0, acceptedAt: 0 },
    promptSuggestionEnabled: false,

    pendingWorkerRequest: null,
    effortValue: undefined,
    authVersion: 0,
    initialMessage: null,
    thinkingEnabled: shouldEnableThinkingByDefault(),
  }
}

