
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import {
  getBlenderBridgeClient,
  probeBlenderBridgeReachable,
  blenderBridgeHint,
} from '../../services/blender/bridgeClient.js'
import {
  formatHeadlessWindowRefusal,
  isHeadlessRenderJobRequest,
  runBlenderHeadlessOp,
} from '../../services/blender/headlessRunner.js'
import {
  blenderBridgeVerb,
  blenderBridgeVerbNames,
} from '../../services/blender/bridgeProtocol.js'
import { locateBlender } from '../../services/ide/blenderProject.js'
import { blenderBridgeEnabled, blenderBridgePort } from '../../utils/blender/bridgeGates.js'
import { BLENDER_TOOL_NAME, getBlenderToolDescription } from './prompt.js'
import { SHOWN_AT_MOST, SHOW_SHAPE_RULE, parseShowList, readShown, showTargets, stampShown, type ShowEntry, type ShownPart } from './show.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('Blender operation, from the ops list.'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('The operation\'s arguments.'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: string
  result: string
  shown?: ShownPart[]
}

const LOCAL_OPS = new Set(['blender_status', 'blender_bridge_install', 'blender_bridge_uninstall'])
const LOCAL_MUTATES = new Set(['blender_bridge_install', 'blender_bridge_uninstall'])

const PATH_ARGS: Record<string, string> = { blend_open: 'path', render_still: 'outputPath' }

function realpathNearest(target: string): string {
  let existing = target
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0
        ? realpathSync(existing)
        : path.join(realpathSync(existing), ...tail)
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return target
      tail.unshift(path.basename(existing))
      existing = parent
    }
  }
}

function resolveInsideTree(
  op: string,
  key: string,
  rawPath: string,
): { resolved?: string; refusal?: string } {
  const cwd = realpathNearest(path.resolve(getCwd()))
  const resolved = realpathNearest(path.resolve(path.resolve(getCwd()), rawPath))
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return {
      refusal:
        `${op}: ${key} must stay inside the working tree (${cwd}) — got ${resolved}. ` +
        `Nothing was sent to Blender; move the target inside the tree (python_run can act elsewhere, behind its own ask).`,
    }
  }
  return { resolved }
}

function fencePathArgs(
  op: string,
  args: Record<string, unknown> | undefined,
): { args?: Record<string, unknown>; refusal?: string } {
  if (!args) return { args }
  const next: Record<string, unknown> = { ...args }
  const primaryKey = PATH_ARGS[op]
  if (primaryKey && typeof next[primaryKey] === 'string') {
    const check = resolveInsideTree(op, primaryKey, next[primaryKey] as string)
    if (check.refusal) return { refusal: check.refusal }
    next[primaryKey] = check.resolved
  }
  if (op === 'python_run' && typeof next.script === 'string' && next.script.length > 0) {
    const check = resolveInsideTree(op, 'script', next.script)
    if (check.refusal) return { refusal: check.refusal }
    next.script = check.resolved
  }
  if (typeof next.blend === 'string') {
    const check = resolveInsideTree(op, 'blend', next.blend)
    if (check.refusal) return { refusal: check.refusal }
    next.blend = check.resolved
  } else if (op !== 'blend_open' && typeof next.path === 'string') {
    const check = resolveInsideTree(op, 'path', next.path)
    if (check.refusal) return { refusal: check.refusal }
    next.path = check.resolved
  }
  return { args: next }
}

function readTargets(input: Input): string[] {
  if (!blenderBridgeVerb(input.op)) return []
  const args = input.args
  const blend = typeof args?.blend === 'string' ? args.blend : undefined
  const named = typeof args?.path === 'string' && (input.op === 'blend_open' || blend === undefined) ? args.path : undefined
  const script = input.op === 'python_run' && typeof args?.script === 'string' ? args.script : undefined
  return [
    ...[blend, named, script]
      .filter((target): target is string => target !== undefined && target.length > 0)
      .map(target => path.resolve(getCwd(), target)),
    ...showTargets(showEntriesOf(input).slice(0, SHOWN_AT_MOST)),
  ]
}

