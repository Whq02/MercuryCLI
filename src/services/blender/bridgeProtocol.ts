// ============================================================================
//  blender/bridgeProtocol — THE BLENDER-BRIDGE WIRE CONTRACT (version 1), the
//  document-grade module both halves implement: Mercury's client
//  (services/blender/bridgeClient.ts) and the in-Blender Python add-on shipped
//  as source under assets/blender/bridge/ (baked by scripts/blender-bridge/
//  regen-bridge.mjs). The UNITY sibling (services/unity/bridgeProtocol.ts) is
//  the grammar this mirrors, never forks; the VULCAN estate is the shared
//  grandparent.
//
//  WIRE: NDJSON over loopback TCP — one JSON object per newline-terminated
//  line, frames capped at BLENDER_BRIDGE_MAX_LINE_BYTES in BOTH directions.
//  The first frame is the hello {op:"hello", token, role:"client", version};
//  the server answers {ok:true, result:<BlenderBridgeHelloInfo>} or an error
//  frame and drops. After the hello: requests {id, op, args?} answered by
//  {id, ok, result|error}, unsolicited {event, data} frames, and ping/pong
//  heartbeats. The server keeps ONE connection — a newer hello wins AT HELLO
//  TIME only (a bare probe that never hellos can never displace the authed
//  client; unauthed sockets die on a 10s receive deadline) — the landed
//  unity accept-newest law, kept verbatim.
//
//  TOKEN REFUSAL (contract): a wrong or absent token answers AUTH_FAILED and
//  the server drops — the hint names op:"blender_bridge_install", which
//  rewrites the token file beside the installed add-on. VERSION SKEW: the
//  server accepts exactly BLENDER_BRIDGE_PROTOCOL_VERSION and answers
//  VERSION_SKEW naming BOTH versions before dropping; the client ALSO checks
//  the hello answer's result.version and refuses to send ops
//  (BRIDGE_VERSION_SKEW) on a mismatch — reinstalling the bundled add-on
//  re-aligns the halves. UNKNOWN VERB: UNKNOWN_OP with the verb list in the
//  hint; the wire never guesses.
//
//  THE NO-RELOAD LAW (the deliberate INVERSE of the Unity sibling's
//  domain-reload law): Blender never reloads the add-on's Python state on
//  file opens, mode changes, or renders — the socket listener and the pump
//  timer SURVIVE, so the connection HOLDS across blend_open and render jobs.
//  The add-on arms its pump with bpy.app.timers.register(..,
//  persistent=True) ("Don't remove timer when a new file is loaded" —
//  blender/blender source/blender/python/intern/bpy_app_timers.cc, read
//  2026-08-29) and its lifecycle handlers with @bpy.app.handlers.persistent
//  (handlers without it are cleared on load — bpy_app_handlers.cc, read
//  2026-08-29). Consequence, binding: NO ack-then-transition machinery, NO
//  reload-survival store — the fake pins connection-survives-open
//  explicitly, and any future drop across blend_open is a DEFECT, not a
//  documented law.
//
//  THE MAIN-THREAD LAW (the fact that shapes the add-on): bpy is
//  main-thread-bound — "Python threads cause Blender to crash in hard to
//  diagnose ways"; "While threads are running, no code (including the main
//  thread) may use bpy or any Blender API - only standard Python or
//  third-party modules" (doc/python_api/rst/info_gotchas_threading.rst, read
//  2026-08-29). The add-on's socket thread is therefore STDLIB-ONLY (socket +
//  queue, zero bpy); every verb is marshalled through ONE persistent
//  bpy.app.timers pump on the main thread — the API page's own documented
//  pattern ("Use a Timer to react to events in another thread"; "queue.Queue
//  can be used here because it implements the required locking semantics" —
//  docs.blender.org/api/current/bpy.app.timers.html via search snippets, read
//  2026-08-29; the page itself 403s non-browser fetches). The community
//  precedent runs this exact shape (ahujasid/blender-mcp addon.py, read
//  2026-08-29).
//
//  THE RENDER-JOB LAW: renders run as editor JOBS (the RENDER arm of
//  bpy.app.is_job_running — "Check whether a job of the given type is
//  running", job types RENDER · RENDER_PREVIEW · OBJECT_BAKE · COMPOSITE ·
//  SHADER_COMPILATION; bpy_app.cc + rna_wm.cc rna_enum_wm_job_type_items,
//  read 2026-08-29). While a RENDER job runs, mutate/exec verbs refuse
//  RENDER_ACTIVE (reads stay free — render_state DURING a render is that
//  verb's whole point). RENDER_PREVIEW (viewport preview shading) never
//  refuses anything — it can run continuously by design. render_still's
//  DURABLE result is the image file at outputPath (the results-file law
//  transferred from the unity tests road: the file is the truth; the
//  render_finished event — from the render_complete/render_cancel handlers,
//  "on completion of render job" / "on canceling a render job",
//  bpy_app_handlers.cc read 2026-08-29 — is the connected-case fast path).
//
//  PYTHON_RUN (the ruled-in executor; ruling): Blender has no
//  in-editor test runner — bpy Python IS its automation surface, so
//  python_run is the bridge's executor verb. Its two danger sentences are
//  CONTRACT (exported below; the tool description carries both verbatim and
//  the provers pin them): no sandbox is claimed, and no preemption exists.
//  Caps: source ≤ BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES (BAD_ARGS beyond);
//  stdout/stderr capped at BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES each with
//  truncation counted. A raising script answers PYTHON_EXCEPTION carrying
//  type + message + a bounded traceback tail — never a blurred INTERNAL.
//
//  Verb classes ride the same vocabulary as the VULCAN optable (read |
//  mutate | exec) and drive the tool's permission ladder: read ⇒ allow,
//  mutate ⇒ ask, exec ⇒ ask ALWAYS. The table is hand-typed here — at seven
//  verbs a generated optable would be machinery without a mass.
//
//  Deliberate differences from the UNITY sibling, recorded: no play verbs
//  (Blender has no play mode; context.mode rides scene_info), no
//  ack-then-transition (the no-reload law above), no test-store road — the
//  NAMED ABSENCE: Blender has no test framework, an
//  image is not a test run, EngineFramework stays 'unity' and
//  services/ide/pythonTests.ts is byte-untouched; a real test/bake-run verb
//  class landing later is the recorded revival condition. blend_save is
//  deliberately absent from v1 (expressible via python_run behind
//  ask-always; BLEND_DIRTY's hint names the save road).
//
//  Proof: scripts/blender-bridge/prove-blender-bridge-contract.ts (table
//  totality, class census, code unions, danger-sentence contract, frame-
//  helper totality over hostile shapes); the client/server behavioral
//  contract is proven by prove-blender-bridge-protocol.ts against the
//  scripted fake bridge.
// ============================================================================

