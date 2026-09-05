
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { errorTunnel, readBoundaryArray, cloneFromVM } from './vmBoundary.js'

import type {
  WorkflowHooks,
  WorkflowToolContext,
  TokenBudget,
  JournalSnapshot as ExecutorJournalSnapshot,
  WorkflowJournal,
  ProgressFrame,
} from './executor.js'

import { governorCeilings } from '../../services/capacity/governor.js'
import {
  chargeRecoveryWait,
  makeRecoveryBudget,
  recoveryBudgetSpentLine,
  recoveryNoticeFacts,
  retryWaitWords,
  type RecoveryBudget,
} from '../../services/api/recoveryBudget.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { readAgentMetadata } from '../../utils/sessionStorage.js'
import { isBuiltInAgent } from '../AgentTool/loadAgentsDir.js'
import { assembleToolPool } from '../../tools.js'
import { resolveWorkflowRoutedModel, validateWorkflowTier } from './workflowRouting.js'
import { resolveEngineDispatch } from '../../utils/swarm/engineDispatch.js'
import { EFFORT_LEVELS } from '../../utils/effort.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import { createAgentId } from '../../utils/uuid.js'
import { sleep } from '../../utils/sleep.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import { AbortError } from '../../utils/errors.js'
import {
  createAgentWorktree,
  settleAgentWorktree,
} from '../../utils/worktree.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { observedFamilyWindow } from '../../services/capFailover.js'
import { providerFamilyOfSetting } from '../../utils/model/modelTransition.js'
import { getMarketingNameForModel } from '../../utils/model/model.js'
import { subscribeMainLoopModelOverride } from '../../bootstrap/state.js'
import { agentWaitWords } from '../../tasks/LocalAgentTask/agentWait.js'

import {
  getSchemaBoundStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from './structuredOutputTool.js'
export { STRUCTURED_OUTPUT_TOOL_NAME }

const AGENT_LIFETIME_CAP = 1000
const DEFAULT_STALL_MS = 180_000
const MAX_STALL_RETRIES = 5
const MAX_CAP_PAUSES = 3
const CAP_KEEPALIVE_MS = 15_000
const PREVIEW_MAX_CHARS = 400
const JOURNAL_VERSION = 'v2'
const THROTTLE_BACKOFF_MS = 45_000
const RECOVERY_HEARTBEAT_MS = 30_000
const MAX_STRUCTURED_OUTPUT_NUDGES = 2
export const STRUCTURED_OUTPUT_NUDGE_PROMPT = `You stopped without calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool. Your work above is preserved — do NOT redo it. Call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool now, exactly once, with your final answer in the shape its input schema requires. Do not reply with text; the calling script reads ONLY the ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.`
const DETERMINISTIC_400_RE =
  /prompt is too long|prompt too long|maximum context length|context window exceeded|invalid_request_error/i

export function computeConcurrencyCap(): number {
  return governorCeilings().delegationLanes
}

export class WorkflowAgentCapError extends Error {
  constructor() {
    super(
      `Workflow agent() call cap reached (${AGENT_LIFETIME_CAP}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`,
    )
    this.name = 'WorkflowAgentCapError'
  }
}
export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    )
    this.name = 'WorkflowBudgetExceededError'
  }
}

export const SUBAGENT_TEXT_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`

export const SUBAGENT_SCHEMA_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${STRUCTURED_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${STRUCTURED_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.`

export const SCHEMA_APPEND = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.`
export const TEXT_APPEND = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`

const SUBAGENT_DISALLOWED_TOOLS = ['Agent', 'Task', 'Workflow']

const WORKFLOW_SUBAGENT_PREAMBLE = (): string =>
  `You are a Mercury workflow subagent — a focused worker spawned by an orchestration script. Recon before you edit, verify from observed output (not "should work"), never fabricate paths/output/results, and end this assignment in exactly one outcome: the return value below, or a clean blocked stated in it. Reason privately, act through tools.\n\n`

export function buildSubagentTextPrompt(): string {
  return `${WORKFLOW_SUBAGENT_PREAMBLE()}${SUBAGENT_TEXT_PROMPT}`
}
export function buildSubagentSchemaPrompt(): string {
  return `${WORKFLOW_SUBAGENT_PREAMBLE()}${SUBAGENT_SCHEMA_PROMPT}`
}

export const WORKFLOW_SUBAGENT_DEF = {
  agentType: 'workflow-subagent',
  whenToUse: 'Internal subagent for workflow script orchestration.',
  source: 'built-in',
  baseDir: 'built-in',
  tools: ['*'],
  disallowedTools: SUBAGENT_DISALLOWED_TOOLS,
  fixedOutputContract: true,
  getSystemPrompt: () => buildSubagentTextPrompt(),
} as const
export const WORKFLOW_SUBAGENT_SCHEMA_DEF = {
  ...WORKFLOW_SUBAGENT_DEF,
  getSystemPrompt: () => buildSubagentSchemaPrompt(),
} as const


export interface JournalStartedEntry {
  type: 'started'
  key: string
  agentId: string
  epoch?: number
}
export interface JournalResultEntry {
  type: 'result'
  key: string
  agentId: string
  result: unknown
  epoch?: number
}
export type JournalEntry = JournalStartedEntry | JournalResultEntry

export interface JournalSnapshot {
  results: Map<string, JournalResultEntry>
  started: Map<string, JournalStartedEntry[]>
}

export function indexJournal(entries: JournalEntry[]): JournalSnapshot {
  const results = new Map<string, JournalResultEntry>()
  const started = new Map<string, JournalStartedEntry[]>()
  let epochFloor = -1
  for (const entry of entries) {
    if (typeof entry.epoch === 'number') {
      if (entry.epoch < epochFloor) continue
      epochFloor = entry.epoch
    }
    if (entry.type === 'started') {
      const rows = started.get(entry.key)
      if (rows === undefined) started.set(entry.key, [entry])
      else rows.push(entry)
    } else if (entry.type === 'result') {
      results.set(entry.key, entry)
    }
  }
  return { results, started }
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) {
    const rawLength = value.length
    const length = Number.isSafeInteger(rawLength) ? rawLength : 0
    const items: unknown[] = []
    for (let i = 0; i < length; i++) items[i] = canonicalizeValue(value[i])
    return items
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const canon: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (key === '__proto__') continue
      canon[key] = canonicalizeValue(source[key])
    }
    return canon
  }
  return value
}

export function canonicalizeOpts(opts: unknown): string {
  if (typeof opts !== 'object' || opts === null) return '{}'
  const source = opts as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const key of ['schema', 'model', 'isolation', 'agentType', 'effort']) {
    const value = source[key]
    if (value === undefined || typeof value === 'function') continue
    kept[key] = value
  }
  return JSON.stringify(canonicalizeValue(kept))
}

export function canonicalizeArgsSeed(args: unknown): string {
  if (args === undefined) return ''
  try {
    const canonical = JSON.stringify(canonicalizeValue(args))
    return `args:${crypto.createHash('sha256').update(canonical).digest('hex')}`
  } catch {
    return ''
  }
}

export function agentCacheKey(prompt: string, opts: unknown, priorKey: string): string {
  const hash = crypto.createHash('sha256')
  for (const part of [priorKey, '\x00', prompt, '\x00', canonicalizeOpts(opts)]) {
    hash.update(part)
  }
  return `${JOURNAL_VERSION}:${hash.digest('hex')}`
}

