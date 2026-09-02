
export const UNITY_BRIDGE_PROTOCOL_VERSION = 1

export const UNITY_BRIDGE_DEFAULT_PORT = 6011

export const UNITY_BRIDGE_MAX_LINE_BYTES = 8 * 1024 * 1024

export const UNITY_BRIDGE_HIERARCHY_NODE_CAP = 2_000
export const UNITY_BRIDGE_CONSOLE_RING_CAP = 1_000


export const UNITY_BRIDGE_SERVER_ERROR_CODES = [
  'AUTH_FAILED',
  'VERSION_SKEW',
  'UNKNOWN_OP',
  'BAD_ARGS',
  'PLAY_MODE_ACTIVE',
  'SCENE_NOT_FOUND',
  'SCENE_DIRTY',
  'RUN_IN_FLIGHT',
  'INTERNAL',
] as const
export type UnityBridgeServerErrorCode = (typeof UNITY_BRIDGE_SERVER_ERROR_CODES)[number]

export const UNITY_BRIDGE_CLIENT_ERROR_CODES = [
  'AUTH_FAILED',
  'HANDSHAKE_CLOSED',
  'CONNECTION_LOST',
  'EDITOR_UNREACHABLE',
  'REQUEST_TIMEOUT',
  'CLIENT_CLOSED',
  'BAD_FRAME',
  'BRIDGE_VERSION_SKEW',
] as const
export type UnityBridgeClientErrorCode = (typeof UNITY_BRIDGE_CLIENT_ERROR_CODES)[number]

export interface UnityBridgeError {
  code: string
  message: string
  hint?: string
}
export type UnityBridgeResult = { ok: true; result: unknown } | { ok: false; error: UnityBridgeError }


export type UnityBridgeVerbClass = 'read' | 'mutate' | 'exec'

export interface UnityBridgeVerbSpec {
  cls: UnityBridgeVerbClass
  summary: string
  args: Readonly<Record<string, string>>
}

export const UNITY_BRIDGE_VERBS = {
  play_state: {
    cls: 'read',
    summary: 'Play-mode truth: isPlaying, isPaused, isPlayingOrWillChangePlaymode, willReloadOnPlay',
    args: {},
  },
  play_enter: {
    cls: 'exec',
    summary:
      'Enter play mode (EditorApplication.EnterPlaymode). ACK-THEN-TRANSITION: answers {willReload} first; with domain reload on, the connection then drops and the client reconnects',
    args: {},
  },
  play_exit: {
    cls: 'exec',
    summary: 'Exit play mode (EditorApplication.ExitPlaymode); the same ack-then-transition law',
    args: {},
  },
  play_pause: {
    cls: 'exec',
    summary: 'Pause/resume play mode (EditorApplication.isPaused); no reload involved',
    args: { paused: 'boolean — true pauses, false resumes' },
  },
  scene_list: {
    cls: 'read',
    summary:
      'Open scenes (path, name, isDirty, isLoaded, isActive) + build-settings scenes (path, enabled)',
    args: {},
  },
  scene_open: {
    cls: 'mutate',
    summary:
      'Open a scene by project-relative path, EDIT MODE ONLY ("In Play mode, use the SceneManager API" — the refusal is PLAY_MODE_ACTIVE); a dirty open scene refuses SCENE_DIRTY naming the save road, never a silent discard',
    args: {
      path: 'project-relative scene path (Assets/…): must stay inside the project',
      additive: 'optional boolean — OpenSceneMode.Additive instead of Single',
    },
  },
  hierarchy_read: {
    cls: 'read',
    summary:
      'Loaded scenes’ root GameObjects walked depth-first (name, active, componentTypeNames, children), bounded by maxNodes with the truncation counted honestly',
    args: {
      scenePath: 'optional — limit to the scene at this path (default: every loaded scene)',
      maxNodes: `optional number — node cap (default ${UNITY_BRIDGE_HIERARCHY_NODE_CAP})`,
    },
  },
  console_tail: {
    cls: 'read',
    summary:
      'The package’s console ring (Application.logMessageReceivedThreaded, lock-guarded), severity-classed, newest-last, dropped-count honest',
    args: {
      limit: 'optional number — max entries returned (default 100)',
      severity: 'optional — minimum severity: log | warning | assert | error | exception',
    },
  },
  tests_run: {
    cls: 'exec',
    summary:
      'Trigger a Test Runner run (TestRunnerApi.Execute); answers {started:true} immediately, ONE run at a time; results land as NUnit-format XML at resultsPath for the LANDED results door, plus the test_run_finished event on the connected fast path',
    args: {
      mode: '"EditMode" | "PlayMode"',
      testNames: 'optional string[] — full test names (Filter.testNames)',
      groupNames: 'optional string[] — group name patterns (Filter.groupNames)',
      resultsPath:
        'optional absolute-or-project-relative results-XML destination; Mercury always sends the landed unityTestResultsPath spelling; must stay inside the project',
    },
  },
} as const satisfies Record<string, UnityBridgeVerbSpec>

