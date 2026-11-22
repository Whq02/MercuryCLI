import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { persistTestRun } from '../../services/ide/pythonTests.js'
import { findUnityProjectRoot } from '../../utils/unity/unityProject.js'
import { unityTestResultsPath } from '../../utils/unity/unityProject.js'
import { parseUnityTestResults, unityRunToRecord } from '../../services/ide/unityTests.js'
import { getUnityBridgeClient, unityBridgeHint } from '../../services/unity/bridgeClient.js'
import { unityBridgeVerb, unityBridgeVerbNames } from '../../utils/unity/bridgeProtocol.js'
import { unityBridgePort } from '../../utils/unity/bridgeGates.js'
import { UNITY_TOOL_NAME, getUnityToolDescription } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.string().describe('Unity operation, from the ops list.'),
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

const LOCAL_OPS = new Set(['unity_status', 'unity_bridge_install', 'unity_bridge_uninstall'])
const LOCAL_MUTATES = new Set(['unity_bridge_install', 'unity_bridge_uninstall'])

let pendingBridgeRun: { mode: 'EditMode' | 'PlayMode'; selection: string } | null = null

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

export const UnityTool: Unbuilt = unbuilt('src/tools/UnityTool/UnityTool.ts:153')
