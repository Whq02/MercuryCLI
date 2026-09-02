
export const BLENDER_BRIDGE_PROTOCOL_VERSION = 1

export const BLENDER_BRIDGE_DEFAULT_PORT = 6012

export const BLENDER_BRIDGE_MAX_LINE_BYTES = 8 * 1024 * 1024

export const BLENDER_BRIDGE_OBJECTS_NODE_CAP = 2_000
export const BLENDER_BRIDGE_REPORT_RING_CAP = 1_000

export const BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES = 64 * 1024
export const BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES = 32 * 1024

export const BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE =
  'python_run claims NO sandbox: the code runs inside Blender with full bpy authority — it can modify or delete scene data and write files as you; the permission ask is the fence.'
export const BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE =
  'python_run has NO preemption: bpy cannot abort a running script — a runaway script blocks Blender until it finishes (the client times out; the server cannot cancel).'


export const BLENDER_BRIDGE_SERVER_ERROR_CODES = [
  'AUTH_FAILED',
  'VERSION_SKEW',
  'UNKNOWN_OP',
  'BAD_ARGS',
  'RENDER_ACTIVE',
  'BLEND_NOT_FOUND',
  'BLEND_DIRTY',
  'PYTHON_EXCEPTION',
  'INTERNAL',
] as const
export type BlenderBridgeServerErrorCode = (typeof BLENDER_BRIDGE_SERVER_ERROR_CODES)[number]

export const BLENDER_BRIDGE_CLIENT_ERROR_CODES = [
  'AUTH_FAILED',
  'HANDSHAKE_CLOSED',
  'CONNECTION_LOST',
  'EDITOR_UNREACHABLE',
  'REQUEST_TIMEOUT',
  'CLIENT_CLOSED',
  'BAD_FRAME',
  'BRIDGE_VERSION_SKEW',
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


export type BlenderBridgeVerbClass = 'read' | 'mutate' | 'exec'

export interface BlenderBridgeVerbSpec {
  cls: BlenderBridgeVerbClass
  summary: string
  args: Readonly<Record<string, string>>
}

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


export interface BlenderBridgeHelloInfo {
  version: number
  bridge: string
  blender: string
  blendFile: string
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
  engine: string
  mode: string
  activeObject: string | null
}

export interface BlenderBridgeObjectNode {
  name: string
  type: string
  visible: boolean
  children: BlenderBridgeObjectNode[]
}
export interface BlenderBridgeObjectsList {
  scenes: Array<{ name: string; roots: BlenderBridgeObjectNode[] }>
  nodeCount: number
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
  source: string
  at: number
}
export interface BlenderReportTail {
  entries: BlenderReportEntry[]
  dropped: number
}

export interface BlenderBridgePythonRunResult {
  value: string | null
  stdout: string
  stderr: string
  truncated: { stdout: number; stderr: number }
  elapsedMs: number
}


export const BLENDER_BRIDGE_EVENTS = ['render_finished', 'blend_changed'] as const
export type BlenderBridgeEventName = (typeof BLENDER_BRIDGE_EVENTS)[number]

export interface BlenderBridgeRenderFinishedEvent {
  outputPath: string
  frame: number
  ok: boolean
  cancelled: boolean
  durationMs: number
}
export interface BlenderBridgeBlendChangedEvent {
  filepath: string
}


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