export type UnityBridgeVerb = keyof typeof UNITY_BRIDGE_VERBS

export function unityBridgeVerb(op: string): UnityBridgeVerbSpec | undefined {
  return (UNITY_BRIDGE_VERBS as Record<string, UnityBridgeVerbSpec>)[op]
}

export function unityBridgeVerbNames(): UnityBridgeVerb[] {
  return Object.keys(UNITY_BRIDGE_VERBS) as UnityBridgeVerb[]
}


export interface UnityBridgePlayState {
  isPlaying: boolean
  isPaused: boolean
  isPlayingOrWillChangePlaymode: boolean
  willReloadOnPlay: boolean
}

export interface UnityBridgeHelloInfo {
  version: number
  bridge: string
  unity: string
  project: string
  playState: UnityBridgePlayState
}

export interface UnityBridgeSceneRow {
  path: string
  name: string
  isDirty: boolean
  isLoaded: boolean
  isActive: boolean
}
export interface UnityBridgeBuildSceneRow {
  path: string
  enabled: boolean
}
export interface UnityBridgeSceneList {
  open: UnityBridgeSceneRow[]
  build: UnityBridgeBuildSceneRow[]
}

export interface UnityBridgeHierarchyNode {
  name: string
  active: boolean
  componentTypeNames: string[]
  children: UnityBridgeHierarchyNode[]
}
export interface UnityBridgeHierarchy {
  scenes: Array<{ path: string; roots: UnityBridgeHierarchyNode[] }>
  nodeCount: number
  truncatedNodes: number
}

export type UnityConsoleSeverity = 'log' | 'warning' | 'assert' | 'error' | 'exception'
export interface UnityConsoleEntry {
  severity: UnityConsoleSeverity
  message: string
  stackTrace: string
  at: number
}
export interface UnityConsoleTail {
  entries: UnityConsoleEntry[]
  dropped: number
}

export interface UnityBridgeTestsStarted {
  started: true
  mode: 'EditMode' | 'PlayMode'
  resultsPath: string
}


export const UNITY_BRIDGE_EVENTS = ['play_state_changed', 'test_run_finished'] as const
export type UnityBridgeEventName = (typeof UNITY_BRIDGE_EVENTS)[number]

export interface UnityBridgePlayStateChangedEvent {
  playState: UnityBridgePlayState
}
export interface UnityBridgeTestRunFinishedEvent {
  resultsPath: string
  passed: number
  failed: number
  skipped: number
  inconclusive: number
  durationMs: number
}


export function buildUnityBridgeHelloFrame(token: string): string {
  return (
    JSON.stringify({ op: 'hello', token, role: 'client', version: UNITY_BRIDGE_PROTOCOL_VERSION }) +
    '\n'
  )
}

export function buildUnityBridgeRequestFrame(
  id: number,
  op: string,
  args?: Record<string, unknown>,
): string {
  return (
    JSON.stringify({ id, op, ...(args && Object.keys(args).length > 0 ? { args } : {}) }) + '\n'
  )
}

export type UnityBridgeParsedFrame =
  | { kind: 'response'; id: number; ok: boolean; result?: unknown; error?: UnityBridgeError }
  | { kind: 'hello-reply'; ok: boolean; result?: unknown; error?: UnityBridgeError }
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'unknown'; raw: string }

export function parseUnityBridgeFrame(line: string): UnityBridgeParsedFrame {
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    return { kind: 'unknown', raw: line }
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return { kind: 'unknown', raw: line }
  }
  const f = frame as Record<string, unknown>
  const error =
    typeof f.error === 'object' && f.error !== null && !Array.isArray(f.error)
      ? (f.error as unknown as UnityBridgeError)
      : undefined
  if (typeof f.id === 'number' && Number.isFinite(f.id) && typeof f.ok === 'boolean') {
    return { kind: 'response', id: f.id, ok: f.ok, result: f.result, ...(error ? { error } : {}) }
  }
  if (typeof f.event === 'string') {
    return { kind: 'event', event: f.event, data: f.data }
  }
  if (typeof f.ok === 'boolean') {
    return { kind: 'hello-reply', ok: f.ok, result: f.result, ...(error ? { error } : {}) }
  }
  return { kind: 'unknown', raw: line }
}
