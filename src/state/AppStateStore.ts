import { getGlobalConfig } from '../utils/config.js'
import type { Settings } from '../entrypoints/agentSdkTypes.js'
import type { ToolPermissionContext } from '../Tool.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../types/command.js'
import type { Message, UserMessage } from '../types/message.js'
import type { InternalPermissionMode } from '../types/permissions.js'
import type { ModelTransitionReceipt } from '../utils/model/modelTransition.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Notification } from '../context/notifications.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type { ServerResource } from '../services/mcp/types.js'
import type { RosterEntry, Health } from '../extensions/types.js'
import { createEmptyAttributionState, type AttributionState } from '../utils/commitAttribution.js'
import type { PromptVariant } from '../services/PromptSuggestion/promptSuggestion.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { AllowedPrompt } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { Store } from './store.js'


type ImmutablePrimitive =
  | undefined
  | null
  | boolean
  | string
  | number
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
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


export type FooterItem = 'tasks' | 'bagel' | 'teams' | 'bridge'


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
      contextRef: { current: REPLHookContext }
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


export type TeammateRecord = {
  name: string
  agentType?: string
  color?: string
  tmuxSessionName: string
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  spawnedAt: number
}

export type TeamContext = {
  teamName: string
  teamFilePath: string
  leadAgentId: string
  selfAgentId?: string
  selfAgentName?: string
  selfAgentColor?: string
  isLeader?: boolean
  teammates: Record<string, TeammateRecord>
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
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  spinnerTip?: string
  showTeammateMessagePreview?: boolean
  isAssistantMode: boolean
  agent?: string
  footerSelection: FooterItem | null
  bagelActive?: boolean

  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
  lastModelTransition?: ModelTransitionReceipt | null
  foregroundTurnActive: boolean

  toolPermissionContext: ToolPermissionContext

  remoteSessionUrl?: string
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  remoteBackgroundTaskCount: number
  replBridgeEnabled: boolean
  bridgeActivated: boolean
  replBridgeOutboundOnly: boolean
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


type AppStateMutableHalf = {
  tasks: Record<string, TaskState>
  agentNameRegistry: Map<string, string>
  foregroundedTaskId?: string
  viewingAgentTaskId?: string | undefined
  selectedIPAgentIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  teamContext?: TeamContext
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

  remoteAgentTaskSuggestions?: Array<{ summary: string; task: string }>
  skillImprovement?: {
    skillName: string
    updates: Array<{ section: string; change: string; reason: string }>
  }

  webBrowser?: {
    active: boolean
    currentUrl?: string
    stickyPanelVisible?: boolean
  }
  computerUseSession?: {
    appAllowlist?: string[]
    grantedApps?: string[]
    grants?: Record<string, boolean>
    lastScreenshotDimensions?: { width: number; height: number }
    appsHiddenDuringTurn?: string[]
    targetedDisplay?: number
    displayPinnedByModel?: boolean
    displayResolvedForAppSetFingerprint?: string
  }
  replToolVmContext?: {
    vmContext: unknown
    registeredTools: Record<string, unknown>
    capturingConsole: unknown
  }

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

  pendingWorkerRequest: { toolName: string; description: string; toolUseId: string } | null

  effortValue: EffortValue | undefined
  supercode: boolean | undefined

  authVersion: number
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    permissionMode?: InternalPermissionMode
    allowedPrompts?: AllowedPrompt[]
    bashMode?: boolean
    armedAtLanding?: boolean
  } | null
  pendingPlanVerification?: {
    verificationStarted?: boolean
    verificationCompleted?: boolean
  }
  denialTracking?: DenialTrackingState
  thinkingEnabled: boolean
  advisorModel?: string
  channelPermissionCallbacks?: Record<string, (result: unknown) => void>
}

export type AppState = DeepImmutable<AppStateImmutableHalf> & AppStateMutableHalf

export type AppStateStore = Store<AppState>

function rememberedExpandedView(): AppState['expandedView'] {
  try {
    const remembered = getGlobalConfig().expandedView
    return remembered === 'tasks' || remembered === 'teammates' ? remembered : 'none'
  } catch {
    return 'none'
  }
}

export function getDefaultAppState(): AppState {
  return {
    settings: getInitialSettings(),
    verbose: false,
    expandedView: rememberedExpandedView(),
    isBriefOnly: false,
    isAssistantMode: computeAssistantMode(),
    footerSelection: null,

    mainLoopModel: null,
    mainLoopModelForSession: null,
    pendingModelSwitch: null,
    lastModelTransition: null,
    foregroundTurnActive: false,

    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: computeInitialPermissionMode(),
    },

    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    bridgeActivated: false,
    replBridgeOutboundOnly: false,
    bridgeRegistered: false,
    bridgeIngressOpen: false,
    bridgeInErrorBackoff: false,
    bridgeFirstRunCallout: false,

    tasks: {},
    agentNameRegistry: new Map(),
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
    supercode: undefined,

    authVersion: 0,
    initialMessage: null,
    thinkingEnabled: shouldEnableThinkingByDefault(),
    showTeammateMessagePreview: false,
  }
}

function computeAssistantMode(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const owner = require('../tasks/LocalShellTask/LocalShellTask.js') as {
      isAssistantModeActive?: () => boolean
    }
    return owner.isAssistantModeActive?.() ?? false
  } catch {
    return false
  }
}

function computeInitialPermissionMode(): InternalPermissionMode {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const teammate = require('../utils/teammate.js') as {
      isTeammate?: () => boolean
      isPlanModeRequired?: () => boolean
    }
    if (teammate.isTeammate?.() && teammate.isPlanModeRequired?.()) return 'strategy'
  } catch {
  }
  return 'default'
}
