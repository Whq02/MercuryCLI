
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
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

function firstSourceLine(args: Record<string, unknown> | undefined): string {
  const source = typeof args?.source === 'string' ? args.source : ''
  const line = source.split('\n', 1)[0] ?? ''
  return line.length > 120 ? line.slice(0, 117) + '…' : line
}

function sourceBytes(args: Record<string, unknown> | undefined): number {
  return typeof args?.source === 'string' ? Buffer.byteLength(args.source, 'utf8') : 0
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

async function runOp(input: Input, abortSignal?: AbortSignal): Promise<string> {
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op)
  const spec = blenderBridgeVerb(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — the wire verbs: ${blenderBridgeVerbNames().join(', ')}; local: blender_status, blender_bridge_install, blender_bridge_uninstall (the tool description carries the full catalog)`
  }
  const fenced = fencePathArgs(input.op, input.args)
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
  const r = await client.request(input.op, fenced.args, 30_000)
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
    return 'Blender control (the Mercury bridge): scene/objects truth, blend opens, still renders, report tail, python_run'
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive the running Blender: scene and object truth, .blend opens, render state and still renders, the report tail, and python_run'
  },
  async prompt() {
    return getBlenderToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  capability: {
    intents: [
      'inspect a blender scene: objects, render settings, reports',
      'open a blend file in the running blender',
      'render a still from the running blender',
      'run python inside the running blender',
      'check whether blender and its mercury add-on are reachable',
    ],
    units: ['3d-scene'],
    class: 'mutation',
    evidence: ['artifact'],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_BLENDER',
    conditions: [
      'a .blend file under the project, or a located Blender (MERCURY_BLENDER_BIN, a blender on PATH, the app bundle, Program Files)',
      'a running Blender with the mercury_blender_bridge add-on installed and enabled',
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
  async checkPermissions(input: Input) {
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
        return {
          behavior: 'ask' as const,
          message:
            `Blender exec: python_run (${sourceBytes(input.args)} bytes) — runs Python INSIDE Blender with full bpy authority ` +
            `(it can modify or delete scene data and write files as you; no sandbox, no preemption — a runaway script blocks Blender). ` +
            `first line: ${firstSourceLine(input.args) || '(empty)'}`,
        }
      }
      return {
        behavior: 'ask' as const,
        message: `Blender exec: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — starts a render job in Blender; the durable result is the image file at outputPath (render_finished reports the end)`,
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Blender mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} switches the open .blend (no undo step; refuses with BLEND_DIRTY if there are unsaved changes)`,
    }
  },
  async validateInput(input: Input) {
    if (!input.op || input.op.trim().length === 0) {
      return { result: false as const, message: 'op is required', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context) {
    let result: string
    try {
      result = await runOp(input, context?.abortController?.signal)
    } catch (err) {
      result = `${input.op} failed: ${(err as Error).message}\nhint: ${blenderBridgeHint(blenderBridgePort())}`
    }
    const output: Output = { op: input.op, result }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
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
