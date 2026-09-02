// ============================================================================
//  unity/bridgeProtocol — THE UNITY-BRIDGE WIRE CONTRACT (version 1), the
//  document-grade module both halves implement: Mercury's client
//  (services/unity/bridgeClient.ts) and the in-editor C# package shipped as
//  source under assets/unity/bridge/ (baked by scripts/unity-bridge/
//  regen-bridge.mjs). The VULCAN sibling (services/vulcan/vulcanClient.ts +
//  assets/vulcan/addon/) is the shape this mirrors, never forks.
//
//  WIRE: NDJSON over loopback TCP — one JSON object per newline-terminated
//  line, frames capped at UNITY_BRIDGE_MAX_LINE_BYTES in BOTH directions.
//  The first frame is the hello {op:"hello", token, role:"client", version};
//  the server answers {ok:true, result:<UnityBridgeHelloInfo>} or an error
//  frame and drops. After the hello: requests {id, op, args?} answered by
//  {id, ok, result|error}, unsolicited {event, data} frames, and ping/pong
//  heartbeats. The server keeps ONE connection — a newer hello wins and the
//  older socket drops (after a Unity domain reload Mercury's singleton
//  client habitually holds a stale socket; accept-newest self-heals).
//
//  TOKEN REFUSAL (contract): a wrong or absent token answers AUTH_FAILED and
//  the server drops — the hint names op:"unity_bridge_install", which
//  rewrites the token file. VERSION SKEW (the protocol's own degradation
//  law): the server accepts exactly UNITY_BRIDGE_PROTOCOL_VERSION and
//  answers VERSION_SKEW naming BOTH versions before dropping; the client
//  ALSO checks the hello answer's result.version and refuses to send ops
//  (BRIDGE_VERSION_SKEW) on a mismatch — reinstalling the bundled package
//  re-aligns the halves. UNKNOWN VERB: UNKNOWN_OP with the verb list in the
//  hint; the wire never guesses.
//
//  THE DOMAIN-RELOAD LAW (the fact that shapes this contract; absent from
//  the Godot sibling): entering play mode or recompiling scripts reloads the
//  editor's script domain, killing ALL static state — the TCP listener and
//  any registered test callbacks included. The package re-arms both from an
//  [InitializeOnLoad] static constructor after EVERY reload ("Static
//  constructors with this attribute are called when scripts in the project
//  are recompiled, also known as a Domain Reload" — docs.unity3d.com 6000.3
//  InitializeOnLoadAttribute, read 2026-08-29; the test-callback half:
//  "The registered callbacks are not persisted on domain reloads. So it is
//  necessary to re-register the callback after a domain reloads, usually
//  with InitializeOnLoad" — com.unity.test-framework@1.4
//  extension-get-test-results, read 2026-08-29). Consequences, binding:
//   · play_enter/play_exit are ACK-THEN-TRANSITION: the response is written
//     BEFORE the mode change fires (the package defers the transition), so
//     the caller always learns willReload before the socket dies; the
//     client's reconnect posture absorbs the documented drop.
//   · tests_run answers {started:true} immediately; the DURABLE results road
//     is the XML file the package writes at RunFinished via
//     ITestResultAdaptor.ToXml ("Use this to save the results to an XML
//     file" — @1.4 api), landed at the resultsPath Mercury
//     sends (the LANDED unityTestResultsPath spelling,
//     <root>/.mercury/unity-test-results/<mode>.xml) and read back through
//     the LANDED services/ide/unityTests.ts door — never a second parser.
//     The test_run_finished event is the connected-case fast path only.
//
//  Verb classes ride the same vocabulary as the VULCAN optable (read |
//  mutate | exec) and drive the tool's permission ladder: read ⇒ allow,
//  mutate ⇒ ask, exec ⇒ ask ALWAYS. The table is hand-typed here — at nine
//  verbs a generated optable would be machinery without a mass.
//
//  Deliberate differences from the VULCAN sibling, recorded: no lite mode
//  (nine verbs need no subset), no optable.json (this module IS the table),
//  no prompt-section/doctrine splice (additive tier — the tool description
//  carries the teaching; see utils/unity/bridgeGates.ts).
//
//  Proof: scripts/unity-bridge/prove-unity-bridge-contract.ts (table
//  totality, class census, code unions, frame-helper totality over hostile
//  shapes); the client/server behavioral contract is proven by
//  prove-unity-bridge-protocol.ts against the scripted fake bridge.
// ============================================================================

export const UNITY_BRIDGE_PROTOCOL_VERSION = 1

/** Default listener port — the loopback dev-lane family: Godot editor LSP
 *  6005 / DAP 6006, VULCAN 6010, the Unity bridge 6011. Both halves share
 *  this default; ProjectSettings/MercuryUnityBridge.json (written by
 *  install when MERCURY_UNITY_BRIDGE_PORT differs) aligns them. */
export const UNITY_BRIDGE_DEFAULT_PORT = 6011