export const BLENDER_BRIDGE_PROTOCOL_VERSION = 1

/** Default listener port — the loopback dev-lane family: Godot editor LSP
 *  6005 / DAP 6006, VULCAN 6010, the Unity bridge 6011, the Blender bridge
 *  6012. Both halves share this default; the config.json beside the
 *  installed add-on (written by install when MERCURY_BLENDER_BRIDGE_PORT
 *  differs) aligns them. */
export const BLENDER_BRIDGE_DEFAULT_PORT = 6012

/** Frame cap, both directions (the vulcan client's exact bound). */
export const BLENDER_BRIDGE_MAX_LINE_BYTES = 8 * 1024 * 1024

/** Result-shaping bounds the add-on enforces server-side (documented here
 *  because they are contract: an objects_list can never overflow the frame
 *  cap by construction, and report_tail's ring drops oldest, counted). */
export const BLENDER_BRIDGE_OBJECTS_NODE_CAP = 2_000
export const BLENDER_BRIDGE_REPORT_RING_CAP = 1_000

/** python_run caps (contract): source refused BAD_ARGS beyond the cap;
 *  stdout/stderr each cut at the output cap with the cut bytes counted. */
export const BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES = 64 * 1024
export const BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES = 32 * 1024

/** python_run's danger sentences — CONTRACT: the tool
 *  description carries BOTH verbatim; the contract prover and the tool
 *  prover pin them. Reword only with an operator ruling. */