function showEntriesOf(input: Input): ShowEntry[] {
  if (input.op === 'render_still') {
    const target = input.args?.show === true ? input.args.outputPath : undefined
    return typeof target === 'string' && target.length > 0 ? [{ path: target }] : []
  }
  if (input.op !== 'python_run') return []
  const parsed = parseShowList(input.args?.show)
  return 'entries' in parsed ? parsed.entries : []
}

type RoadTrace = { road?: 'headless' | 'bridge'; taken?: boolean }

async function shownAfter(
  input: Input,
  entries: readonly ShowEntry[],
  before: ReturnType<typeof stampShown>,
  trace: RoadTrace,
): Promise<ShownPart[]> {
  if (entries.length === 0 || trace.road === undefined) return []
  if (input.op === 'render_still' && trace.road === 'bridge') {
    return trace.taken ? [{ kind: 'note', text: `show: the picture is not written yet; it will land at ${showTargets(entries)[0]}` }] : []
  }
  return readShown(entries, before)
}

function showNamed(entries: readonly ShowEntry[], cap = 160): string {
  const names = entries.map(entry => entry.path).join(', ')
  return names.length > cap ? names.slice(0, cap - 1) + '…' : names
}

function firstSourceLine(args: Record<string, unknown> | undefined): string {
  const source = typeof args?.source === 'string' ? args.source : ''
  const line = source.split('\n', 1)[0] ?? ''
  return line.length > 120 ? line.slice(0, 117) + '…' : line
}

function sourceBytes(args: Record<string, unknown> | undefined): number {
  return typeof args?.source === 'string' ? Buffer.byteLength(args.source, 'utf8') : 0
}

function scriptOf(args: Record<string, unknown> | undefined): string | undefined {
  return typeof args?.script === 'string' && args.script.length > 0 ? args.script : undefined
}

function argvOf(args: Record<string, unknown> | undefined): string[] {
  return Array.isArray(args?.argv) ? args.argv.filter((word): word is string => typeof word === 'string') : []
}

function pythonRunShapeProblem(args: Record<string, unknown> | undefined): string | undefined {
  const hasSource = typeof args?.source === 'string' && args.source.length > 0
  const hasScript = scriptOf(args) !== undefined
  if (hasSource === hasScript) {
    return `python_run takes exactly one of source (Python text) or script (a file inside the working tree; argv, a list of strings, are its arguments) — got ${hasSource ? 'both' : 'neither'}. Nothing was sent to Blender.`
  }
  if (args?.argv !== undefined) {
    if (!hasScript) return 'python_run: argv comes only with script. Nothing was sent to Blender.'
    if (!Array.isArray(args.argv) || args.argv.some(word => typeof word !== 'string')) {
      return 'python_run: argv must be a list of strings. Nothing was sent to Blender.'
    }
  }
  if ('problem' in parseShowList(args?.show)) return `python_run: ${SHOW_SHAPE_RULE}. Nothing was sent to Blender.`
  return undefined
}

function scriptCallShown(args: Record<string, unknown> | undefined, cap = 160): string {
  const argv = argvOf(args)
  const shown = `${scriptOf(args) ?? ''}${argv.length > 0 ? ` -- ${argv.join(' ')}` : ''}`
  return shown.length > cap ? shown.slice(0, cap - 1) + '…' : shown
}

function scriptAsBridgeSource(script: string, argv: string[]): string {
  return [
    'def _mercury_run_script():',
    '    import sys',
    `    script = ${JSON.stringify(script)}`,
    '    saved = sys.argv',
    `    sys.argv = [saved[0] if saved else "blender", "--python", script, "--"] + ${JSON.stringify(argv)}`,
    '    names = {"__name__": "__main__", "__file__": script}',
    '    try:',
    '        with open(script, "rb") as handle:',
    '            code = compile(handle.read(), script, "exec")',
    '        exec(code, names)',
    '    finally:',
    '        sys.argv = saved',
    '    return names',
    'try:',
    '    _mercury_script_names = _mercury_run_script()',
    '    if "result" in _mercury_script_names:',
    '        result = _mercury_script_names["result"]',
    '    del _mercury_script_names',
    'finally:',
    '    del _mercury_run_script',
  ].join('\n')
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2) ?? String(result)
}

function summarizeArgs(args: Record<string, unknown> | undefined, cap = 160): string {
  if (!args || Object.keys(args).length === 0) return ''
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s
}