export class LocalFileJournal {
  path: string
  private dirEnsured = false
  private pending: Promise<unknown> = Promise.resolve()
  private firstDegradation: string | undefined
  private readonly onDegraded?: (reason: string) => void
  private readonly epoch?: number
  constructor(
    runDir: string,
    opts?: {
      onDegraded?: (reason: string) => void
      epoch?: number
    },
  ) {
    this.path = path.join(runDir, 'journal.jsonl')
    this.onDegraded = opts?.onDegraded
    this.epoch = opts?.epoch
  }
  degraded(): string | undefined {
    return this.firstDegradation
  }
  private noteDegradation(reason: string): void {
    if (this.firstDegradation !== undefined) return
    this.firstDegradation = reason
    try {
      this.onDegraded?.(reason)
    } catch {
    }
  }
  async load(): Promise<JournalSnapshot> {
    let raw: string
    try {
      raw = await fsp.readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as { code?: string } | undefined)?.code === 'ENOENT') return indexJournal([])
      throw e
    }
    const entries: JournalEntry[] = []
    let unparseable = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as JournalEntry)
      } catch {
        unparseable++
      }
    }
    if (unparseable > 0) {
      this.noteDegradation(
        `${unparseable} unparseable journal line(s) skipped — cached replay may be incomplete`,
      )
    }
    return indexJournal(entries)
  }
  append(entry: JournalEntry): Promise<void> {
    const row = this.epoch !== undefined ? { ...entry, epoch: this.epoch } : entry
    const write = this.pending.then(async () => {
      if (!this.dirEnsured) {
        await fsp.mkdir(path.dirname(this.path), { recursive: true })
        this.dirEnsured = true
      }
      await fsp.appendFile(this.path, JSON.stringify(row) + '\n', 'utf8')
    })
    this.pending = write.catch(e => {
      this.noteDegradation(
        `journal append failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    })
    return write
  }
}


export interface SpawnSubagentArgs {
  agentDefinition: unknown
  prompt: string
  toolUseContext: WorkflowToolContext
  canUseTool: unknown
  availableTools: unknown
  transcriptSubdir?: string
  workflowRunId?: string
  agentId: string
  model?: string
  effort?: string
  maxTurns?: number
  worktreePath?: string
  description?: string
  seatHolder?: string
  onQueryProgress?: (message?: unknown) => void
  onWait?: (words: string | null) => void
  onResolvedIdentity?: (identity: { model: string; effort?: string }) => void
  continuationMessages?: unknown[]
}

export type SubagentStreamEvent =
  | {
      type: 'attachment'
      attachment: { type: string; data?: unknown; [k: string]: unknown }
    }
  | {
      type: 'assistant'
      isApiErrorMessage?: boolean
      error?: string
      message: {
        content: Array<{ type: string; name?: string; input?: unknown; [k: string]: unknown }>
        usage?: { output_tokens?: number; [k: string]: unknown }
        stop_reason?: string | null
        [k: string]: unknown
      }
    }
  | { type: string; [k: string]: unknown }

export type SpawnSubagentStream = (args: SpawnSubagentArgs) => AsyncIterable<SubagentStreamEvent>

async function* adapterSpawnStream(
  args: SpawnSubagentArgs,
): AsyncGenerator<SubagentStreamEvent, void> {
  type RunAgentOpts = Parameters<typeof runAgent>[0]
  const authority = evaluateLaunchAuthority('subagents')
  if (!authority.allowed) throw new Error(authority.reason)
  const view = args.toolUseContext as unknown as HookContextView
  const appState = view.getAppState()
  const def = args.agentDefinition as { agentType?: string; permissionMode?: string }

  const pool =
    (args.availableTools as ToolPool | undefined) ??
    assembleToolPool(
      { ...appState.toolPermissionContext, mode: def.permissionMode ?? 'implement' } as Parameters<typeof assembleToolPool>[0],
      appState.mcp.tools as ToolPool,
    )

  const seedMessages =
    (args.continuationMessages as RunAgentOpts['promptMessages'] | undefined) ??
    [createUserMessage({ content: args.prompt })]

  const stream = runAgent({
    agentDefinition: args.agentDefinition as RunAgentOpts['agentDefinition'],
    promptMessages: seedMessages,
    toolUseContext: args.toolUseContext as unknown as RunAgentOpts['toolUseContext'],
    canUseTool: args.canUseTool as RunAgentOpts['canUseTool'],
    isAsync: false,
    querySource: getQuerySourceForAgent(
      def.agentType,
      isBuiltInAgent(args.agentDefinition as Parameters<typeof isBuiltInAgent>[0]),
    ),
    availableTools: pool as RunAgentOpts['availableTools'],
    model: args.model as RunAgentOpts['model'],
    effortOverride: args.effort as RunAgentOpts['effortOverride'],
    maxTurns: args.maxTurns,
    transcriptSubdir: args.transcriptSubdir,
    worktreePath: args.worktreePath,
    description: args.description,
    seatHolder: args.seatHolder,
    override: {
      agentId: args.agentId,
      abortController: (args.toolUseContext as { abortController?: AbortController }).abortController,
    } as RunAgentOpts['override'],
    onQueryProgress: args.onQueryProgress,
    onWait: args.onWait,
    onResolvedIdentity: args.onResolvedIdentity,
  })

  yield* stream as AsyncIterable<SubagentStreamEvent>
}


export interface WorkflowHookDeps {
  toolUseContext: WorkflowToolContext
  canUseTool: unknown
  emitProgress: (frame: ProgressFrame) => void
  workflowRunId?: string
  onAgentController?: (agentId: string, ctrl: AbortController | null) => void
  seedPhaseTitles?: string[]
  budget?: TokenBudget
  journal?: WorkflowJournal
  journalSnapshot?: ExecutorJournalSnapshot | JournalSnapshot
  args?: unknown

  spawnSubagentStream?: SpawnSubagentStream
  getStructuredOutputTool?: (schema: unknown) =>
    | { tool: unknown; error?: undefined }
    | { error: string; tool?: undefined }
  resolveCustomAgentType?: (type: string, hasSchema: boolean) => unknown
  runDir?: string
}

export function makeWorkflowHooks(deps: WorkflowHookDeps): WorkflowHooks {
  const ctx = deps.toolUseContext
  const contextView = ctx as unknown as HookContextView
  const canUseTool = deps.canUseTool
  const emit = deps.emitProgress
  const runId = deps.workflowRunId
  const onAgentController = deps.onAgentController
  const budget = deps.budget
  const journal = deps.journal

  const spawnStream: SpawnSubagentStream =
    deps.spawnSubagentStream ?? adapterSpawnStream
  const buildStructuredTool: NonNullable<WorkflowHookDeps['getStructuredOutputTool']> =
    deps.getStructuredOutputTool ??
    ((schema: unknown) =>
      typeof schema === 'object' && schema !== null
        ? getSchemaBoundStructuredOutputTool(schema)
        : { error: 'agent({schema}) requires a JSON Schema object' })
  const resolveCustomAgentType =
    deps.resolveCustomAgentType ?? resolveFromSessionRegistry

  let admitted = 0
  const failures: string[] = []

  let settle: (v: unknown) => Promise<{ v: unknown }> = async v => ({ v: await v })
  let call: (fn: unknown, ...a: unknown[]) => unknown = (fn, ...a) =>
    (fn as (...a: unknown[]) => unknown)(...a)
  let clone: (v: unknown) => unknown = v => cloneFromVM(v)

  let cacheChainTip = canonicalizeArgsSeed(deps.args)
  let replayWindowClosed = false
  const replayResults = (deps.journalSnapshot?.results ?? new Map()) as Map<string, unknown>

  function assertUnderAgentCap(): void {
    if (admitted >= AGENT_LIFETIME_CAP) throw new WorkflowAgentCapError()
  }
  function assertBudgetRemains(): void {
    if (budget?.total == null || budget.total <= 0) return
    const spent = budget.getTurnSpent()
    if (spent >= budget.total) throw new WorkflowBudgetExceededError(spent, budget.total)
  }

  let nextPhaseId = 0
  let activePhaseTitle: string | undefined
  const phaseIdByTitle = new Map<string, number>()
  function resolvePhase(title: string, kind?: 'child'): number {
    const known = phaseIdByTitle.get(title)
    if (known != null) return known
    const id = nextPhaseId++
    phaseIdByTitle.set(title, id)
    emit({
      type: 'progress',
      toolUseID: `workflow_phase_${id}`,
      data: { type: 'workflow_phase', index: id, title, kind },
    })
    return id
  }
  for (const title of deps.seedPhaseTitles ?? []) resolvePhase(title)

  const phase = errorTunnel((title: unknown) => {
    activePhaseTitle = String(title)
    resolvePhase(activePhaseTitle)
  })

  const log = errorTunnel((msg: unknown) => {
    emit({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message: String(msg) },
    })
  })

  function resolveFromSessionRegistry(type: string, hasSchema: boolean): unknown {
    const registry = contextView.options?.agentDefinitions?.activeAgents ?? []
    const found = registry.find(a => a.agentType === type)
    if (!found) {
      throw new Error(
        `Agent type '${type}' not found. Available agents: ${registry.map(a => a.agentType).join(', ')}`,
      )
    }
    const ownPrompt =
      typeof found.getSystemPrompt === 'function' ? found.getSystemPrompt() : ''
    const contractSuffix = hasSchema ? SCHEMA_APPEND : TEXT_APPEND
    return {
      ...found,
      model: 'inherit',
      getSystemPrompt: () => `${ownPrompt}${contractSuffix}`,
    }
  }

  function spliceStructuredTool(structuredTool: unknown, agentDef: unknown): unknown {
    const def = agentDef as { permissionMode?: string }
    const appState = contextView.getAppState()
    const basePool = assembleToolPool(
      { ...appState.toolPermissionContext, mode: def?.permissionMode ?? 'implement' } as Parameters<typeof assembleToolPool>[0],
      appState.mcp.tools as ToolPool,
    ) as unknown as Array<{ name?: string }>
    return [...basePool.filter(t => t?.name !== STRUCTURED_OUTPUT_TOOL_NAME), structuredTool]
  }

  function balancedTranscriptPrefix(messages: unknown[] | undefined): unknown[] | null {
    if (!messages || messages.length === 0) return null
    const openToolUses = new Set<string>()
    let balancedLen = 0
    let assistantsSeen = 0
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] as { type?: string; message?: { content?: unknown } }
      const blocks = Array.isArray(m?.message?.content)
        ? (m.message!.content as Array<{ type?: string; id?: string; tool_use_id?: string }>)
        : []
      if (m?.type === 'assistant') {
        assistantsSeen++
        for (const b of blocks) {
          if (b?.type === 'tool_use' && typeof b.id === 'string') openToolUses.add(b.id)
        }
      } else if (m?.type === 'user') {
        for (const b of blocks) {
          if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            openToolUses.delete(b.tool_use_id)
          }
        }
      }
      if (openToolUses.size === 0) balancedLen = i + 1
    }
    if (assistantsSeen === 0) return null
    const prefix = messages.slice(0, balancedLen)
    return prefix.some(m => (m as { type?: string }).type === 'assistant') ? prefix : null
  }

  const STALL_RESUME_PROMPT =
    'Your previous turn was cut off by a no-progress timeout (the provider went quiet). Everything above is your own completed work — it is preserved; do NOT redo it. Continue from exactly where you stopped and finish the task.'
  const CAP_RESUME_PROMPT =
    'Your previous turn ended on a spent usage window (the provider refused the request until its window resets). Everything above is your own completed work — it is preserved; do NOT redo it. Continue from exactly where you stopped and finish the task.'

  const stableSchemaByRaw = new WeakMap<object, unknown>()

  const agent = errorTunnel(
    async (promptIn: unknown, optsIn?: unknown): Promise<unknown> => {
      let rawSchema: unknown
      try {
        const candidate = (optsIn as { schema?: unknown } | undefined)?.schema
        if (candidate !== null && typeof candidate === 'object') rawSchema = candidate
      } catch {}
      const opts = cloneFromVM(optsIn) as Record<string, unknown> | undefined
      if (opts && rawSchema !== undefined) {
        let stable = stableSchemaByRaw.get(rawSchema as object)
        if (stable === undefined) {
          stable = cloneFromVM(rawSchema)
          stableSchemaByRaw.set(rawSchema as object, stable)
        }
        opts.schema = stable
      }

      if (ctx.abortController?.signal.aborted) return new Promise(() => {})

      if (opts?.effort !== undefined) {
        if (
          typeof opts.effort !== 'string' ||
          !(EFFORT_LEVELS as readonly string[]).includes(opts.effort)
        ) {
          throw new TypeError(
            `agent({effort}) must be one of ${EFFORT_LEVELS.join(' | ')}; got ${JSON.stringify(opts.effort)}`,
          )
        }
      }
      validateWorkflowTier(opts?.tier)
      if (opts) {
        const routed = resolveWorkflowRoutedModel(opts)
        if (routed !== undefined) opts.model = routed
      }
      if (opts?.model !== undefined && opts.model !== null) {
        const engine = await resolveEngineDispatch(String(opts.model))
        if (engine) opts.model = engine.model
      }

      try {
        assertUnderAgentCap()
        assertBudgetRemains()
      } catch (e) {
        await sleep(0)
        throw e
      }

      const index = ++admitted
      const prompt = String(promptIn)
      const label =
        opts?.label != null
          ? String(opts.label)
          : prompt.slice(0, 60).replace(/\s+/g, ' ').trim()
      const phaseTitle = opts?.phase != null ? String(opts.phase) : activePhaseTitle
      const phaseIndex = phaseTitle != null ? resolvePhase(phaseTitle) : undefined
      const stallMs = opts?.stallMs != null ? Number(opts.stallMs) : DEFAULT_STALL_MS
      const promptPreview = previewOf(prompt)
      const mainLoopModel = contextView.options?.mainLoopModel

      let cacheKey: string | undefined
      if (journal) {
        cacheKey = agentCacheKey(prompt, opts, cacheChainTip)
        cacheChainTip = cacheKey
        const hit = replayWindowClosed ? undefined : replayResults.get(cacheKey)
        if (hit !== undefined) {
          const entry = hit as JournalResultEntry
          let recordedModel: string | undefined
          let recordedEffort: string | undefined
          if (opts?.model == null && entry.agentId) {
            try {
              const meta = await readAgentMetadata(entry.agentId as never)
              recordedModel = meta?.model
              recordedEffort = meta?.effort ?? meta?.effortOverride
            } catch {
            }
          }
          const now = Date.now()
          emit({
            type: 'progress',
            toolUseID: `workflow_agent_${index}_cached`,
            data: {
              type: 'workflow_agent',
              index,
              label,
              phaseIndex,
              phaseTitle,
              agentId: entry.agentId,
              model:
                opts?.model != null
                  ? String(opts.model)
                  : (recordedModel ?? 'provenance unknown'),
              effort:
                opts?.effort != null
                  ? String(opts.effort)
                  : (recordedEffort ?? undefined),
              state: 'done',
              startedAt: now,
              lastProgressAt: now,
              cached: true,
              resultPreview: previewOf(entry.result),
              promptPreview,
            },
          })
          return clone(entry.result)
        }
        replayWindowClosed = true
      }

      let anyAttemptStarted = false
      let latestStartedId: string | undefined
      const onAttemptStarted = (id: string): void => {
        anyAttemptStarted = true
        latestStartedId = id
        if (!journal || !cacheKey) return
        void journal.append({ type: 'started', key: cacheKey, agentId: id }).catch(() => {})
      }
      const recordResult = async (result: unknown): Promise<unknown> => {
        if (journal && cacheKey && result !== null) {
          await journal
            .append({ type: 'result', key: cacheKey, agentId: latestStartedId ?? '', result })
            .catch(() => {})
        }
        return result
      }

      const queuedAt = Date.now()
      if (opts?.isolation === 'remote') {
        throw new Error("agent({isolation:'remote'}) is not available in this build")
      }

      const queuedTile = (data: Record<string, unknown>): ProgressFrame => ({
        type: 'progress',
        toolUseID: `workflow_agent_${index}_queued`,
        data: {
          type: 'workflow_agent',
          index,
          label,
          phaseIndex,
          phaseTitle,
          model: opts?.model ?? mainLoopModel,
          effort: opts?.effort != null ? String(opts.effort) : undefined,
          queuedAt,
          promptPreview,
          ...data,
        },
      })
      emit(
        queuedTile({
          agentType: opts?.agentType != null ? String(opts.agentType) : undefined,
          isolation: opts?.isolation === 'worktree' ? 'worktree' : undefined,
          state: 'start',
          lastProgressAt: Date.now(),
        }),
      )

      try {
        return await recordResult(
          await runAgentCall({
            index,
            prompt,
            label,
            phaseTitle,
            phaseIndex,
            stallMs,
            opts,
            onAttemptStarted,
            queuedAt,
          }),
        )
      } catch (e) {
        if (!anyAttemptStarted && !ctx.abortController?.signal.aborted) {
          emit(
            queuedTile({
              state: 'error',
              lastProgressAt: Date.now(),
              error: e instanceof Error ? e.message : String(e),
            }),
          )
        }
        throw e
      }
    },
  )

  interface AgentCallJob {
    index: number
    prompt: string
    label: string
    phaseTitle: string | undefined
    phaseIndex: number | undefined
    stallMs: number
    opts: Record<string, unknown> | undefined
    onAttemptStarted: (id: string) => void
    queuedAt: number
  }

  async function runAgentCall(job: AgentCallJob): Promise<unknown> {
    const { index, prompt, label, phaseTitle, phaseIndex, stallMs, opts, onAttemptStarted, queuedAt } = job
    if (ctx.abortController?.signal.aborted) throw new Error('Workflow aborted')
    assertBudgetRemains()

    let customDef: unknown
    if (opts?.agentType != null) {
      customDef = resolveCustomAgentType(String(opts.agentType), Boolean(opts.schema))
    }

    let structuredTool: unknown
    if (opts?.schema) {
      const built = buildStructuredTool(opts.schema)
      if (built.error !== undefined) {
        throw new TypeError(`agent({schema}) received an invalid JSON Schema: ${built.error}`)
      }
      structuredTool = built.tool
    }

    const agentDef =
      customDef ?? (structuredTool ? WORKFLOW_SUBAGENT_SCHEMA_DEF : WORKFLOW_SUBAGENT_DEF)

    let worktree: WorktreeHandle | null = null
    if (opts?.isolation === 'worktree') {
      worktree = await createAgentWorktree(runId ? `wf_${runId}-${index}` : `wf-${index}`)
    }
    const worktreePath = worktree?.worktreePath
    const effectivePrompt = worktree
      ? `${prompt}\n\n---\nYou are running in an isolated git worktree at ${worktree.worktreePath} (a separate working copy of the repo). Changes you make here do NOT affect the main working directory or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`
      : prompt

    const carryover = { tokens: 0, toolCalls: 0, durationMs: 0 }
    const recovery: RecoveryBudget = makeRecoveryBudget()
    const statics: CallFrameStatics = {
      index,
      phaseIndex,
      phaseTitle,
      agentType:
        (agentDef as { agentType?: unknown })?.agentType != null
          ? String((agentDef as { agentType?: unknown }).agentType)
          : undefined,
      isolation: opts?.isolation === 'worktree' ? 'worktree' : undefined,
      model: (opts?.model ?? contextView.options?.mainLoopModel) as string | undefined,
      effort: opts?.effort != null ? String(opts.effort) : undefined,
      queuedAt,
      hasStructuredTool: structuredTool !== undefined,
      carryover,
    }
    const foldIn = (r: AttemptReport): void => {
      carryover.tokens += r.tokens
      carryover.toolCalls += r.toolCalls
      carryover.durationMs += r.durationMs
    }

    const runAttempt = async (
      attemptLabel: string,
      attemptNo: number,
      reason?: string,
      continuation?: unknown[],
      modelOverride?: string,
    ): Promise<AttemptReport> => {
      const agentId = createAgentId()
      onAttemptStarted(agentId)
      if (modelOverride !== undefined) statics.model = modelOverride

      const childAbort = new AbortController()
      const parentSignal = ctx.abortController?.signal
      const onParentAbort = (): void => childAbort.abort('workflow-abort')
      parentSignal?.addEventListener('abort', onParentAbort)
      if (parentSignal?.aborted) childAbort.abort('workflow-abort')
      onAgentController?.(agentId, childAbort)

      const startedAt = Date.now()
      const attemptPromptPreview = previewOf(effectivePrompt)
      let lastToolName: string | undefined
      let lastToolSummary: string | undefined
      const tileId = `workflow_agent_${statics.index}_${agentId}`
      const emitFrame = (
        state: 'start' | 'progress' | 'done' | 'error' | 'skipped',
        extra?: Record<string, unknown>,
      ): void => {
        emit({
          type: 'progress',
          toolUseID: tileId,
          data: {
            type: 'workflow_agent',
            index: statics.index,
            label: attemptLabel,
            phaseIndex: statics.phaseIndex,
            phaseTitle: statics.phaseTitle,
            agentId,
            agentType: statics.agentType,
            isolation: statics.isolation,
            model: statics.model,
            effort: statics.effort,
            state,
            startedAt,
            queuedAt: statics.queuedAt,
            attempt: attemptNo,
            lastAttemptReason: reason,
            lastToolName,
            lastToolSummary,
            promptPreview: attemptPromptPreview,
            lastProgressAt: Date.now(),
            ...extra,
          },
        })
      }

      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let awaitingFirstToken = false
      let prefillGraceUsed = false
      let sawAssistant = false
      let recoveryHeartbeat: ReturnType<typeof setInterval> | undefined
      let budgetCut: ReturnType<typeof setTimeout> | undefined
      let lastDeclaredEndsAt: number | undefined
      const clearBudgetCut = (): void => {
        if (budgetCut !== undefined) clearTimeout(budgetCut)
        budgetCut = undefined
      }
      const clearHeartbeat = (): void => {
        if (recoveryHeartbeat !== undefined) {
          clearInterval(recoveryHeartbeat)
          recoveryHeartbeat = undefined
        }
      }
      const clearStallTimer = (): void => {
        if (stallTimer !== undefined) {
          clearTimeout(stallTimer)
          stallTimer = undefined
        }
      }
      const onStallExpiry = (): void => {
        if (awaitingFirstToken && !prefillGraceUsed && !sawAssistant) {
          prefillGraceUsed = true
          emitFrame('progress', { waiting: 'prefill' })
          armStallTimer()
          return
        }
        childAbort.abort('stalled')
      }
      const armStallTimer = (): void => {
        clearStallTimer()
        if (stallMs > 0) stallTimer = setTimeout(onStallExpiry, stallMs)
      }
      const armStallTimerForRecovery = (honoredMs: number): void => {
        clearStallTimer()
        if (stallMs > 0) {
          stallTimer = setTimeout(onStallExpiry, honoredMs + stallMs)
        }
      }

      let lastBumpAt = 0
      const bumpThrottleMs = Math.min(stallMs * 0.1, 1000)
      const onQueryProgress = (evt?: unknown): void => {
        const m = evt as
          | {
              type?: string
              subtype?: string
              retryInMs?: number
              recoveryTimeoutMs?: number
              retryAttempt?: number
            }
          | undefined
        const notice = recoveryNoticeFacts(m)
        if (notice !== null) {
          const isRealDelay = typeof m?.retryInMs === 'number' && m.retryInMs > 0
          const { honoredMs, spent } = chargeRecoveryWait(recovery, notice.declaredMs, notice.status)
          lastDeclaredEndsAt = Date.now() + notice.declaredMs
          clearBudgetCut()
          if (spent && honoredMs <= 0) {
            clearHeartbeat()
            childAbort.abort('throttled')
            return
          }
          if (spent) {
            budgetCut = setTimeout(() => {
              clearHeartbeat()
              childAbort.abort('throttled')
            }, honoredMs)
            budgetCut.unref?.()
          }
          armStallTimerForRecovery(honoredMs)
          const window = isRealDelay
            ? { retryInMs: honoredMs }
            : { recoveryTimeoutMs: honoredMs }
          const waitWords = retryWaitWords({
            attempt: notice.attempt ?? recovery.waits,
            of: notice.of,
            declaredMs: notice.declaredMs,
            honoredMs,
            status: notice.status,
            budget: recovery,
          })
          emitFrame('progress', {
            waiting: 'provider-backoff',
            ...window,
            retryAttempt: notice.attempt,
            waitWords,
          })
          clearHeartbeat()
          recoveryHeartbeat = setInterval(() => {
            emitFrame('progress', { waiting: 'provider-backoff', ...window, retryAttempt: notice.attempt, waitWords })
          }, RECOVERY_HEARTBEAT_MS)
          return
        }
        if (m !== undefined && m.type !== 'progress') clearBudgetCut()
        if (m?.type === 'request_wait') {
          const wait = (m as { wait?: unknown }).wait
          if (wait !== null && typeof wait === 'object' && (wait as { kind?: unknown }).kind === 'first-byte') {
            const w = wait as { budgetMs?: unknown; sinceMs?: unknown }
            const waitWords =
              typeof w.budgetMs === 'number' && w.budgetMs > 0
                ? agentWaitWords({ phase: 'first-byte', sinceMs: typeof w.sinceMs === 'number' ? w.sinceMs : Date.now(), budgetMs: w.budgetMs }, null)
                : null
            emitFrame('progress', { waiting: 'prefill', ...(waitWords !== null ? { waitWords } : {}) })
          }
          return
        }
        if (m?.type === 'stream_request_start') awaitingFirstToken = true
        else if (m !== undefined) awaitingFirstToken = false
        const now = Date.now()
        if (now - lastBumpAt < bumpThrottleMs) return
        lastBumpAt = now
        clearHeartbeat()
        armStallTimer()
      }

      let lastAssistant: Extract<SubagentStreamEvent, { type: 'assistant' }> | undefined
      let structured: unknown
      let tokens = 0
      let toolCalls = 0
      let schemaCallCount = 0
      let lastSchemaCallInput: unknown
      let terminal400: string | undefined
      const conversation: unknown[] = continuation
        ? [...continuation]
        : [createUserMessage({ content: effectivePrompt })]

      const availableTools = structuredTool
        ? spliceStructuredTool(structuredTool, agentDef)
        : undefined

      const carry = statics.carryover
      const settledTotals = (elapsed: number): Record<string, unknown> => ({
        tokens: carry.tokens + tokens,
        toolCalls: carry.toolCalls + toolCalls,
        durationMs: carry.durationMs + elapsed,
      })
      const deliveredSettle = (elapsed: number): AttemptReport => {
        emitFrame('done', {
          ...settledTotals(elapsed),
          resultPreview: previewOf(structured),
        })
        return {
          structured,
          text: '',
          tokens,
          toolCalls,
          stallCut: false,
          skipped: false,
          durationMs: elapsed,
          schemaCallCount,
          lastSchemaCallInput,
        }
      }
      const apiErrorSettle = (elapsed: number, message: string): AttemptReport => {
        emitFrame('error', { error: message, ...settledTotals(elapsed) })
        return {
          structured,
          text: '',
          apiError: message,
          tokens,
          toolCalls,
          stallCut: false,
          skipped: false,
          durationMs: elapsed,
          stopReason: null,
          outputTokens: undefined,
          schemaCallCount,
          lastSchemaCallInput,
        }
      }

      const capPauseSettle = (
        elapsed: number,
        text: string,
        words: string,
        resetsAtMs: number | undefined,
        outputTokens?: number,
      ): AttemptReport => {
        const model = modelOverride ?? statics.model
        const family = providerFamilyOfSetting(model ?? null)
        const pausedFrame = (): void => emitFrame('progress', { waiting: 'usage-window', waitWords: words, ...settledTotals(elapsed) })
        pausedFrame()
        return {
          structured,
          text,
          tokens,
          toolCalls,
          stallCut: false,
          skipped: false,
          durationMs: elapsed,
          stopReason: null,
          outputTokens,
          schemaCallCount,
          lastSchemaCallInput,
          capPause: {
            words,
            family,
            model,
            resetsAtMs,
            transcript: balancedTranscriptPrefix(conversation.filter(m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true)),
            keepAlive: pausedFrame,
          },
        }
      }

      emitFrame(
        'start',
        carry.tokens || carry.toolCalls
          ? { tokens: carry.tokens, toolCalls: carry.toolCalls }
          : undefined,
      )
      armStallTimer()
      try {
        for await (const ev of spawnStream({
          agentDefinition: agentDef,
          prompt: effectivePrompt,
          toolUseContext: { ...(ctx as object), abortController: childAbort } as WorkflowToolContext,
          canUseTool,
          availableTools,
          transcriptSubdir: runId ? `workflows/${runId}` : undefined,
          workflowRunId: runId,
          agentId,
          model: modelOverride ?? (opts?.model != null ? String(opts.model) : undefined),
          effort: opts?.effort != null ? String(opts.effort) : undefined,
          worktreePath,
          description: attemptPromptPreview,
          seatHolder: attemptLabel,
          continuationMessages: continuation,
          onQueryProgress,
          onWait: words => emitFrame('progress', words === null ? {} : { waiting: 'seat', waitWords: words }),
          onResolvedIdentity: identity => {
            const changed = identity.model !== statics.model || identity.effort !== statics.effort
            statics.model = identity.model
            statics.effort = identity.effort
            if (changed) emitFrame('progress')
          },
        })) {
          if (ev.type === 'attachment') {
            const att = (ev as Extract<SubagentStreamEvent, { type: 'attachment' }>).attachment
            if (att.type === 'structured_output') structured = att.data
            continue
          }
          if (ev.type === 'user') {
            conversation.push(ev)
            continue
          }
          if (ev.type !== 'assistant') continue

          sawAssistant = true
          awaitingFirstToken = false
          conversation.push(ev)
          const a = ev as Extract<SubagentStreamEvent, { type: 'assistant' }>
          lastAssistant = a
          if (a.isApiErrorMessage) {
            const errText = extractTextContent(a.message.content, '\n')
            if (DETERMINISTIC_400_RE.test(errText)) {
              terminal400 = errText || 'invalid request (deterministic 400)'
              childAbort.abort('terminal-400')
            }
          } else if (a.message.usage) {
            tokens = getTokenCountFromUsage(
              a.message.usage as unknown as Parameters<typeof getTokenCountFromUsage>[0],
            )
          }
          let toolUsesHere = 0
          for (const block of a.message.content) {
            if (block.type !== 'tool_use') continue
            toolUsesHere++
            lastToolName = block.name
            lastToolSummary = toolInputGlance(block.input)
            if (block.name === STRUCTURED_OUTPUT_TOOL_NAME) {
              schemaCallCount++
              lastSchemaCallInput = block.input
            }
          }
          toolCalls += toolUsesHere
          if (toolUsesHere > 0) {
            clearStallTimer()
          } else {
            armStallTimer()
          }
          emitFrame('progress', {
            tokens: carry.tokens + tokens,
            toolCalls: carry.toolCalls + toolCalls,
          })
        }
      } catch (e) {
        const cutReason = childAbort.signal.aborted
          ? (childAbort.signal.reason as string | undefined)
          : undefined
        const elapsed = Date.now() - startedAt
        if (cutReason === 'terminal-400' && terminal400) {
          return structured !== undefined
            ? deliveredSettle(elapsed)
            : apiErrorSettle(elapsed, terminal400)
        }
        if (cutReason === 'throttled') {
          if (structured !== undefined) return deliveredSettle(elapsed)
          const message = recoveryBudgetSpentLine(recovery)
          if (recovery.lastStatus === 429) return capPauseSettle(elapsed, '', `${message}; waiting for a model switch${lastDeclaredEndsAt !== undefined ? ` or the declared wait's end at ${clockOf(lastDeclaredEndsAt)}` : ''} — /model switches this agent`, lastDeclaredEndsAt)
          return apiErrorSettle(elapsed, message)
        }
        if (cutReason === 'stalled' || cutReason === 'user-retry') {
          if (cutReason === 'stalled' && structured !== undefined) {
            return deliveredSettle(elapsed)
          }
          if (terminal400) return apiErrorSettle(elapsed, terminal400)
          emitFrame('error', {
            error:
              cutReason === 'stalled'
                ? `stalled — no progress for ${stallMs}ms`
                : 'retry requested by user',
            ...settledTotals(elapsed),
          })
          return {
            structured: undefined,
            text: '',
            tokens,
            toolCalls,
            stallCut: true,
            stallKind: cutReason,
            skipped: false,
            durationMs: elapsed,
            schemaCallCount,
            lastSchemaCallInput,
            transcript: conversation,
          }
        }
        if (cutReason === 'user-skip') {
          emitFrame('skipped', {
            error: 'skipped by user',
            skipped: true,
            ...settledTotals(elapsed),
          })
          return {
            structured: undefined,
            text: '',
            tokens,
            toolCalls,
            stallCut: false,
            skipped: true,
            durationMs: elapsed,
            schemaCallCount,
            lastSchemaCallInput,
          }
        }
        emitFrame('error', {
          error: e instanceof Error ? e.message : String(e),
          ...settledTotals(elapsed),
        })
        if (e instanceof AbortError) throw new Error('Workflow aborted')
        throw e
      } finally {
        clearStallTimer()
        clearHeartbeat()
        clearBudgetCut()
        parentSignal?.removeEventListener('abort', onParentAbort)
        onAgentController?.(agentId, null)
      }

      const elapsed = Date.now() - startedAt
      const finalText = lastAssistant
        ? extractTextContent(lastAssistant.message.content, '\n')
        : ''
      const finalOutputTokens = lastAssistant?.message.usage?.output_tokens
      if (lastAssistant?.isApiErrorMessage && lastAssistant.error === 'rate_limit' && structured === undefined) {
        const model = modelOverride ?? statics.model
        const family = providerFamilyOfSetting(model ?? null)
        const window = ((): { resetsAtMs?: number; windowName?: string } => {
          try {
            return observedFamilyWindow(family, undefined, { model: model ?? null })
          } catch {
            return {}
          }
        })()
        const who = ((): string => {
          if (model === undefined) return family
          try {
            return getMarketingNameForModel(model) ?? model
          } catch {
            return model
          }
        })()
        const words = `waiting for ${who}'s ${window.windowName ?? 'usage window'} — ${window.resetsAtMs !== undefined ? `resets at ${clockOf(window.resetsAtMs)}` : 'no reset stated'}; /model switches this agent`
        return capPauseSettle(elapsed, finalText, words, window.resetsAtMs, finalOutputTokens)
      }
      if (lastAssistant?.isApiErrorMessage) {
        if (structured !== undefined) return deliveredSettle(elapsed)
        const apiError = finalText || 'API error'
        emitFrame('error', { error: apiError, ...settledTotals(elapsed) })
        return {
          structured,
          text: finalText,
          apiError,
          tokens,
          toolCalls,
          stallCut: false,
          skipped: false,
          durationMs: elapsed,
          stopReason: lastAssistant.message.stop_reason ?? null,
          outputTokens: finalOutputTokens,
          schemaCallCount,
          lastSchemaCallInput,
        }
      }
      emitFrame('done', {
        ...settledTotals(elapsed),
        resultPreview: previewOf(statics.hasStructuredTool ? structured : finalText),
      })
      return {
        structured,
        text: finalText,
        tokens,
        toolCalls,
        stallCut: false,
        skipped: false,
        durationMs: elapsed,
        stopReason: lastAssistant?.message.stop_reason ?? null,
        outputTokens: finalOutputTokens,
        schemaCallCount,
        lastSchemaCallInput,
        transcript: conversation,
      }
    }

    const attempt = (
      attemptLabel: string,
      attemptNo: number,
      reason?: string,
      continuation?: unknown[],
      modelOverride?: string,
    ): Promise<AttemptReport> =>
      worktreePath
        ? Promise.resolve(
            runWithCwdOverride(worktreePath, () =>
              runAttempt(attemptLabel, attemptNo, reason, continuation, modelOverride),
            ),
          )
        : runAttempt(attemptLabel, attemptNo, reason, continuation, modelOverride)

    try {
      let report = await attempt(label, 1)

      const looksThrottled = (r: AttemptReport): boolean =>
        r.capPause === undefined &&
        (r.apiError === undefined ||
          (!DETERMINISTIC_400_RE.test(r.apiError) &&
            !r.apiError.startsWith('provider throttled'))) &&
        !r.stallCut &&
        !r.skipped &&
        r.stopReason == null &&
        r.structured === undefined &&
        (r.outputTokens ?? Infinity) < 50 &&
        r.durationMs > stallMs * 0.5
      const tookThrottleRescue = looksThrottled(report)
      if (tookThrottleRescue) {
        log(
          `[${label}] throttled response (no stop_reason, ${report.outputTokens ?? '?'} output tokens in ${Math.round(report.durationMs / 1000)}s) — sleeping 45s before retry`,
        )
        await sleep(THROTTLE_BACKOFF_MS, ctx.abortController?.signal, { throwOnAbort: true })
        foldIn(report)
        report = await attempt(`${label} (throttle-retry)`, 2, 'throttled')
        if (looksThrottled(report)) {
          log(`[${label}] throttle-retry also degraded — giving up on throttle backoff`)
        }
      }

      let attemptsSoFar = tookThrottleRescue ? 2 : 1
      let resumedModel: string | undefined
      for (let p = 0; report.capPause !== undefined; p++) {
        const pause = report.capPause
        if (p >= MAX_CAP_PAUSES) {
          report = { ...report, capPause: undefined, apiError: pause.words }
          break
        }
        log(`[${label}] paused — ${pause.words}`)
        const lift = await waitForCapLift(pause, ctx.abortController?.signal)
        if (lift.kind === 'aborted') throw new Error('Workflow aborted')
        if (lift.kind === 'switched') resumedModel = lift.model
        const why =
          lift.kind === 'switched'
            ? `the model switched${lift.model !== undefined ? ` to ${lift.model}` : ''} — resumed`
            : 'the usage window reset — resumed'
        log(`[${label}] ${why}`)
        foldIn(report)
        attemptsSoFar++
        report = pause.transcript
          ? await attempt(
              `${label} (resumed)`,
              attemptsSoFar,
              why,
              [...pause.transcript, createUserMessage({ content: CAP_RESUME_PROMPT })],
              resumedModel,
            )
          : await attempt(`${label} (resumed)`, attemptsSoFar, why, undefined, resumedModel)
      }

      const cutTrail: string[] = []
      for (let a = 1; report.stallCut && !tookThrottleRescue && a <= MAX_STALL_RETRIES; a++) {
        if (ctx.abortController?.signal.aborted) throw new Error('Workflow aborted')
        const cutKind = report.stallKind ?? 'stalled'
        cutTrail.push(cutKind)
        const why = cutKind === 'user-retry' ? 'retry requested by user' : 'stalled (no progress)'
        const schemaNote =
          cutKind === 'stalled' && report.schemaCallCount > 0 && report.structured === undefined
            ? ` — ${report.schemaCallCount} ${STRUCTURED_OUTPUT_TOOL_NAME} validation ${plural(report.schemaCallCount, 'failure')} (last input: ${clip(JSON.stringify(report.lastSchemaCallInput), 300)})`
            : ''
        log(
          `[stall] agent "${label}" ${why} after ${Math.round(report.durationMs / 1000)}s${schemaNote} — retrying (${a}/${MAX_STALL_RETRIES})`,
        )
        foldIn(report)
        const resumable = cutKind === 'stalled' ? balancedTranscriptPrefix(report.transcript) : null
        report = resumable
          ? await attempt(`${label} (retry ${a})`, a + 1, why, [
              ...resumable,
              createUserMessage({ content: STALL_RESUME_PROMPT }),
            ])
          : await attempt(`${label} (retry ${a})`, a + 1, why)
      }

      if (report.skipped) return null
      if (report.stallCut) {
        cutTrail.push(report.stallKind ?? 'stalled')
        const n = cutTrail.length
        const allUserRetry = cutTrail.every(r => r === 'user-retry')
        const allStalled = cutTrail.every(r => r === 'stalled')
        throw new Error(
          allUserRetry
            ? `agent abandoned: user requested retry on all ${n} attempts`
            : allStalled
              ? `agent stalled on all ${n} attempts (no progress for ${stallMs}ms each)`
              : `agent abandoned after ${n} attempts (${cutTrail.join(' → ')})`,
        )
      }
      if (report.apiError) {
        const msg = `[${label}] failed: ${report.apiError}`
        failures.push(msg)
        log(msg)
        return null
      }
      if (structuredTool) {
        let nudges = 0
        while (report.structured === undefined && nudges < MAX_STRUCTURED_OUTPUT_NUDGES) {
          nudges++
          log(
            `[${label}] subagent stopped without calling ${STRUCTURED_OUTPUT_TOOL_NAME} — corrective re-prompt ${nudges}/${MAX_STRUCTURED_OUTPUT_NUDGES} (same conversation)`,
          )
          report = await attempt(
            `${label} (structured-output re-prompt ${nudges})`,
            1 + nudges,
            'structured-output-nudge',
            [
              ...(report.transcript ?? []),
              createUserMessage({ content: STRUCTURED_OUTPUT_NUDGE_PROMPT }),
            ],
          )
          if (report.skipped) return null
          if (report.stallCut) {
            throw new Error(
              `agent({schema}): corrective re-prompt ${nudges} stalled (no progress for ${stallMs}ms) after the subagent stopped without calling ${STRUCTURED_OUTPUT_TOOL_NAME}`,
            )
          }
          if (report.apiError) {
            const msg = `[${label}] failed during structured-output re-prompt ${nudges}: ${report.apiError}`
            failures.push(msg)
            log(msg)
            return null
          }
        }
        if (report.structured === undefined) {
          throw new Error(
            `agent({schema}): subagent completed without calling ${STRUCTURED_OUTPUT_TOOL_NAME} (after ${nudges} in-conversation corrective re-prompt${nudges === 1 ? '' : 's'})`,
          )
        }
        return clone(report.structured)
      }
      return report.text
    } finally {
      if (worktree) {
        try {
          const receipt = await settleAgentWorktree({
            worktreePath: worktree.worktreePath,
            worktreeBranch: worktree.worktreeBranch,
            headCommit: worktree.headCommit,
            gitRoot: worktree.gitRoot,
            hookBased: worktree.hookBased,
          })
          if (receipt.outcome === 'preserved') {
            log(`worktree preserved (${receipt.summary}): ${worktree.worktreePath}`)
          } else if (receipt.outcome === 'retryable-partial' || receipt.outcome === 'inspection-unavailable') {
            log(`worktree not settled (${receipt.outcome}: ${receipt.detail}): ${worktree.worktreePath}`)
          }
        } catch (settleErr) {
          log(
            `worktree settlement failed (${settleErr instanceof Error ? settleErr.message : String(settleErr)}): ${worktree.worktreePath}`,
          )
        }
      }
    }
  }

  function collectSlots(
    outcomes: PromiseSettledResult<{ v: unknown }>[],
    kind: 'parallel' | 'pipeline',
  ): unknown[] {
    let dropped = 0
    const slots = outcomes.map((s, i) => {
      if (s.status === 'fulfilled') return s.value.v
      const { name, msg } = splitRejection(s.reason)
      if (name === 'WorkflowBudgetExceededError') {
        dropped++
        return null
      }
      const failMsg = `${kind}[${i}] failed: ${msg}`
      failures.push(failMsg)
      log(failMsg)
      return null
    })
    if (dropped > 0) {
      failures.push(`${kind}: ${dropped} ${plural(dropped, 'slot')} dropped — token budget exceeded`)
    }
    return slots
  }

  const parallel = errorTunnel(async (thunksIn: unknown): Promise<unknown[]> => {
    if (ctx.abortController?.signal.aborted) return new Promise(() => {})
    await sleep(0)
    if (!Array.isArray(thunksIn)) throw new TypeError('parallel() expects an array of functions')
    const thunks = readBoundaryArray(thunksIn)
    if (thunks.length === 0) return clone([]) as unknown[]
    assertUnderAgentCap()
    assertBudgetRemains()
    for (const thunk of thunks) {
      if (typeof thunk !== 'function') {
        throw new TypeError(
          'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)',
        )
      }
    }
    const outcomes = await Promise.allSettled(thunks.map(t => settle(call(t))))
    return clone(collectSlots(outcomes, 'parallel')) as unknown[]
  })

  const pipeline = errorTunnel(
    async (itemsIn: unknown, ...stagesIn: unknown[]): Promise<unknown[]> => {
      if (ctx.abortController?.signal.aborted) return new Promise(() => {})
      await sleep(0)
      if (!Array.isArray(itemsIn)) {
        throw new TypeError('pipeline() expects an array as the first argument')
      }
      const items = readBoundaryArray(itemsIn)
      const stages = readBoundaryArray(stagesIn)
      if (items.length === 0) return clone([]) as unknown[]
      assertUnderAgentCap()
      assertBudgetRemains()
      for (const stage of stages) {
        if (typeof stage !== 'function') {
          throw new TypeError(
            'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
          )
        }
      }
      const outcomes = await Promise.allSettled(
        items.map(async (item, index) => {
          let acc = await settle(item)
          for (const stage of stages) {
            if (acc.v === null) break
            acc = await settle(call(stage, acc.v, item, index))
          }
          return acc
        }),
      )
      return clone(collectSlots(outcomes, 'pipeline')) as unknown[]
    },
  )

  const hooks: WorkflowHooks & {
    resolvePhase: (title: string, kind?: 'child') => number
    recordFailure: (msg: string) => void
  } = {
    agent: agent as WorkflowHooks['agent'],
    parallel: parallel as WorkflowHooks['parallel'],
    pipeline: pipeline as WorkflowHooks['pipeline'],
    log,
    phase,
    resolvePhase,
    recordFailure: (m: string) => {
      failures.push(m)
    },
    getAgentCount: () => admitted,
    getFailures: () => failures,
    bindVMAwait: b => {
      settle = b.settle
      call = b.call
      clone = b.clone
    },
  }
  return hooks
}

