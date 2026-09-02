// ============================================================================
//  Godot tool — the agent-facing surface of VULCAN (the native Godot
//  editor-control plane; services/vulcan/vulcanClient.ts holds the protocol
//  client, assets/vulcan/optable.json the op contract). Catalog-gated by
//  vulcanToolCatalogEnabled() in tools.ts (opt-in MERCURY_GODOT_TOOLS + a
//  project.godot root). Permission classes ride the optable: read ⇒ allow,
//  mutate ⇒ ask (UndoRedo-wrapped editor-side; rule-allow presets),
//  exec ⇒ ask ALWAYS (runs code / drives
//  input — the DebugTool-launch class). Proofs: scripts/vulcan/.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { findGodotProjectRoot, godotEditorHint } from '../../services/lsp/godotLane.js'
import { getVulcanClient } from '../../services/vulcan/vulcanClient.js'
import { vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { vulcanOp, vulcanCategories } from '../../utils/vulcan/optable.generated.js'
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

/** Ops the Mercury side answers locally (never sent to the editor). */
const LOCAL_OPS = new Set(['vulcan_status', 'vulcan_install', 'vulcan_uninstall'])

/** Transport-dead client codes: the editor is not answering at all. */
const UNREACHABLE_CODES = new Set(['HANDSHAKE_CLOSED', 'CONNECTION_LOST', 'CLIENT_CLOSED'])

/** Mutates that write project files directly — no editor undo step exists. */
const FILE_MUTATES = new Set(['import_set', 'refactor_rename_signal', 'refactor_rename_export'])

async function staticCapsuleAnswer(input: Input): Promise<string> {
  const root = findGodotProjectRoot()
  if (!root) return `no project.godot found from the working directory — open/cd into a Godot project first`
  const { staticGodotCapsule } = await import('../../services/vulcan/godotCapsule.js')
  return formatResult(staticGodotCapsule(root, input.args?.budget))
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
  const installer = await import('../../services/vulcan/addonInstaller.js')
  const root = findGodotProjectRoot()
  if (!root) {
    return `no project.godot found from the working directory — open/cd into a Godot project first`
  }
  switch (op) {
    case 'vulcan_status':
      return installer.describeVulcanStatus(root)
    case 'vulcan_install':
      return installer.applyVulcanInstall(root)
    case 'vulcan_uninstall':
      return installer.applyVulcanUninstall(root)
    default:
      return `unknown local op ${op}`
  }
}

async function runOp(input: Input): Promise<string> {
  const spec = vulcanOp(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — categories: ${vulcanCategories().join(', ')} (the tool description carries the full catalog)`
  }
  if (vulcanLiteMode() && !spec.lite && spec.category !== 'frontier') {
    return `op "${input.op}" is outside the lite subset (MERCURY_GODOT_TOOLS_LITE is on) — use a core op, or unset the lite flag for the full surface`
  }
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op)

  const client = getVulcanClient()
  if (!client) {
    if (input.op === 'project_capsule') return staticCapsuleAnswer(input)
    return `the VULCAN surface is not available here (flag off or no project.godot from cwd) — op:"vulcan_status" explains`
  }
  // Long-running ops carry their own declared durations; the client deadline
  // must exceed their sum (playtest_run's attach ceiling defaults to 45s
  // before any arg is passed).
  const declaredMs = ['duration_ms', 'settle_ms', 'attach_timeout_ms', 'timeout_ms'].reduce(
    (sum, key) => sum + (typeof input.args?.[key] === 'number' ? (input.args[key] as number) : 0),
    0,
  )
  const baseMs = input.op === 'playtest_run' ? 120_000 : 30_000
  const r = await client.request(input.op, input.args, baseMs + declaredMs)
  // The capsule answers from project files when the editor is unreachable —
  // transport-dead codes only, never timeouts (a busy editor is not a closed
  // one) and never the editor's own errors.
  if (!r.ok && input.op === 'project_capsule' && UNREACHABLE_CODES.has(r.error.code)) {
    return staticCapsuleAnswer(input)
  }
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  // Editor events (play started/stopped, runtime log, editor errors) ride the
  // same connection — surface anything buffered since the last op.
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
    return false // one editor, ordered ops
  },
  isReadOnly(input: Input) {
    return vulcanOp(input.op)?.cls === 'read'
  },
  async checkPermissions(input: Input) {
    const spec = vulcanOp(input.op)
    // Unknown ops flow to call() for the teaching answer — allowing here is
    // safe because runOp answers them locally without reaching the editor.
    if (!spec || spec.cls === 'read') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (spec.cls === 'exec') {
      return {
        behavior: 'ask' as const,
        message: `Godot exec: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — runs code / drives input in the ${input.op.startsWith('runtime_') || input.op.startsWith('input_') ? 'running game' : 'editor'}`,
      }
    }
    // File-writing mutates have no editor undo step — say what actually
    // happens instead of promising Ctrl+Z.
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
  async call(input: Input) {
    let result: string
    try {
      result = await runOp(input)
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
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result ?? ''
  },
})
