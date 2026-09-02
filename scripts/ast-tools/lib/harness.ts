// ============================================================================
//  scripts/ast-tools/lib/harness.ts — the shared drive for the ast-tools
//  provers: a scratch config home + a composed grammar-engine dir armed
//  BEFORE any src import, a real ToolUseContext, and the REAL tool door
//  (runToolUse) with a canUseTool that runs the real decision chain and
//  RECORDS every ask before answering as the operator would.
// ============================================================================
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO = join(import.meta.dir, '..', '..', '..')

let failures = 0
export function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
export function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
export function section(title: string): void {
  console.log(`\n── ${title} ──`)
}
export function finish(name: string): never {
  console.log(failures === 0 ? `\n${name}: GREEN` : `\n${name}: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Arm the environment: a scratch config home (never the operator's), and
 * ONE engine dir composed from both vendored grammar sources — the @vscode
 * pack in node_modules plus the lock-pinned grammar-pack cache when this
 * checkout carries it. Call BEFORE importing anything under src/.
 */
export function armEnvironment(): { home: string; engineDir: string; packPresent: boolean } {
  const home = mkdtempSync(join(tmpdir(), 'ast-tools-home-'))
  process.env.MERCURY_CONFIG_DIR = home
  const vscodeWasm = join(REPO, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  const packDir = join(REPO, 'vendor', 'grammars', 'extracted')
  const engineDir = mkdtempSync(join(tmpdir(), 'ast-tools-engine-'))
  for (const f of readdirSync(vscodeWasm)) cpSync(join(vscodeWasm, f), join(engineDir, f))
  const packPresent = existsSync(packDir)
  if (packPresent) {
    for (const f of readdirSync(packDir)) if (f.endsWith('.wasm')) cpSync(join(packDir, f), join(engineDir, f))
  }
  process.env.MERCURY_TREESITTER_VENDOR_DIR = engineDir
  return { home, engineDir, packPresent }
}

export interface ProverContextOptions {
  mode?: string
  allow?: string[]
  deny?: string[]
  nonInteractive?: boolean
}

export interface ProverContext {
  ctx: Record<string, unknown>
  readFileState: Map<string, unknown>
  fileHistory(): { snapshots: unknown[]; trackedFiles: Set<string>; snapshotSequence: number }
  updateFileHistoryState: (updater: (prev: never) => never) => void
}

/** A real-shaped ToolUseContext over the given tools and permission rules
 *  (cliArg source — the `--allowedTools` shape). */
export async function makeContext(tools: unknown[], opts: ProverContextOptions = {}): Promise<ProverContext> {
  const { getEmptyToolPermissionContext } = await import(join(REPO, 'src/Tool.ts'))
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'default') as never,
    alwaysAllowRules: opts.allow ? { cliArg: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { cliArg: opts.deny } : {},
  }
  const appState = {
    toolPermissionContext,
    denialTracking: undefined,
    sessionHooks: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  let fileHistory = { snapshots: [] as unknown[], trackedFiles: new Set<string>(), snapshotSequence: 0 }
  const readFileState = new Map<string, unknown>()
  const updateFileHistoryState = (updater: (prev: never) => never): void => {
    fileHistory = updater(fileHistory as never) as never
  }
  const ctx: Record<string, unknown> = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState,
    setResponseLength: () => {},
    updateFileHistoryState,
    updateAttributionState: () => {},
    options: { tools, mcpClients: [], isNonInteractiveSession: opts.nonInteractive ?? false },
  }
  return { ctx, readFileState, fileHistory: () => fileHistory, updateFileHistoryState }
}

export interface DriveResult {
  text: string
  isError: boolean
  /** The tool's structured output (toolUseResult), when the call settled. */
  data: Record<string, unknown> | null
  /** Every ask the decision chain produced (the operator's dialog), in order. */
  asks: Array<{ behavior: string; message?: string }>
  /** The parent assistant message uuid the call ran under (file-history key). */
  messageId: string
}

/**
 * Drive one tool call through the REAL door: hooks → validateInput →
 * the permission decision (tool verdict → rules → mode) → the ask at the
 * canUseTool seam → call → effect. `answer` is the operator's reply to an
 * ask (default allow).
 */
export async function drive(
  tool: { name: string },
  input: Record<string, unknown>,
  prover: ProverContext,
  opts: { answer?: 'allow' | 'deny'; messageId?: string } = {},
): Promise<DriveResult> {
  const { runToolUse } = await import(join(REPO, 'src/services/tools/toolExecution.ts'))
  const { hasPermissionsToUseTool } = await import(join(REPO, 'src/utils/permissions/permissions.ts'))
  const asks: DriveResult['asks'] = []
  const canUseTool = async (t: never, inp: never, c: never, msg: never, id: string): Promise<unknown> => {
    const decision = await hasPermissionsToUseTool(t, inp, c, msg, id)
    if (decision.behavior === 'ask') {
      asks.push({ behavior: 'ask', message: (decision as { message?: string }).message })
      if (opts.answer === 'deny') {
        return { behavior: 'deny', message: 'declined by the operator', decisionReason: { type: 'other', reason: 'declined' } }
      }
      return { behavior: 'allow', updatedInput: (decision as { updatedInput?: unknown }).updatedInput ?? inp }
    }
    return decision
  }
  const messageId = opts.messageId ?? randomUUID()
  const assistant = { uuid: messageId, requestId: `req_${messageId.slice(0, 8)}`, type: 'assistant', message: { id: `msg_${messageId.slice(0, 8)}`, content: [] } }
  let text = ''
  let isError = false
  let data: Record<string, unknown> | null = null
  for await (const update of runToolUse(
    { type: 'tool_use', id: `toolu_${messageId.slice(0, 8)}`, name: tool.name, input } as never,
    assistant as never,
    canUseTool as never,
    prover.ctx as never,
  )) {
    const u = update as { message?: { type?: string; message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> }; toolUseResult?: unknown } }
    const blocks = u.message?.message?.content ?? []
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      isError = b.is_error === true
    }
    if (u.message?.toolUseResult !== undefined && typeof u.message.toolUseResult === 'object' && u.message.toolUseResult !== null) {
      data = u.message.toolUseResult as Record<string, unknown>
    }
  }
  return { text, isError, data, asks, messageId }
}

/** Point the session at a fixture root the way a real boot does: the
 *  process cwd, the original cwd and the session cwd all name it (the tools
 *  read getCwd(); the write ladder's working path is the original cwd; the
 *  permission path resolver resolves relative paths against the process
 *  cwd), the posture is interactive (file history is off for headless
 *  runs), and the config estate is opened (the boot-order gate that
 *  refuses config reads before bootstrap). */
export async function enterRoot(root: string): Promise<void> {
  const state = await import(join(REPO, 'src/bootstrap/state.ts'))
  const config = await import(join(REPO, 'src/utils/config/globalConfig.ts'))
  process.chdir(root)
  state.setOriginalCwd(root)
  state.setCwdState(root)
  state.setIsInteractive(true)
  config.enableConfigs()
}
