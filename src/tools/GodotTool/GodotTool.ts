
import type { UUID } from 'node:crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { findGodotProjectRoot, godotEditorHint } from '../../services/lsp/godotLane.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import type { ChangeRecordRoad } from '../../services/vulcan/addonInstaller.js'
import { getVulcanClient, type VulcanResult } from '../../services/vulcan/vulcanClient.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { VULCAN_STEP_WALL_MS_PER_FRAME, vulcanOp, vulcanCategories } from '../../utils/vulcan/optable.generated.js'
import { GODOT_TOOL_NAME, getGodotToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('The Godot operation (see the op catalog in the tool description)'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Operation arguments (validated editor-side; errors return actionable hints)'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: string
  result: string
}

const LOCAL_OPS = new Set([
  'vulcan_status',
  'vulcan_install',
  'vulcan_uninstall',
  'project_refresh_classes',
  'engine_run',
  'engine_check',
  'engine_jobs',
  'engine_cancel',
  'engine_result',
])

const UNREACHABLE_CODES = new Set(['HANDSHAKE_CLOSED', 'CONNECTION_LOST', 'CLIENT_CLOSED'])

const FILE_MUTATES = new Set(['import_set', 'refactor_rename_signal', 'refactor_rename_export', 'vulcan_install', 'vulcan_uninstall'])

function changeRecordRoad(context: ToolUseContext, parentMessage: AssistantMessage): ChangeRecordRoad {
  return {
    before: async file => {
      if (fileHistoryEnabled()) {
        await fileHistoryTrackEdit(context.updateFileHistoryState, file, parentMessage.uuid as UUID)
      }
    },
    after: (file, previous, next) => {
      notifyVscodeFileUpdated(file, previous, next)
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
  if (op.startsWith('engine_')) {
    const { runEngineOp } = await import('../../services/vulcan/engine/ops.js')
    return runEngineOp(op, args, root)
  }
  switch (op) {
    case 'vulcan_status':
      return installer.describeVulcanStatus(root)
    case 'vulcan_install':
      return installer.applyVulcanInstall(root, changeRecordRoad(context, parentMessage))
    case 'vulcan_uninstall':
      return installer.applyVulcanUninstall(root, changeRecordRoad(context, parentMessage))
    case 'project_refresh_classes': {
      const { runProjectRefreshClasses } = await import('../../services/vulcan/classCache.js')
      return formatResult(await runProjectRefreshClasses(root, vulcanPort(), installer.vulcanInstallStatus(root)))
    }
    default:
      return `unknown local op ${op}`
  }
}

async function classCacheHint(args: Record<string, unknown> | undefined): Promise<string> {
  const root = findGodotProjectRoot()
  if (!root) return ''
  const { classCacheReport } = await import('../../services/vulcan/classCache.js')
  const report = classCacheReport(root, 10)
  if (report.state === 'fresh') return ''
  const pathArg = typeof args?.path === 'string' ? args.path : undefined
  const own = pathArg ? report.stale.find(s => s.path === pathArg) : undefined
  return `\nclass cache: ${report.hint}${own ? ` (this script's ${own.class}: ${own.reason})` : ''}`
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
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op, input.args, context, parentMessage)

  const client = getVulcanClient()
  if (!client) {
    if (input.op === 'project_capsule') return staticCapsuleAnswer(input)
    return `the VULCAN surface is not available here (flag off or no project.godot from cwd) — op:"vulcan_status" explains`
  }
  const baseMs = input.op === 'playtest_run' ? 120_000 : 30_000
  const r: VulcanResult = await client.request(input.op, input.args, baseMs + vulcanDeclaredBudgetMs(input.op, input.args))
  if (!r.ok && input.op === 'project_capsule' && UNREACHABLE_CODES.has(r.error.code)) {
    return staticCapsuleAnswer(input)
  }
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  if (input.op === 'script_validate') text += await classCacheHint(input.args)
  const events = client.drainEvents()
  if (events.length > 0) {
    const shown = events.slice(-8)
    text += `\n\nevents (${events.length}):\n` + shown.map(e => `· ${e.event}: ${formatResult(e.data).slice(0, 200)}`).join('\n')
  }
  return text
}

export const GodotTool = buildTool({
  name: GODOT_TOOL_NAME,
  get searchHint() {
    return (
      'Godot editor control (VULCAN): scenes, nodes, scripts, resources, animation, physics, audio, tilemap, shaders, play-test, runtime inspection, input simulation, profiling, export' +
      (vulcanLiteMode() ? ' (lite subset)' : '')
    )
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive the running Godot editor: scene/node/resource editing (undoable), play-testing, runtime inspection, input simulation'
  },
  async prompt() {
    return getGodotToolDescription()
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return vulcanOp(input.op)?.cls === 'read'
  },
  async checkPermissions(input: Input) {
    const spec = vulcanOp(input.op)
    if (!spec || spec.cls === 'read') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (input.op === 'project_refresh_classes') {
      return {
        behavior: 'ask' as const,
        message: `Godot exec: project_refresh_classes — rebuilds the class cache: the editor's rescan over the bridge when one is up, else runs godot --headless --import --path <project> (bounded, no editor running)`,
      }
    }
    if (input.op.startsWith('engine_')) {
      const { engineOpPermissionMessage } = await import('../../services/vulcan/engine/ops.js')
      const message = engineOpPermissionMessage(input.op, input.args)
      if (message) return { behavior: 'ask' as const, message }
    }
    if (spec.cls === 'exec') {
      return {
        behavior: 'ask' as const,
        message: `Godot exec: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — runs code / drives input in the ${input.op.startsWith('runtime_') || input.op.startsWith('input_') ? 'running game' : 'editor'}`,
      }
    }
    if (input.op === 'vulcan_install' || input.op === 'vulcan_uninstall') {
      return {
        behavior: 'ask' as const,
        message: `Godot mutate: ${input.op} — writes addons/mercury_vulcan/ and project.godot rows (each row receipted; no editor undo step)${input.op === 'vulcan_install' ? '; with a bridge already up it reloads the editor plugin' : ''}`,
      }
    }
    if (FILE_MUTATES.has(input.op)) {
      return {
        behavior: 'ask' as const,
        message: `Godot mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — writes project files; the receipt lists previous values (no editor undo step)`,
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Godot mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — one undo step in the editor (Ctrl+Z reverts)`,
    }
  },
  toAutoClassifierInput(input: Input) {
    const spec = vulcanOp(input.op)
    if (!spec || spec.cls === 'read') return ''
    return `godot ${spec.cls}: ${input.op} ${summarizeArgs(input.args, 300)}`
  },
  async validateInput(input: Input) {
    if (!input.op || input.op.trim().length === 0) {
      return { result: false as const, message: 'op is required', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, parentMessage: AssistantMessage) {
    let result: string
    try {
      result = await runOp(input, context, parentMessage)
    } catch (err) {
      result = `${input.op} failed: ${(err as Error).message}\nhint: ${godotEditorHint(vulcanPort())}`
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