/** Frame cap, both directions (the vulcan client's exact bound). */
export const UNITY_BRIDGE_MAX_LINE_BYTES = 8 * 1024 * 1024

/** Result-shaping bounds the package enforces server-side (documented here
 *  because they are contract: a hierarchy_read can never overflow the frame
 *  cap by construction, and console_tail's ring drops oldest, counted). */
export const UNITY_BRIDGE_HIERARCHY_NODE_CAP = 2_000
export const UNITY_BRIDGE_CONSOLE_RING_CAP = 1_000

// ── error vocabulary ─────────────────────────────────────────────────────────

/** Codes the SERVER (the C# package) answers on the wire. */
export const UNITY_BRIDGE_SERVER_ERROR_CODES = [
  'AUTH_FAILED', // bad/absent hello token (drops after answering)
  'VERSION_SKEW', // hello version ≠ the package's protocol version (drops)
  'UNKNOWN_OP', // verb outside the table; hint lists the verbs
  'BAD_ARGS', // malformed/missing args; path escapes the project
  'PLAY_MODE_ACTIVE', // edit-mode-only verb while playing (or re-entry)
  'SCENE_NOT_FOUND', // scene_open path resolves to no scene asset
  'SCENE_DIRTY', // scene_open would discard unsaved work; hint names the save road
  'RUN_IN_FLIGHT', // tests_run while a run is already executing
  'INTERNAL', // an editor-side exception, message carried honestly
] as const
export type UnityBridgeServerErrorCode = (typeof UNITY_BRIDGE_SERVER_ERROR_CODES)[number]

/** Codes the CLIENT mints locally (transport truth; the vulcan set plus the
 *  client-side skew arm). */
export const UNITY_BRIDGE_CLIENT_ERROR_CODES = [
  'AUTH_FAILED', // relayed from the handshake error frame
  'HANDSHAKE_CLOSED', // connect/hello never completed
  'CONNECTION_LOST', // socket died mid-flight (domain reloads land here)
  'EDITOR_UNREACHABLE', // inside the reconnect fast-fail window
  'REQUEST_TIMEOUT', // per-request deadline elapsed, op named
  'CLIENT_CLOSED', // the session client was closed
  'BAD_FRAME', // an answer frame without a lawful body
  'BRIDGE_VERSION_SKEW', // hello answered with a foreign result.version
] as const
export type UnityBridgeClientErrorCode = (typeof UNITY_BRIDGE_CLIENT_ERROR_CODES)[number]

export interface UnityBridgeError {
  code: string
  message: string
  hint?: string
}
export type UnityBridgeResult = { ok: true; result: unknown } | { ok: false; error: UnityBridgeError }

// ── the verb table ───────────────────────────────────────────────────────────

export type UnityBridgeVerbClass = 'read' | 'mutate' | 'exec'

export interface UnityBridgeVerbSpec {
  cls: UnityBridgeVerbClass
  summary: string
  /** arg name → short human type/shape note (validation is editor-side). */
  args: Readonly<Record<string, string>>
}

/** The wire verbs, whole. The tool's LOCAL ops (unity_status /
 *  unity_bridge_install / unity_bridge_uninstall) are Mercury-side and never
 *  reach this wire — they live in the tool, the GodotTool LOCAL_OPS grammar. */
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

// ── result shapes ────────────────────────────────────────────────────────────

export interface UnityBridgePlayState {
  isPlaying: boolean
  isPaused: boolean
  isPlayingOrWillChangePlaymode: boolean
  /** From the project's Enter Play Mode Settings: domain reload on entering
   *  play (the default) — when true, play_enter's ack precedes a drop. */
  willReloadOnPlay: boolean
}

/** The hello answer's result. */
export interface UnityBridgeHelloInfo {
  version: number
  /** "com.mercury.unity-bridge/<package version>". */
  bridge: string
  /** The editor's own version string (the m_EditorVersion vocabulary). */
  unity: string
  /** PlayerSettings.productName. */
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
  /** Nodes beyond the cap (0 = the walk is complete). */
  truncatedNodes: number
}

export type UnityConsoleSeverity = 'log' | 'warning' | 'assert' | 'error' | 'exception'
export interface UnityConsoleEntry {
  severity: UnityConsoleSeverity
  message: string
  stackTrace: string
  /** Editor-side receipt time, ms since epoch. */
  at: number
}
export interface UnityConsoleTail {
  entries: UnityConsoleEntry[]
  /** Ring evictions since arming (dropped-oldest, counted honestly). */
  dropped: number
}

export interface UnityBridgeTestsStarted {
  started: true
  mode: 'EditMode' | 'PlayMode'
  resultsPath: string
}

// ── events ───────────────────────────────────────────────────────────────────

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

// ── frame helpers (pure; both the client and the fake bridge ride these) ─────

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

/** One parsed wire line, discriminated. Total over wire-legal AND hostile
 *  input: garbage, non-objects, and shapeless frames answer 'unknown' —
 *  this helper never throws (the callers' never-hang contracts stand on it). */
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