export const BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE =
  'python_run claims NO sandbox: the code runs inside Blender with full bpy authority — it can modify or delete scene data and write files as you; the permission ask is the fence.'
export const BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE =
  'python_run has NO preemption: bpy cannot abort a running script — a runaway script blocks Blender until it finishes (the client times out; the server cannot cancel).'

// ── error vocabulary ─────────────────────────────────────────────────────────

/** Codes the SERVER (the Python add-on) answers on the wire. */
export const BLENDER_BRIDGE_SERVER_ERROR_CODES = [
  'AUTH_FAILED', // bad/absent hello token (drops after answering)
  'VERSION_SKEW', // hello version ≠ the add-on's protocol version (drops)
  'UNKNOWN_OP', // verb outside the table; hint lists the verbs
  'BAD_ARGS', // malformed/missing args; python_run source over the cap
  'RENDER_ACTIVE', // mutate/exec verb while a RENDER job runs (reads stay free)
  'BLEND_NOT_FOUND', // blend_open path resolves to no .blend file
  'BLEND_DIRTY', // blend_open would discard unsaved work; hint names the save road
  'PYTHON_EXCEPTION', // python_run raised: type + message + bounded traceback tail
  'INTERNAL', // an add-on-side exception outside python_run, message carried honestly
] as const
export type BlenderBridgeServerErrorCode = (typeof BLENDER_BRIDGE_SERVER_ERROR_CODES)[number]

/** Codes the CLIENT mints locally (transport truth; the unity set kept
 *  verbatim — EDITOR_UNREACHABLE's editor is Blender here). */
export const BLENDER_BRIDGE_CLIENT_ERROR_CODES = [
  'AUTH_FAILED', // relayed from the handshake error frame
  'HANDSHAKE_CLOSED', // connect/hello never completed
  'CONNECTION_LOST', // socket died mid-flight (a quit Blender lands here)
  'EDITOR_UNREACHABLE', // inside the reconnect fast-fail window
  'REQUEST_TIMEOUT', // per-request deadline elapsed, op named
  'CLIENT_CLOSED', // the session client was closed
  'BAD_FRAME', // an answer frame without a lawful body
  'BRIDGE_VERSION_SKEW', // hello answered with a foreign result.version
] as const
export type BlenderBridgeClientErrorCode = (typeof BLENDER_BRIDGE_CLIENT_ERROR_CODES)[number]

export interface BlenderBridgeError {
  code: string
  message: string
  hint?: string
}
export type BlenderBridgeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: BlenderBridgeError }

// ── the verb table ───────────────────────────────────────────────────────────

export type BlenderBridgeVerbClass = 'read' | 'mutate' | 'exec'

export interface BlenderBridgeVerbSpec {
  cls: BlenderBridgeVerbClass
  summary: string
  /** arg name → short human type/shape note (validation is add-on-side;
   *  path FENCES are Mercury-side — the tool resolves and fences before
   *  sending, because only Mercury knows the context root). */
  args: Readonly<Record<string, string>>
}

/** The wire verbs, whole. The tool's LOCAL ops (blender_status /
 *  blender_bridge_install / blender_bridge_uninstall) are Mercury-side and
 *  never reach this wire — they live in the tool, the GodotTool LOCAL_OPS
 *  grammar. */