interface CapPause {
  words: string
  family: string
  model: string | undefined
  resetsAtMs: number | undefined
  transcript: unknown[] | null
  keepAlive: () => void
}

type CapLift = { kind: 'switched'; model: string | undefined } | { kind: 'reset' } | { kind: 'aborted' }

function clockOf(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function waitForCapLift(pause: CapPause, signal: AbortSignal | undefined): Promise<CapLift> {
  return new Promise<CapLift>(resolve => {
    let done = false
    let resetTimer: ReturnType<typeof setTimeout> | undefined
    let keep: ReturnType<typeof setInterval> | undefined
    let unsubscribe: (() => void) | undefined
    const onAbort = (): void => settle({ kind: 'aborted' })
    const settle = (lift: CapLift): void => {
      if (done) return
      done = true
      if (resetTimer !== undefined) clearTimeout(resetTimer)
      if (keep !== undefined) clearInterval(keep)
      unsubscribe?.()
      signal?.removeEventListener('abort', onAbort)
      resolve(lift)
    }
    if (signal?.aborted) {
      settle({ kind: 'aborted' })
      return
    }
    signal?.addEventListener('abort', onAbort)
    unsubscribe = subscribeMainLoopModelOverride(model => {
      const next = model === undefined || model === null ? undefined : String(model)
      if (next !== pause.model) settle({ kind: 'switched', model: next })
    })
    if (pause.resetsAtMs !== undefined) {
      resetTimer = setTimeout(() => settle({ kind: 'reset' }), Math.max(1_000, pause.resetsAtMs - Date.now() + 1_000))
      resetTimer.unref?.()
    }
    keep = setInterval(() => pause.keepAlive(), CAP_KEEPALIVE_MS)
    keep.unref?.()
  })
}

interface AttemptReport {
  capPause?: CapPause
  structured: unknown
  text: string
  apiError?: string
  tokens: number
  toolCalls: number
  durationMs: number
  stallCut: boolean
  stallKind?: 'stalled' | 'user-retry'
  skipped: boolean
  stopReason?: string | null
  outputTokens?: number
  schemaCallCount: number
  lastSchemaCallInput: unknown
  transcript?: unknown[]
}

interface CallFrameStatics {
  index: number
  phaseIndex: number | undefined
  phaseTitle: string | undefined
  agentType: string | undefined
  isolation: 'worktree' | undefined
  model: string | undefined
  effort: string | undefined
  queuedAt: number
  hasStructuredTool: boolean
  carryover: { tokens: number; toolCalls: number; durationMs: number }
}

function toolInputGlance(input: unknown): string | undefined {
  if (input == null) return undefined
  try {
    if (typeof input === 'string') return clip(input, 80) || undefined
    if (typeof input === 'object') {
      const o = input as Record<string, unknown>
      for (const k of ['command', 'description', 'prompt', 'path', 'file_path', 'pattern', 'query']) {
        const v = o[k]
        if (typeof v === 'string' && v.trim()) return clip(v.trim(), 80)
      }
      const j = JSON.stringify(input)
      return j ? clip(j, 80) : undefined
    }
    return clip(String(input), 80) || undefined
  } catch {
    return undefined
  }
}

function splitRejection(reason: unknown): { name: string; msg: string } {
  let name = ''
  try {
    const candidate = (reason as { name?: unknown } | undefined)?.name
    if (typeof candidate === 'string') name = candidate
  } catch {}
  let msg: string
  try {
    const candidate = (reason as { message?: unknown } | undefined)?.message
    if (typeof candidate === 'string') msg = candidate
    else if (typeof reason === 'string') msg = reason
    else msg = '<non-string reason>'
  } catch {
    msg = '<unprintable>'
  }
  return { name, msg }
}

function previewOf(v: unknown): string | undefined {
  if (v == null) return undefined
  let s: string
  try {
    s = (typeof v === 'string' ? v : JSON.stringify(v)).trim()
  } catch {
    return undefined
  }
  if (!s) return undefined
  return s.length > PREVIEW_MAX_CHARS ? s.slice(0, PREVIEW_MAX_CHARS) + '…' : s
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
function clip(s: string | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

interface WorktreeHandle {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}
interface HookContextView {
  abortController?: AbortController
  getAppState(): {
    toolPermissionContext: Record<string, unknown> & { mode?: string }
    mcp: { tools: unknown }
  }
  options?: {
    mainLoopModel?: string
    agentDefinitions?: {
      activeAgents: Array<{
        agentType: string
        getSystemPrompt?: () => string
        [k: string]: unknown
      }>
    }
  }
}
type ToolPool = Parameters<typeof assembleToolPool>[1]
