// ============================================================================
//  src/state/AppStateStore.ts — the application state shape and its default.
//
//  `AppState` is ONE object holding the whole interactive session's mutable
//  state: a deep-immutable block (settings/display, model selection, view
//  selection, permission context, remote/bridge) intersected with a plain
//  block (everything from the task map onwards — anything carrying
//  functions, mutable refs, Map/Set values or foreign shapes). The split is
//  what makes callers' spread updates type-check on one half and not the
//  other; reproduce it.
// ============================================================================
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
import type { TodoItem } from '../utils/todo/types.js'
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

// ── deep immutability ──────────────────────────────────────────────────────

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

// ── presentation unions ────────────────────────────────────────────────────

/** Which footer pill has arrow-key focus (contract data), or null. */
export type FooterItem = 'tasks' | 'bagel' | 'teams' | 'bridge'

// ── speculation ────────────────────────────────────────────────────────────

/**
 * A completion boundary: what ended the accepted span (contract data for
 * the speculation settle path).
 */
export type CompletionBoundary =
  | { type: 'completion'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | { type: 'denied_tool'; toolName: string; detail: string; completedAt: number }

/**
 * The active member carries MUTABLE REFS for accumulated messages and
 * written paths deliberately — array copying per message is the cost being
 * avoided.
 */
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

/** Shared idle value: idle-ness is compared BY IDENTITY. */
export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

/** What settling a speculation hands back (no AppState field holds it). */
export type SpeculationResult = {
  messages: Message[]
  completionBoundary?: CompletionBoundary
  timeSavedMs: number
}

// ── inbox ──────────────────────────────────────────────────────────────────

/** 'held' parks a teammate message while the session runs with bypass
 *  permissions: delivery waits for the operator to return to a prompting
 *  mode (the mechanical permission-laundering boundary). */
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

// ── teams ──────────────────────────────────────────────────────────────────

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

// ── extensions ─────────────────────────────────────────────────────────────

/** The extensions core's published state: the roster and the one health owner's readout. */
export type ExtensionsState = {
  roster: RosterEntry[]
  /** id → health for switched-on extensions; null for the rest. */
  health: Record<string, Health | null>
  /** Records changed since the running session swapped; `r` reloads. */
  pending: boolean
  /** Corrupt record files, one line each. */
  problems: string[]
  /** The last reload's transcript line. */
  lastReloadLine: string | null
}

// ── the immutable half ─────────────────────────────────────────────────────

type AppStateImmutableHalf = {
  // Settings and display.
  settings: Settings
  verbose: boolean
  /** Exactly three values. */
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  spinnerTip?: string
  /** Exists only when the agent-swarm compile gate is on. */
  showTeammateMessagePreview?: boolean
  /** Computed once at boot, BEFORE option mutation; consumers read it. */
  isAssistantMode: boolean
  /** From the --agent flag or settings; used for logo display. */
  agent?: string
  /** A pill rendered outside the prompt component reads its own focus. */
  footerSelection: FooterItem | null
  /** WebBrowser tool (codename bagel): the footer pill's visibility — a
   *  dormant declared member (no writer yet; the pill arms when the tool
   *  lands). Restored at the round-4 fold: the state rewrite dropped it. */
  bagelActive?: boolean

  // Model selection.
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  /** At most one queued pick; applied exactly once at the next turn
   *  boundary; a newer pick replaces the older. */
  pendingModelSwitch: { setting: string | null } | null
  /** Consumed exactly once by identity. */
  lastModelTransition?: ModelTransitionReceipt | null
  /** Published by the REPL: a foreground turn is currently active. */
  foregroundTurnActive: boolean

  // Permissions.
  toolPermissionContext: ToolPermissionContext

  // Remote and bridge.
  remoteSessionUrl?: string
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  /** Event-sourced count — the local task map is empty in viewer mode. */
  remoteBackgroundTaskCount: number
  /** DESIRED enablement (distinct from activation). */
  replBridgeEnabled: boolean
  bridgeActivated: boolean
  replBridgeOutboundOnly: boolean
  /** Registered and session created. */
  bridgeRegistered: boolean
  /** Ingress socket open. */
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

// ── the plain half ─────────────────────────────────────────────────────────

type AppStateMutableHalf = {
  // Agents and tasks.
  tasks: Record<string, TaskState>
  /** name → task id; latest wins on collision. Routes messages by name. */
  agentNameRegistry: Map<string, string>
  foregroundedTaskId?: string
  viewingAgentTaskId?: string | undefined
  /** −1 = nothing selected (the list surfaces rely on the sentinel). */
  selectedIPAgentIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  teamContext?: TeamContext
  standaloneAgentContext?: { name: string; color?: string }

  // MCP.
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /** Monotonic; the VALUE is never read — bumping re-runs the extension
     *  server connection effects. */
    extensionReconnectKey: number
  }

  // Extensions.
  extensions: ExtensionsState

  // Notifications / elicitation / inbox / todos.
  notifications: { current: Notification | null; queue: Notification[] }
  elicitation: { queue: ElicitationRequestEvent[] }
  inbox: { messages: InboxMessage[] }
  todos: Record<string, TodoItem[]>

  // File history and attribution.
  fileHistory: FileHistoryState
  attribution: AttributionState

  // Agent definitions and session hooks.
  agentDefinitions: { activeAgents: AgentDefinition[]; allAgents: AgentDefinition[] }
  sessionHooks: SessionHooksState

  // Remote-agent suggestions and skill improvement.
  remoteAgentTaskSuggestions?: Array<{ summary: string; task: string }>
  skillImprovement?: {
    skillName: string
    updates: Array<{ section: string; change: string; reason: string }>
  }

  // Tool-owned optional sub-states (presence and optionality are the
  // contract; the store does not interpret them).
  webBrowser?: {
    active: boolean
    currentUrl?: string
    stickyPanelVisible?: boolean
  }
  /** Member types INLINED so an external typecheck passes without the
   *  vendor package resolved. */
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

  // Speculation.
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number

  // Prompt suggestion (always present; empty = null members).
  promptSuggestion: {
    text: string | null
    promptId: PromptVariant | null
    shownAt: number
    acceptedAt: number
    generationRequestId?: string | null
  }
  promptSuggestionEnabled: boolean

  // The worker permission slot (the sandbox queue retired with the one ask
  // road — structuredIO canUseTool → the daemon's asks → the consent card).
  pendingWorkerRequest: { toolName: string; description: string; toolUseId: string } | null

  // Effort.
  effortValue: EffortValue | undefined
  /** Pins maximum effort and drives a standing system reminder; mutually
   *  exclusive with an explicitly co-set level. */
  supercode: boolean | undefined

  // Miscellaneous session flags.
  /** Incremented on login/logout to invalidate auth-derived data. */
  authVersion: number
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    permissionMode?: InternalPermissionMode
    allowedPrompts?: AllowedPrompt[]
  } | null
  pendingPlanVerification?: {
    verificationStarted?: boolean
    verificationCompleted?: boolean
  }
  denialTracking?: DenialTrackingState
  thinkingEnabled: boolean
  advisorModel?: string
  isUltraplanMode?: boolean
  channelPermissionCallbacks?: Record<string, (result: unknown) => void>
}

