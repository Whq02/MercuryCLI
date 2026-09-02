// ============================================================================
//  Blender tool — the agent-facing surface of the Blender add-on bridge
//  (services/blender/bridgeClient.ts holds the protocol client,
//  services/blender/bridgeProtocol.ts the version-1 contract; the UnityTool
//  is the grammar this mirrors). Catalog-gated by
//  blenderBridgeToolCatalogEnabled() in tools.ts (the one Blender switch
//  MERCURY_BLENDER + a .blend context). Permission classes ride the
//  contract table: read ⇒ allow, mutate ⇒ ask (blend_open is a file
//  SWITCH, not an undo step — the message says what actually happens),
//  exec ⇒ ask ALWAYS (python_run's ask carries the code's byte count and
//  first line; the two danger sentences are contract and live in the tool
//  description). PATH FENCE: blend_open/render_still paths resolve against
//  the working directory and must stay inside it — enforced HERE, before
//  the wire, because only Mercury knows the context root. No store road
//  (the named-absence ruling: an image is not a test run). Proofs:
//  scripts/blender-bridge/.
// ============================================================================

import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getBlenderBridgeClient,
  blenderBridgeHint,
} from '../../services/blender/bridgeClient.js'
import {
  blenderBridgeVerb,
  blenderBridgeVerbNames,
} from '../../services/blender/bridgeProtocol.js'
import { blenderBridgePort } from '../../utils/blender/bridgeGates.js'
import { BLENDER_TOOL_NAME, getBlenderToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('The Blender operation (see the op catalog in the tool description)'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Operation arguments (validated bridge-side; errors return actionable hints)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: string
  result: string
}

/** Ops the Mercury side answers locally (never sent to Blender). */
const LOCAL_OPS = new Set(['blender_status', 'blender_bridge_install', 'blender_bridge_uninstall'])
/** Local ops that write into the user addon home — mutate-class asks. */
const LOCAL_MUTATES = new Set(['blender_bridge_install', 'blender_bridge_uninstall'])

/** The args that carry filesystem paths, per verb — resolved against the
 *  working directory and FENCED inside it before the wire (the tool-side
 *  fence: only Mercury knows the context root). */
const PATH_ARGS: Record<string, string> = { blend_open: 'path', render_still: 'outputPath' }

/** realpath the target's nearest EXISTING ancestor (the target itself may
 *  not exist yet — render_still's output), keeping the not-yet-existing
 *  tail lexical. Symlinks can therefore never smuggle a path outside the
 *  fence (realpath BOTH sides — the house law). */
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
      if (parent === existing) return target // no existing ancestor at all
      tail.unshift(path.basename(existing))
      existing = parent
    }
  }
}

function fencePathArgs(
  op: string,
  args: Record<string, unknown> | undefined,
): { args?: Record<string, unknown>; refusal?: string } {
  const key = PATH_ARGS[op]
  if (!key || !args || typeof args[key] !== 'string') return { args }
  const cwd = realpathNearest(path.resolve(getCwd()))
  const resolved = realpathNearest(path.resolve(path.resolve(getCwd()), args[key] as string))
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    return {
      refusal:
        `${op}: ${key} must stay inside the working tree (${cwd}) — got ${resolved}. ` +
        `Nothing was sent to Blender; move the target inside the tree (python_run can act elsewhere, behind its own ask).`,
    }
  }
  return { args: { ...args, [key]: resolved } }
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

async function runOp(input: Input): Promise<string> {
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op)
  const spec = blenderBridgeVerb(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — the wire verbs: ${blenderBridgeVerbNames().join(', ')}; local: blender_status, blender_bridge_install, blender_bridge_uninstall (the tool description carries the full catalog)`
  }
  const fenced = fencePathArgs(input.op, input.args)
  if (fenced.refusal) return fenced.refusal
  const client = getBlenderBridgeClient()
  if (!client) {
    return `the Blender bridge is not available here (flag off, or no addon home resolves — no token address) — op:"blender_status" explains`
  }
  const r = await client.request(input.op, fenced.args, 30_000)
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  // Blender events (finished renders, by-hand file opens) ride the same
  // connection — surface anything buffered since the last op. No store
  // persist behind this drain: the named-absence ruling (the render's
  // durable artifact is the image file itself).
  const events = client.drainEvents()
  if (events.length > 0) {
    const shown = events.slice(-8)
    text +=
      `\n\nevents (${events.length}):\n` +
      shown.map(e => `· ${e.event}: ${formatResult(e.data).slice(0, 200)}`).join('\n')
  }
  return text
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
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false // one Blender, ordered ops
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
            : `Blender mutate: ${input.op} — removes the mercury_blender_bridge add-on directory WHOLE (token and config included) from the user addon home`,
      }
    }
    const spec = blenderBridgeVerb(input.op)
    // Unknown ops flow to call() for the teaching answer — allowing here is
    // safe because runOp answers them locally without reaching Blender.
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
    // blend_open: a file SWITCH, not an undo step — say what actually
    // happens instead of promising Ctrl+Z.
    return {
      behavior: 'ask' as const,
      message: `Blender mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — switches the open .blend (no undo step; unsaved work refuses with BLEND_DIRTY rather than being discarded)`,
    }
  },
  toAutoClassifierInput(input: Input) {
    const spec = blenderBridgeVerb(input.op)
    if (LOCAL_MUTATES.has(input.op)) return `blender mutate: ${input.op}`
    if (!spec || spec.cls === 'read') return ''
    if (input.op === 'python_run') {
      const source = typeof input.args?.source === 'string' ? input.args.source : ''
      return `blender exec: python_run ${source.slice(0, 300)}`
    }
    return `blender ${spec.cls}: ${input.op} ${summarizeArgs(input.args, 300)}`
  },
  async validateInput(input: Input) {
    if (!input.op || input.op.trim().length === 0) {
      return { result: false as const, message: 'op is required', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input) {
    let result: string
    try {
      result = await runOp(input)
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
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result ?? ''
  },
})
