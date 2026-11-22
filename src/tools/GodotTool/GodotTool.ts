import type { UUID } from 'node:crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { findGodotProjectRoot } from '../../services/lsp/godotLane.js'
import type { ChangeRecordRoad } from '../../services/vulcan/addonInstaller.js'
import { resolveVulcanClient, type VulcanResult } from '../../services/vulcan/vulcanClient.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../services/changeTransaction/fileHistory.js'
import { vulcanLiteMode } from '../../services/vulcan/vulcanGates.js'
import { VULCAN_STEP_WALL_MS_PER_FRAME, vulcanOp, vulcanCategories } from '../../utils/vulcan/optable.generated.js'
import { GODOT_TOOL_NAME, getGodotToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('Godot operation, from the ops list.'),
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

const UNREACHABLE_CODES = new Set(['HANDSHAKE_CLOSED', 'CONNECTION_LOST', 'CLIENT_CLOSED'])

const FILE_MUTATES = new Set(['import_set', 'refactor_rename_signal', 'refactor_rename_export', 'vulcan_install', 'vulcan_uninstall'])

function changeRecordRoad(context: ToolUseContext, parentMessage: AssistantMessage): ChangeRecordRoad {
  return {
    before: async file => {
      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(context.updateFileHistoryState, file, parentMessage.uuid as UUID)
      }
    },
  }
}

async function staticCapsuleAnswer(input: Input): Promise<string> {
  const root = findGodotProjectRoot()
  if (!root) return `no project.godot found from the working directory — open/cd into a Godot project first`
  const [{ staticGodotCapsule }, { vulcanEditorPresence }] = await Promise.all([
    import('../../services/vulcan/godotCapsule.js'),
    import('../../services/vulcan/addonInstaller.js'),
  ])
  return formatResult(staticGodotCapsule(root, input.args?.budget, await vulcanEditorPresence(root)))
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

async function runLocalOp(
  op: string,
  args: Record<string, unknown> | undefined,
  context: ToolUseContext,
  parentMessage: AssistantMessage,
): Promise<string> {
  const installer = await import('../../services/vulcan/addonInstaller.js')
  const root = findGodotProjectRoot()
  if (!root) {
    return `no project.godot found from the working directory — open/cd into a Godot project first`
  }
  const { ENGINE_OPS, runEngineOp } = await import('../../services/vulcan/engine/ops.js')
  if (ENGINE_OPS.has(op)) {
    const { projectLeaseHolder } = await import('../../services/vulcan/engine/leases.js')
    return runEngineOp(op, args, root, projectLeaseHolder(context.agentId))
  }
  switch (op) {
    case 'vulcan_status':
      return installer.describeVulcanStatus(root, args?.instance)
    case 'vulcan_install':
      return installer.applyVulcanInstall(root, changeRecordRoad(context, parentMessage), { instance: args?.instance })
    case 'vulcan_uninstall':
      return installer.applyVulcanUninstall(root, changeRecordRoad(context, parentMessage))
    case 'project_refresh_classes': {
      const { runProjectRefreshClasses } = await import('../../services/vulcan/classCache.js')
      return formatResult(await runProjectRefreshClasses(root, installer.vulcanInstallStatus(root), args?.instance))
    }
    default:
      return `unknown local op ${op}`
  }
}

async function classCacheHint(args: Record<string, unknown> | undefined): Promise<string> {
  const root = findGodotProjectRoot()
  if (!root) return ''
  const { classCacheReport, classCacheUnreadableNote } = await import('../../services/vulcan/classCache.js')
  const report = classCacheReport(root, 10)
  const lines: string[] = []
  if (report.state !== 'fresh') {
    const pathArg = typeof args?.path === 'string' ? args.path : undefined
    const own = pathArg ? report.stale.find(s => s.path === pathArg) : undefined
    lines.push(`class cache: ${report.hint}${own ? ` (this script's ${own.class}: ${own.reason})` : ''}`)
  }
  const unreadable = classCacheUnreadableNote(report.unreadable)
  if (unreadable) lines.push(`class cache: ${unreadable}`)
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

export function vulcanDeclaredBudgetMs(op: string, args: Record<string, unknown> | undefined): number {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)
  const declared = (a: Record<string, unknown> | undefined): number =>
    num(a?.duration_ms) +
    num(a?.settle_ms) +
    num(a?.attach_timeout_ms) +
    num(a?.timeout_ms) +
    num(a?.ms) +
    num(a?.wait_ms) +
    num(a?.step_ms) +
    (num(a?.frames) + num(a?.step_frames)) * VULCAN_STEP_WALL_MS_PER_FRAME
  let total = declared(args)
  if (op === 'input_sequence' && Array.isArray(args?.steps)) {
    for (const step of args.steps as unknown[]) {
      if (step && typeof step === 'object') total += declared(step as Record<string, unknown>)
    }
  }
  return total
}

async function runOp(input: Input, context: ToolUseContext, parentMessage: AssistantMessage): Promise<string> {
  const spec = vulcanOp(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — categories: ${vulcanCategories().join(', ')} (the tool description carries the full catalog)`
  }
  if (vulcanLiteMode() && !spec.lite && spec.category !== 'frontier') {
    return `op "${input.op}" is outside the lite subset (MERCURY_GODOT_TOOLS_LITE is on) — use a core op, or unset the lite flag for the full surface`
  }
  if (spec.side === 'mercury') return runLocalOp(input.op, input.args, context, parentMessage)

  const resolved = resolveVulcanClient(undefined, input.args?.instance)
  if (!resolved.ok) {
    if (resolved.reason === 'unreadable') return resolved.message
    if (input.op === 'project_capsule' && input.args?.instance === undefined) return staticCapsuleAnswer(input)
    return `no unique Godot instance is available for this call — op:"vulcan_status" lists instances; pass args.instance with an id or role. The operator's editor is never selected implicitly`
  }
  const client = resolved.client
  const baseMs = input.op === 'playtest_run' ? 120_000 : 30_000
  const { instance: _instance, ...wireArgs } = input.args ?? {}
  const r: VulcanResult = await client.request(input.op, wireArgs, baseMs + vulcanDeclaredBudgetMs(input.op, input.args))
  if (!r.ok && input.op === 'project_capsule' && UNREACHABLE_CODES.has(r.error.code)) {
    return staticCapsuleAnswer(input)
  }
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  if (r.instance) text += `\ninstance: ${formatResult(r.instance)}`
  if (r.via) text += `\nvia: ${formatResult(r.via)}`
  if (input.op === 'script_validate') text += await classCacheHint(input.args)
  const events = client.drainEvents()
  if (events.length > 0) {
    const shown = events.slice(-8)
    text += `\n\nevents (${events.length}):\n` + shown.map(e => `· ${e.event}: ${formatResult(e.data).slice(0, 200)}`).join('\n')
  }
  return text
}

export const GodotTool: Unbuilt = unbuilt('src/tools/GodotTool/GodotTool.ts:183')