async function runLocalOp(op: string): Promise<string> {
  const installer = await import('../../services/blender/bridgeInstaller.js')
  switch (op) {
    case 'blender_status':
      return installer.describeBlenderBridgeStatus()
    case 'blender_bridge_install':
      return installer.applyBlenderBridgeInstall()
    case 'blender_bridge_uninstall':
      return installer.applyBlenderBridgeUninstall()
    default:
      return `unknown local op ${op}`
  }
}

function withoutShow(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (args === undefined || !('show' in args)) return args
  const { show: _shown, ...rest } = args
  return rest
}

async function runOp(input: Input, abortSignal?: AbortSignal, trace?: RoadTrace): Promise<string> {
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op)
  const spec = blenderBridgeVerb(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — the wire verbs: ${blenderBridgeVerbNames().join(', ')}; local: blender_status, blender_bridge_install, blender_bridge_uninstall (the tool description carries the full catalog)`
  }
  if (input.op === 'python_run') {
    const problem = pythonRunShapeProblem(input.args)
    if (problem) return problem
  }
  const fenced = fencePathArgs(input.op, withoutShow(input.args))
  if (fenced.refusal) return fenced.refusal
  if (!blenderBridgeEnabled()) {
    return `the Blender bridge is not available here (flag off, no addon home resolves, or no session token on disk: op:"blender_bridge_install" writes it) — op:"blender_status" explains`
  }
  const port = blenderBridgePort()
  const client = getBlenderBridgeClient()
  const bridgeReachable =
    client !== null &&
    (client.status() === 'ready' || (await probeBlenderBridgeReachable(port)))
  if (!bridgeReachable) {
    const census = locateBlender()
    if (census.blender) {
      if (isHeadlessRenderJobRequest(input.op, fenced.args)) {
        return formatHeadlessWindowRefusal(port)
      }
      const blend =
        typeof fenced.args?.blend === 'string'
          ? fenced.args.blend
          : input.op !== 'blend_open' && typeof fenced.args?.path === 'string'
            ? fenced.args.path
            : undefined
      if (trace) trace.road = 'headless'
      return runBlenderHeadlessOp({
        bin: census.blender.path,
        op: input.op,
        args: fenced.args,
        blend,
        abortSignal,
      })
    }
    if (!client) {
      return `the Blender bridge is not available here (flag off, no addon home resolves, or no session token on disk: op:"blender_bridge_install" writes it) — op:"blender_status" explains`
    }
  }
  const bridgeScript = input.op === 'python_run' ? scriptOf(fenced.args) : undefined
  const wireArgs =
    bridgeScript !== undefined ? { source: scriptAsBridgeSource(bridgeScript, argvOf(fenced.args)) } : fenced.args
  if (trace) trace.road = 'bridge'
  const r = await client.request(input.op, wireArgs, 30_000, abortSignal)
  if (trace) trace.taken = r.ok
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  const events = client.drainEvents()
  if (events.length > 0) {
    const shown = events.slice(-8)
    text +=
      `\n\nevents (${events.length}):\n` +
      shown.map(e => `· ${e.event}: ${formatResult(e.data).slice(0, 200)}`).join('\n')
  }
  return `road: bridge (127.0.0.1:${port})\n${text}`
}

export const BlenderTool = buildTool({
  name: BLENDER_TOOL_NAME,
  get searchHint() {
    return 'Blender with no window, or a running one: run Python or a script, render a still, read the scene'
  },
  searchKeywords: ['headless', 'background'],
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run Blender in the background with no window when no bridge answers, or drive a running Blender when one does: run Python or a script, render a still, read the scene and its objects, open a .blend, read the render state and the report tail'
  },
  async prompt() {
    return getBlenderToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  capability: {
    intents: [
      'inspect a blender scene: objects, render settings, reports',
      'open or verify a blend file in blender (bridge or headless -b)',
      'render a still frame from blender (bridge job or headless -b)',
      'run python with bpy inside blender (bridge or headless -b)',
      'check located blender, embedded python, and mercury bridge status',
    ],
    units: ['3d-scene'],
    class: 'mutation',
    operations: [...blenderBridgeVerbNames(), ...LOCAL_OPS],
    evidence: ['artifact'],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_BLENDER',
    conditions: [
      'a .blend file under the project, or a located Blender (MERCURY_BLENDER_BIN, a blender on PATH, the app bundle, Program Files)',
      'either a running Blender with the mercury_blender_bridge add-on installed and enabled, or a located Blender binary for the headless -b road (one process per call)',
    ],
    proof: 'scripts/blender-bridge/run-all.sh',
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return blenderBridgeVerb(input.op)?.cls === 'read' || input.op === 'blender_status'
  },
  async checkPermissions(input: Input, context) {
    const permission = context?.getAppState?.().toolPermissionContext
    if (permission !== undefined) {
      for (const target of readTargets(input)) {
        const read = checkReadPermissionForTool({ name: BLENDER_TOOL_NAME, getPath: () => target }, input, permission)
        if (read.behavior === 'deny') return read
      }
    }
    if (LOCAL_MUTATES.has(input.op)) {
      return {
        behavior: 'ask' as const,
        message:
          input.op === 'blender_bridge_install'
            ? `Blender mutate: ${input.op} — materializes the mercury_blender_bridge add-on, its token, and any port config.json into the user addon home (enabling it in Blender stays your act)`
            : `Blender mutate: ${input.op} removes the entire mercury_blender_bridge add-on directory (token and config included) from the user addon home`,
      }
    }
    const spec = blenderBridgeVerb(input.op)
    if (!spec || spec.cls === 'read') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (spec.cls === 'exec') {
      if (input.op === 'python_run') {
        const script = scriptOf(input.args)
        return {
          behavior: 'ask' as const,
          message:
            (script !== undefined
              ? `Blender exec: python_run (script ${scriptCallShown(input.args)}) — runs the file INSIDE Blender with full bpy authority `
              : `Blender exec: python_run (${sourceBytes(input.args)} bytes) — runs Python INSIDE Blender with full bpy authority `) +
            `(it can modify or delete scene data and write files as you; no sandbox, no preemption — a runaway script blocks Blender). ` +
            `With no bridge answering, a background Blender with no window is started for this call and ends with it.` +
            (showEntriesOf(input).length > 0 ? ` Shows: ${showNamed(showEntriesOf(input))}.` : '') +
            (script !== undefined ? '' : ` first line: ${firstSourceLine(input.args) || '(empty)'}`),
        }
      }
      return {
        behavior: 'ask' as const,
        message: `Blender exec: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — starts a render job in Blender; the durable result is the image file at outputPath (render_finished reports the end). With no bridge answering, a background Blender with no window renders it before the call returns, and ends.`,
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Blender mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} switches the open .blend (no undo step; refuses with BLEND_DIRTY if there are unsaved changes). With no bridge answering, a background Blender with no window opens the file to check it and ends; nothing stays open.`,
    }
  },
  async validateInput(input: Input) {
    if (!input.op || input.op.trim().length === 0) {
      return { result: false as const, message: 'op is required', errorCode: 1 }
    }
    if (input.op === 'python_run') {
      const problem = pythonRunShapeProblem(input.args)
      if (problem) return { result: false as const, message: problem, errorCode: 2 }
    }
    return { result: true as const }
  },
  async call(input: Input, context) {
    let result: string
    const entries = showEntriesOf(input)
    const before = entries.length > 0 ? stampShown(entries) : []
    const trace: RoadTrace = {}
    try {
      result = await runOp(input, context?.abortController?.signal, trace)
    } catch (err) {
      result = `${input.op} failed: ${(err as Error).message}\nhint: ${blenderBridgeHint(blenderBridgePort())}`
    }
    const shown = await shownAfter(input, entries, before, trace)
    const output: Output = { op: input.op, result, ...(shown.length > 0 ? { shown } : {}) }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (output.shown !== undefined && output.shown.length > 0) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result' as const,
        content: [
          { type: 'text' as const, text: output.result },
          ...output.shown.flatMap(part =>
            part.kind === 'note'
              ? [{ type: 'text' as const, text: part.text }]
              : [
                  { type: 'text' as const, text: part.caption },
                  { type: 'image' as const, source: { type: 'base64' as const, media_type: part.mediaType, data: part.base64 } },
                ],
          ),
        ],
      }
    }
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ result }) {
    return result ?? ''
  },
})
