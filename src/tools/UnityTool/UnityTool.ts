// ============================================================================
//  Unity tool — the agent-facing surface of the Unity editor bridge
//  (services/unity/bridgeClient.ts holds the protocol client,
//  services/unity/bridgeProtocol.ts the version-1 contract; the GodotTool
//  is the grammar this mirrors). Catalog-gated by
//  unityBridgeToolCatalogEnabled() in tools.ts (the one Unity switch
//  MERCURY_UNITY + a Unity project root). Permission classes ride the
//  contract table: read ⇒ allow, mutate ⇒ ask (scene_open is a scene
//  SWITCH, not an editor undo step — the message says what actually
//  happens), exec ⇒ ask ALWAYS (play transitions + test runs). Proofs:
//  scripts/unity-bridge/.
// ============================================================================

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { persistTestRun } from '../../services/ide/pythonTests.js'
import { findUnityProjectRoot } from '../../services/ide/unityProject.js'
import { unityTestResultsPath } from '../../services/ide/unityProject.js'
import { parseUnityTestResults, unityRunToRecord } from '../../services/ide/unityTests.js'
import { getUnityBridgeClient, unityBridgeHint } from '../../services/unity/bridgeClient.js'
import { unityBridgeVerb, unityBridgeVerbNames } from '../../services/unity/bridgeProtocol.js'
import { unityBridgePort } from '../../utils/unity/bridgeGates.js'
import { UNITY_TOOL_NAME, getUnityToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('The Unity operation (see the op catalog in the tool description)'),
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

/** Ops the Mercury side answers locally (never sent to the editor). */
const LOCAL_OPS = new Set(['unity_status', 'unity_bridge_install', 'unity_bridge_uninstall'])
/** Local ops that write into the project (install/uninstall) — mutate-class asks. */
const LOCAL_MUTATES = new Set(['unity_bridge_install', 'unity_bridge_uninstall'])

/** What the last tests_run asked for — consumed when its finished event
 *  drains (one editor, ordered ops; a Mercury restart between trigger and
 *  drain loses the memo and the record says so honestly). */
let pendingBridgeRun: { mode: 'EditMode' | 'PlayMode'; selection: string } | null = null

/** THE STORE HALF of the executor seam, at the drain site: read the finished
 *  run's XML through the LANDED parser and persist it through the store's
 *  own writer (never a second parser, never a second ledger). Answers the
 *  receipt line, or the honest why-not. */
async function persistBridgeRunRecord(data: unknown): Promise<string | null> {
  const root = findUnityProjectRoot()
  if (!root) return null
  const resultsPath = (data as { resultsPath?: unknown } | null)?.resultsPath
  if (typeof resultsPath !== 'string' || resultsPath.length === 0) return null
  let xml: string
  try {
    xml = readFileSync(resultsPath, 'utf8')
  } catch {
    return `test_run_finished: results file unreadable at ${resultsPath} — no store record written`
  }
  const parsed = parseUnityTestResults(xml)
  if (parsed.state !== 'ok') {
    return `test_run_finished: ${parsed.reason} — no store record written`
  }
  const memo = pendingBridgeRun
  pendingBridgeRun = null
  const mode =
    memo?.mode ?? (path.basename(resultsPath).startsWith('playmode') ? 'PlayMode' : 'EditMode')
  const record = unityRunToRecord(parsed, {
    root,
    mode,
    resultsPath,
    selection: memo?.selection ?? 'bridge-run (selection not recorded)',
  })
  await persistTestRun(root, record)
  return `test-run record ${record.id} persisted to the .mercury/test-runs store (framework unity)`
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
  const installer = await import('../../services/unity/bridgeInstaller.js')
  const root = findUnityProjectRoot()
  if (!root) {
    return `no Unity project (Assets/ + ProjectSettings/) found from the working directory — open/cd into one first`
  }
  switch (op) {
    case 'unity_status':
      return installer.describeUnityBridgeStatus(root)
    case 'unity_bridge_install':
      return installer.applyUnityBridgeInstall(root)
    case 'unity_bridge_uninstall':
      return installer.applyUnityBridgeUninstall(root)
    default:
      return `unknown local op ${op}`
  }
}

async function runOp(input: Input): Promise<string> {
  if (LOCAL_OPS.has(input.op)) return runLocalOp(input.op)
  const spec = unityBridgeVerb(input.op)
  if (!spec) {
    return `unknown op "${input.op}" — the wire verbs: ${unityBridgeVerbNames().join(', ')}; local: unity_status, unity_bridge_install, unity_bridge_uninstall (the tool description carries the full catalog)`
  }
  const client = getUnityBridgeClient()
  if (!client) {
    return `the Unity bridge is not available here (flag off or no Unity project from cwd) — op:"unity_status" explains`
  }
  // tests_run: Mercury always sends the LANDED results path so the durable
  // door and the headless profiles speak one spelling.
  let args = input.args
  if (input.op === 'tests_run' && (!args || typeof args.resultsPath !== 'string')) {
    const root = findUnityProjectRoot()
    const mode = args?.mode === 'PlayMode' ? 'PlayMode' : 'EditMode'
    if (root) args = { ...(args ?? {}), resultsPath: unityTestResultsPath(root, mode) }
  }
  const r = await client.request(input.op, args, 30_000)
  if (input.op === 'tests_run' && r.ok) {
    const names = Array.isArray(args?.testNames)
      ? (args.testNames as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    const groups = Array.isArray(args?.groupNames)
      ? (args.groupNames as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    pendingBridgeRun = {
      mode: args?.mode === 'PlayMode' ? 'PlayMode' : 'EditMode',
      selection: names.length > 0 ? `nodes:${names.join(';')}` : groups.length > 0 ? `nodes:${groups.join(';')}` : 'all',
    }
  }
  let text: string
  if (r.ok) {
    text = formatResult(r.result)
  } else {
    text = `${input.op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? `\nhint: ${r.error.hint}` : ''}`
  }
  // Editor events (play-state changes, finished test runs) ride the same
  // connection — surface anything buffered since the last op.
  const events = client.drainEvents()
  if (events.length > 0) {
    const shown = events.slice(-8)
    text += `\n\nevents (${events.length}):\n` + shown.map(e => `· ${e.event}: ${formatResult(e.data).slice(0, 200)}`).join('\n')
    for (const e of events) {
      if (e.event === 'test_run_finished') {
        const note = await persistBridgeRunRecord(e.data)
        if (note) text += `\n${note}`
      }
    }
  }
  return text
}

export const UnityTool = buildTool({
  name: UNITY_TOOL_NAME,
  get searchHint() {
    return 'Unity editor control (the Mercury bridge): play mode, scenes, hierarchy, console, Test Runner runs'
  },
  maxResultSizeChars: 100_000,
  async description() {
    return 'Drive the running Unity editor: play-mode control, scenes, hierarchy reads, console tail, Test Runner runs'
  },
  async prompt() {
    return getUnityToolDescription()
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
    return unityBridgeVerb(input.op)?.cls === 'read' || input.op === 'unity_status'
  },
  async checkPermissions(input: Input) {
    if (LOCAL_MUTATES.has(input.op)) {
      return {
        behavior: 'ask' as const,
        message:
          input.op === 'unity_bridge_install'
            ? `Unity mutate: ${input.op} — writes the bridge package into Packages/com.mercury.unity-bridge/, the token file, and the port-alignment file`
            : `Unity mutate: ${input.op} — removes the bridge package, token, and port-alignment file from the project`,
      }
    }
    const spec = unityBridgeVerb(input.op)
    // Unknown ops flow to call() for the teaching answer — allowing here is
    // safe because runOp answers them locally without reaching the editor.
    if (!spec || spec.cls === 'read') {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (spec.cls === 'exec') {
      return {
        behavior: 'ask' as const,
        message: `Unity exec: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — ${
          input.op === 'tests_run'
            ? 'runs tests in the editor (results land at the .mercury results door)'
            : 'changes the editor play state (a domain reload drops + reconnects the bridge by design)'
        }`,
      }
    }
    // scene_open: a scene SWITCH, not an editor undo step — say what
    // actually happens instead of promising Ctrl+Z.
    return {
      behavior: 'ask' as const,
      message: `Unity mutate: ${input.op}${summarizeArgs(input.args) ? ` (${summarizeArgs(input.args)})` : ''} — switches the open scene (no undo step; unsaved work refuses with SCENE_DIRTY rather than being discarded)`,
    }
  },
  toAutoClassifierInput(input: Input) {
    const spec = unityBridgeVerb(input.op)
    if (LOCAL_MUTATES.has(input.op)) return `unity mutate: ${input.op}`
    if (!spec || spec.cls === 'read') return ''
    return `unity ${spec.cls}: ${input.op} ${summarizeArgs(input.args, 300)}`
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
      result = `${input.op} failed: ${(err as Error).message}\nhint: ${unityBridgeHint(unityBridgePort())}`
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