export const BLENDER_BRIDGE_VERBS = {
  scene_info: {
    cls: 'read',
    summary:
      'File + scene truth: blend filepath ("" while unsaved), is_saved, is_dirty, Blender version, scenes (name, isActive), active-scene frame current/start/end, render engine, context mode + active object',
    args: {},
  },
  objects_list: {
    cls: 'read',
    summary:
      'The outliner truth: per-scene collection tree + objects (name, type, visible, children), bounded by maxObjects with the truncation counted honestly (count-all, keep-capped)',
    args: {
      sceneName: 'optional — limit to the named scene (default: every scene)',
      maxObjects: `optional number — node cap (default ${BLENDER_BRIDGE_OBJECTS_NODE_CAP})`,
    },
  },
  blend_open: {
    cls: 'mutate',
    summary:
      'Open a .blend by absolute path (the tool fences context-relative spellings before sending); unsaved work refuses BLEND_DIRTY naming the save road, never a silent discard. THE NO-RELOAD PIN: the connection HOLDS across the open',
    args: {
      path: 'absolute .blend path (the tool resolves and fences before sending)',
    },
  },
  render_state: {
    cls: 'read',
    summary:
      'Render truth: is_job_running per job type (RENDER, RENDER_PREVIEW, COMPOSITE, OBJECT_BAKE), engine, resolution + percentage, output path, frame range — readable DURING a render by design',
    args: {},
  },
  render_still: {
    cls: 'exec',
    summary:
      'Render the current (or named) frame as an editor JOB writing to outputPath; answers {started:true} immediately, ONE render at a time (RENDER_ACTIVE otherwise); the DURABLE result is the image file at outputPath, plus the render_finished event on the connected fast path',
    args: {
      outputPath:
        'absolute output image path (the tool resolves and fences before sending); the file at this path is the durable result',
      frame: 'optional number — frame to render (default: the current frame)',
    },
  },
  report_tail: {
    cls: 'read',
    summary:
      'The add-on’s honest report ring (Python logging records, the bridge’s own operation reports, render/load/save lifecycle events via bpy.app.handlers), severity-classed, newest-last, dropped-count honest. C-level terminal prints never pass Python logging — the ring carries what Python can see',
    args: {
      limit: 'optional number — max entries returned (default 100)',
      severity: 'optional — minimum severity: debug | info | warning | error',
    },
  },
  python_run: {
    cls: 'exec',
    summary:
      'Execute Python source inside Blender on the main thread (exec with a persistent namespace; a variable named `result` answers as its repr). NO sandbox, NO preemption — both sentences are contract; stdout/stderr captured and capped with truncation counted; a raise answers PYTHON_EXCEPTION honestly',
    args: {
      source: `Python source to exec inside Blender (≤ ${BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES} bytes; stdout/stderr each capped at ${BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES} bytes, truncation counted)`,
    },
  },
} as const satisfies Record<string, BlenderBridgeVerbSpec>

export type BlenderBridgeVerb = keyof typeof BLENDER_BRIDGE_VERBS

export function blenderBridgeVerb(op: string): BlenderBridgeVerbSpec | undefined {
  return (BLENDER_BRIDGE_VERBS as Record<string, BlenderBridgeVerbSpec>)[op]
}

export function blenderBridgeVerbNames(): BlenderBridgeVerb[] {
  return Object.keys(BLENDER_BRIDGE_VERBS) as BlenderBridgeVerb[]
}

// ── result shapes ────────────────────────────────────────────────────────────

/** The hello answer's result. */
export interface BlenderBridgeHelloInfo {
  version: number
  /** "mercury_blender_bridge/<add-on version>". */
  bridge: string
  /** bpy.app.version_string ("The Blender version formatted as a string"). */
  blender: string
  /** bpy.data.filepath — "" while the session is unsaved. */
  blendFile: string
  /** bpy.app.background — true under `blender -b` (no UI). */
  background: boolean
}