export type AppState = DeepImmutable<AppStateImmutableHalf> & AppStateMutableHalf

export type AppStateStore = Store<AppState>

/**
 * The default state. Containers empty; counters 0. The optionals set
 * EXPLICITLY (teammateMessagePreview false; effortValue and supercode
 * present with value undefined) — a present-but-undefined key
 * and an absent key differ under callers' spread updates; do not tidy
 * these into omissions. The selected-agent index starts at −1 (the
 * "nothing selected" sentinel).
 */
/** The panel the operator last left open, when the config is readable
 *  (the early-boot gate otherwise yields the default). */
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
    todos: {},

    // Every counter starts at 0 — including the snapshot sequence inside.
    fileHistory: { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 },
    attribution: createEmptyAttributionState(),

    agentDefinitions: { activeAgents: [], allAgents: [] },
    sessionHooks: new Map(),

    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,

    promptSuggestion: { text: null, promptId: null, shownAt: 0, acceptedAt: 0 },
    promptSuggestionEnabled: computePromptSuggestionEnabled(),

    pendingWorkerRequest: null,

    effortValue: undefined,
    supercode: undefined,

    authVersion: 0,
    initialMessage: null,
    thinkingEnabled: shouldEnableThinkingByDefault(),
    showTeammateMessagePreview: false,
  }
}

/**
 * Assistant mode, computed once at boot before option mutation.
 * Lazy require: the owning module sits in the task layer and a static
 * import would drag its UI graph under this vocabulary module.
 */
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

/** Owning resolver for the prompt-suggestion capability (lazy — the
 *  service module is deliberately not loaded eagerly at boot). */
function computePromptSuggestionEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const suggestion = require('../services/PromptSuggestion/promptSuggestion.js') as {
      shouldEnablePromptSuggestion?: () => boolean
    }
    return suggestion.shouldEnablePromptSuggestion?.() ?? false
  } catch {
    return false
  }
}

/**
 * Strategy mode iff the process runs as a teammate AND strategy mode is required
 * for it; otherwise default. The teammate module is reached LAZILY at call
 * time — a static import forms a cycle.
 */
function computeInitialPermissionMode(): InternalPermissionMode {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const teammate = require('../utils/teammate.js') as {
      isTeammate?: () => boolean
      isPlanModeRequired?: () => boolean
    }
    if (teammate.isTeammate?.() && teammate.isPlanModeRequired?.()) return 'strategy'
  } catch {
    // fall through to default
  }
  return 'default'
}