export interface BlenderBridgeSceneRow {
  name: string
  isActive: boolean
}
export interface BlenderBridgeSceneInfo {
  blendFile: string
  isSaved: boolean
  isDirty: boolean
  blender: string
  scenes: BlenderBridgeSceneRow[]
  frameCurrent: number
  frameStart: number
  frameEnd: number
  /** scene.render.engine (e.g. BLENDER_EEVEE_NEXT, CYCLES). */
  engine: string
  /** bpy.context.mode (e.g. OBJECT, EDIT_MESH, SCULPT). */
  mode: string
  activeObject: string | null
}

export interface BlenderBridgeObjectNode {
  name: string
  /** Object type (MESH, LIGHT, CAMERA, …) or 'COLLECTION' for tree nodes. */
  type: string
  visible: boolean
  children: BlenderBridgeObjectNode[]
}
export interface BlenderBridgeObjectsList {
  scenes: Array<{ name: string; roots: BlenderBridgeObjectNode[] }>
  nodeCount: number
  /** Nodes beyond the cap (0 = the walk is complete). */
  truncatedNodes: number
}

export interface BlenderBridgeRenderState {
  jobs: {
    render: boolean
    renderPreview: boolean
    composite: boolean
    objectBake: boolean
  }
  engine: string
  resolutionX: number
  resolutionY: number
  resolutionPercentage: number
  /** scene.render.filepath (the scene's own output setting, NOT a fence). */
  outputPath: string
  frameCurrent: number
  frameStart: number
  frameEnd: number
}

export interface BlenderBridgeRenderStarted {
  started: true
  outputPath: string
  frame: number
}

export type BlenderReportSeverity = 'debug' | 'info' | 'warning' | 'error'
export interface BlenderReportEntry {
  severity: BlenderReportSeverity
  message: string
  /** Where the entry came from: 'logging' | 'bridge' | 'handler'. */
  source: string
  /** Add-on-side receipt time, ms since epoch. */
  at: number
}
export interface BlenderReportTail {
  entries: BlenderReportEntry[]
  /** Ring evictions since arming (dropped-oldest, counted honestly). */
  dropped: number
}

export interface BlenderBridgePythonRunResult {
  /** repr(namespace['result']) when the source set one, else null. */
  value: string | null
  stdout: string
  stderr: string
  /** Bytes cut beyond the output caps (0 = complete). */
  truncated: { stdout: number; stderr: number }
  elapsedMs: number
}

// ── events ───────────────────────────────────────────────────────────────────

export const BLENDER_BRIDGE_EVENTS = ['render_finished', 'blend_changed'] as const
export type BlenderBridgeEventName = (typeof BLENDER_BRIDGE_EVENTS)[number]

/** From the render_complete/render_cancel handlers (ok=false ⇒ cancelled). */
export interface BlenderBridgeRenderFinishedEvent {
  outputPath: string
  frame: number
  ok: boolean
  cancelled: boolean
  durationMs: number
}
/** From the @persistent load_post handler — a by-hand open in the UI
 *  surfaces on the next op's event drain (the connection HOLDS: no-reload). */
export interface BlenderBridgeBlendChangedEvent {
  filepath: string
}

// ── frame helpers (pure; both the client and the fake bridge ride these) ─────

export function buildBlenderBridgeHelloFrame(token: string): string {
  return (
    JSON.stringify({
      op: 'hello',
      token,
      role: 'client',
      version: BLENDER_BRIDGE_PROTOCOL_VERSION,
    }) + '\n'
  )
}

export function buildBlenderBridgeRequestFrame(
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
export type BlenderBridgeParsedFrame =
  | { kind: 'response'; id: number; ok: boolean; result?: unknown; error?: BlenderBridgeError }
  | { kind: 'hello-reply'; ok: boolean; result?: unknown; error?: BlenderBridgeError }
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'unknown'; raw: string }

export function parseBlenderBridgeFrame(line: string): BlenderBridgeParsedFrame {
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
      ? (f.error as unknown as BlenderBridgeError)
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
