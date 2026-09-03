// The workflow AGENT-HOOKS layer: host-side implementations of the script DSL
// the executor projects into the workflow VM (buildVMContext → opts.makeHooks).
//
//   agent(prompt, opts?)   — spawn one subagent; optional schema-validated
//                            structured output; resume caching; retry ladders
//   parallel(thunks)       — barrier fan-out: never rejects, failed slot → null
//   pipeline(items, ...st) — per-item stage chains, no barrier between stages
//   log(msg) / phase(t)    — progress narration + phase-group bookkeeping
//   resolvePhase / recordFailure — extras the child-workflow callable needs
//
// Around those, this module owns the run's durability and safety machinery:
// the append-only resume journal (LocalFileJournal) with its chained sha256
// cache key, the lifetime agent cap and token-budget gates, the per-agent
// stall/throttle/skip/retry ladder with provider-recovery awareness, worktree
// isolation, and the structured-output corrective re-prompts.
//
// The actual subagent spawn is an adapter over the shared agent runner
// (runAgent): it assembles the worker tool pool, resolves the agent
// definition (a custom agentType from the session registry, else the built-in
// workflow subagent), and forwards the runner's yielded events unchanged. The
// adapter is injectable via deps.spawnSubagentStream — the seam tests use to
// drive a synthetic stream. deps.getStructuredOutputTool (default: the
// schema-bound validated output tool) and deps.resolveCustomAgentType are the
// other two injection points.

import { availableCores } from '../../utils/availableCores.js'
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

// The schema-bound structured-output tool builder and its canonical wire
// name. The name is owned by ./structuredOutputTool.js; importing and
// re-exporting it here keeps exactly one declaration across the two modules.
import {
  getSchemaBoundStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from './structuredOutputTool.js'
export { STRUCTURED_OUTPUT_TOOL_NAME }

// ── Tunables ─────────────────────────────────────────────────────────────────
// Lifetime agent() cap per run — a runaway-loop backstop, set far above any
// legitimate workflow.
const AGENT_LIFETIME_CAP = 1000
// Per-attempt no-progress watchdog; agent({stallMs}) overrides per call.
const DEFAULT_STALL_MS = 180_000
// Stall-retry ladder length before abandoning an agent.
const MAX_STALL_RETRIES = 5
// Result/prompt preview clamp on progress frames.
const PREVIEW_MAX_CHARS = 400
// Cache-key version prefix. Changing this orphans every existing journal —
// bump it only to deliberately invalidate all cached replays.
const JOURNAL_VERSION = 'v2'
// Sleep before the single throttle retry.
const THROTTLE_BACKOFF_MS = 45_000
// Provider-recovery budget. The API client surfaces its own recovery — an
// inner 429/5xx backoff declares its delay BEFORE sleeping, and the
// stream-idle non-streaming fallback declares a blocking-call ceiling. The
// stall watchdog must extend across a DECLARED recovery instead of killing
// it, while these caps bound a pathological provider so a held concurrency
// slot cannot wait forever. Past the total cap the attempt settles as
// throttled (an apiError — never the stall ladder, never a re-bill).
const RECOVERY_WAIT_CAP_MS = 600_000 // one declared wait, max honored
const RECOVERY_TOTAL_CAP_MS = 1_200_000 // cumulative declared waits per attempt
const RECOVERY_HEARTBEAT_MS = 30_000 // frame cadence while waiting
// Corrective re-prompts for a schema-bound agent that stopped cleanly WITHOUT
// calling the structured-output tool: the same conversation is extended with
// a corrective user message, so the completed work is preserved — never
// re-run from scratch.
const MAX_STRUCTURED_OUTPUT_NUDGES = 2
export const STRUCTURED_OUTPUT_NUDGE_PROMPT = `You stopped without calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool. Your work above is preserved — do NOT redo it. Call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool now, exactly once, with your final answer in the shape its input schema requires. Do not reply with text; the calling script reads ONLY the ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.`
// API rejections that can never succeed on retry — each retry would re-bill
// the full oversized prompt into the same wall. Kept TIGHT on purpose:
// transient classes (overloads, 5xx, timeouts) must keep retry semantics.
const DETERMINISTIC_400_RE =
  /prompt is too long|prompt too long|maximum context length|context window exceeded|invalid_request_error/i

// Concurrency cap: clamp(cpuCount − 2, 2, 16), composed with the capacity
// governor's live delegation ceiling so the scheduler width and the
// provider-boundary backstop read one truth — a narrowed profile genuinely
// narrows workflow fan-out instead of merely queueing at the permit. The
// default ceiling (16) leaves the historical clamp unchanged.
export function computeConcurrencyCap(cpuCount: number): number {
  return Math.min(
    16,
    Math.max(2, cpuCount - 2),
    governorCeilings().delegationLanes,
  )
}

// ── Errors thrown into scripts ───────────────────────────────────────────────
/** The lifetime agent() cap was hit — almost always an unbounded budget loop. */
export class WorkflowAgentCapError extends Error {
  constructor() {
    super(
      `Workflow agent() call cap reached (${AGENT_LIFETIME_CAP}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`,
    )
    this.name = 'WorkflowAgentCapError'
  }
}
/** The turn token budget is spent; further agent() calls stop. */
export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    )
    this.name = 'WorkflowBudgetExceededError'
  }
}

// ── The built-in workflow subagent ───────────────────────────────────────────
// Two return contracts, selected by whether agent() carried a schema: the
// verbatim-text return, and the structured-output-tool return. These strings
// are live system-prompt text — treat every word as behavior.
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

// Suffixes grafted onto a CUSTOM agentType's own system prompt — the same two
// return contracts, phrased as an embedded note.
export const SCHEMA_APPEND = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.`
export const TEXT_APPEND = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`

// Workflow subagents may not spawn their own delegation trees.
const SUBAGENT_DISALLOWED_TOOLS = ['Agent', 'Task', 'Workflow']

// A thin operating preamble ahead of the return-value contract. The contract
// strings above stay LAST by concatenation and are never retyped.
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
  // The verbatim-text / structured-output return is a FIXED contract: the
  // worker holds the normal response register even when the session runs a
  // terse one, because a chatty or clipped register corrupts a return value
  // that gets parsed. NB: constants/subagentDoctrine.ts cannot import this
  // module (it would cycle through the agent runner), so it hard-codes
  // 'workflow-subagent' in its exempt set — the agentType string must stay
  // stable or that seam moves with it.
  fixedOutputContract: true,
  getSystemPrompt: () => buildSubagentTextPrompt(),
} as const
export const WORKFLOW_SUBAGENT_SCHEMA_DEF = {
  ...WORKFLOW_SUBAGENT_DEF,
  getSystemPrompt: () => buildSubagentSchemaPrompt(),
} as const

// =============================================================================
// Resume journal: entry shapes, indexing, cache keys, and the JSONL file.
// =============================================================================

export interface JournalStartedEntry {
  type: 'started'
  key: string
  agentId: string
  /** Owner epoch at append time; legacy rows omit it. */
  epoch?: number
}
export interface JournalResultEntry {
  type: 'result'
  key: string
  agentId: string
  result: unknown
  /** Owner epoch at append time; legacy rows omit it. */
  epoch?: number
}
export type JournalEntry = JournalStartedEntry | JournalResultEntry

export interface JournalSnapshot {
  results: Map<string, JournalResultEntry>
  started: Map<string, JournalStartedEntry[]>
}

/**
 * Index raw journal entries into results-by-key (last write wins) and
 * started-by-key. Stale-epoch fence: once any row carried epoch N, a LATER
 * row with a SMALLER epoch was appended by an old owner that woke after a
 * takeover — it must not shadow the new owner's rows. Rows without an epoch
 * (legacy journals) always pass.
 */
export function indexJournal(entries: JournalEntry[]): JournalSnapshot {
  const results = new Map<string, JournalResultEntry>()
  const started = new Map<string, JournalStartedEntry[]>()
  let epochFloor = -1
  for (const entry of entries) {
    if (typeof entry.epoch === 'number') {
      if (entry.epoch < epochFloor) continue // a stale owner's late row
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

// Canonicalize an arbitrary value for hashing: sorted object keys, functions
// and __proto__ dropped, array length read once and bounded to safe integers.
// Shared by the opts subset and the args seed so both hash deterministically.
function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) {
    const rawLength = value.length // read ONCE — hostile VM length getters
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

/**
 * Canonical JSON of the resume-relevant subset of agent() opts. Only the keys
 * that change what a subagent IS ride the cache key; presentation opts
 * (label, phase, stallMs) do not. `effort` is omitted when unset so journals
 * written before the opt existed keep their exact keys.
 */
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

/**
 * Seed the cache chain from the workflow's `args` input. A changed input that
 * steers branching or aggregation — without touching any single agent's
 * prompt/opts — must invalidate the cached results, or a resume replays stale
 * answers to a different question. Hashed so the seed stays bounded;
 * undefined args seed '' so argless workflows keep their historical keys.
 */
export function canonicalizeArgsSeed(args: unknown): string {
  if (args === undefined) return ''
  try {
    const canonical = JSON.stringify(canonicalizeValue(args))
    return `args:${crypto.createHash('sha256').update(canonical).digest('hex')}`
  } catch {
    return ''
  }
}

/**
 * The per-call cache key: sha256 over (prior key, prompt, canonical opts),
 * NUL-separated, version-prefixed. Chaining the prior key gives
 * longest-unchanged-prefix resume semantics — editing one call invalidates
 * that call and everything after it, and nothing before it.
 */
export function agentCacheKey(prompt: string, opts: unknown, priorKey: string): string {
  const hash = crypto.createHash('sha256')
  for (const part of [priorKey, '\x00', prompt, '\x00', canonicalizeOpts(opts)]) {
    hash.update(part)
  }
  return `${JOURNAL_VERSION}:${hash.digest('hex')}`
}

/**
 * Append-only JSONL journal at <runDir>/journal.jsonl.
 *
 * Appends are SERIALIZED through an internal promise chain — two agents
 * settling in the same tick must never interleave their lines. The journal
 * also carries an honest DEGRADED state: the first failed append or skipped
 * (unparseable) line marks it and fires the injected callback once, because
 * the resume contract promises complete replay and a silently thinner journal
 * would break that promise invisibly.
 */
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
      /** The owner claim's epoch, stamped onto every appended row so a
       *  stale owner's late rows are filterable at the next load. */
      epoch?: number
    },
  ) {
    this.path = path.join(runDir, 'journal.jsonl')
    this.onDegraded = opts?.onDegraded
    this.epoch = opts?.epoch
  }
  /** The first degradation reason, or undefined while replay is complete. */
  degraded(): string | undefined {
    return this.firstDegradation
  }
  private noteDegradation(reason: string): void {
    if (this.firstDegradation !== undefined) return
    this.firstDegradation = reason
    try {
      this.onDegraded?.(reason)
    } catch {
      /* the surface must never break the journal */
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
    // Later appends run whatever happened to this one, but the FIRST failure
    // marks the journal degraded — a caller may swallow its own rejection;
    // the degraded surface fires regardless.
    this.pending = write.catch(e => {
      this.noteDegradation(
        `journal append failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    })
    return write
  }
}

// =============================================================================
// The subagent spawn stream: types + the default agent-runner adapter.
// =============================================================================

/** The spawn arguments the hooks hand to the stream. */
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
  /** Validated agent({effort}) opt — the runner maps it to reasoning effort. */
  effort?: string
  maxTurns?: number
  worktreePath?: string
  description?: string
  onQueryProgress?: (message?: unknown) => void
  /** The runner's resolved model/effort, once known (packet 63). */
  onResolvedIdentity?: (identity: { model: string; effort?: string }) => void
  /**
   * When set, the spawn CONTINUES an existing conversation instead of
   * starting fresh from `prompt`: these messages (the prior seed prompt,
   * every assistant/user message of the prior attempt, and an appended
   * corrective user message) seed the runner's prompt messages. Used by the
   * structured-output corrective re-prompts and the stall-resume path.
   */
  continuationMessages?: unknown[]
}

/**
 * One yielded subagent event, as the streaming loop reads it. Shapes mirror
 * the agent runner's yielded messages; only the fields the loop touches are
 * typed, and the union stays open for everything else.
 */
export type SubagentStreamEvent =
  | {
      type: 'attachment'
      attachment: { type: string; data?: unknown; [k: string]: unknown }
    }
  | {
      type: 'assistant'
      isApiErrorMessage?: boolean
      message: {
        content: Array<{ type: string; name?: string; input?: unknown; [k: string]: unknown }>
        usage?: { output_tokens?: number; [k: string]: unknown }
        stop_reason?: string | null
        [k: string]: unknown
      }
    }
  | { type: string; [k: string]: unknown }

export type SpawnSubagentStream = (args: SpawnSubagentArgs) => AsyncIterable<SubagentStreamEvent>

/**
 * The default spawn stream: a thin adapter over the shared agent runner.
 * Assembles the worker's tool pool independently of the parent's (the
 * worker's own permission mode, MCP tools from app state) unless the caller
 * passed a precomputed pool, resolves the query source, and forwards every
 * yielded message. The per-agent AbortController threads through the context
 * plus the agent-id override so the watchdog and the skip/retry surface can
 * abort exactly this agent.
 */
async function* adapterSpawnStream(
  args: SpawnSubagentArgs,
): AsyncGenerator<SubagentStreamEvent, void> {
  type RunAgentOpts = Parameters<typeof runAgent>[0]
  // A workflow's agent is a sub-agent: the launch-authority valve (the
  // session's sub-agents switch first) answers the one receipt — a run
  // already going finishes its running agents; a NEW launch after the
  // switch went off refuses here.
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

  // A continuation seeds the FULL prior conversation, so the worker keeps
  // its completed work and context instead of starting over.
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
    override: {
      agentId: args.agentId,
      abortController: (args.toolUseContext as { abortController?: AbortController }).abortController,
    } as RunAgentOpts['override'],
    onQueryProgress: args.onQueryProgress,
    onResolvedIdentity: args.onResolvedIdentity,
  })

  yield* stream as AsyncIterable<SubagentStreamEvent>
}

// =============================================================================
// makeWorkflowHooks — the factory.
// =============================================================================

export interface WorkflowHookDeps {
  toolUseContext: WorkflowToolContext
  canUseTool: unknown
  emitProgress: (frame: ProgressFrame) => void
  workflowRunId?: string
  /** Registration seam for per-agent controllers (the skip/retry surface). */
  onAgentController?: (agentId: string, ctrl: AbortController | null) => void
  /** Phase titles known up front — resolved first, so a seeded id equals its
   *  position in the meta.phases array. */
  seedPhaseTitles?: string[]
  budget?: TokenBudget
  journal?: WorkflowJournal
  journalSnapshot?: ExecutorJournalSnapshot | JournalSnapshot
  /** The workflow's `args` input — seeds the resume cache chain. */
  args?: unknown

  // ── injection seams ─────────────────────────────────────────────────────
  /** Subagent stream. Default: the agent-runner adapter above. */
  spawnSubagentStream?: SpawnSubagentStream
  /**
   * Build the structured-output tool from a JSON schema. Default: the
   * schema-bound validated builder, with a non-object schema surfaced as a
   * builder error rather than a compile throw. Returns `{ tool }` for a
   * valid schema or `{ error }` for an invalid one.
   */
  getStructuredOutputTool?: (schema: unknown) =>
    | { tool: unknown; error?: undefined }
    | { error: string; tool?: undefined }
  /**
   * Resolve a custom agentType to its definition. Default: a lookup over the
   * session's active agent registry.
   */
  resolveCustomAgentType?: (type: string, hasSchema: boolean) => unknown
  /** Accepted for callers that pass it; not read by this implementation. */
  runDir?: string
}

/**
 * Build the hooks object the executor's contract requires, plus the
 * resolvePhase/recordFailure extras the child-workflow callable reads.
 */
export function makeWorkflowHooks(deps: WorkflowHookDeps): WorkflowHooks {
  const ctx = deps.toolUseContext
  const contextView = ctx as unknown as HookContextView
  const canUseTool = deps.canUseTool
  const emit = deps.emitProgress
  const runId = deps.workflowRunId
  const onAgentController = deps.onAgentController
  const budget = deps.budget
  const journal = deps.journal

  // ── injection seams, with their defaults ────────────────────────────────
  const spawnStream: SpawnSubagentStream =
    deps.spawnSubagentStream ?? adapterSpawnStream
  // The default builder compiles an OBJECT schema; anything else must come
  // back as a builder error here rather than a throw inside the compile.
  const buildStructuredTool: NonNullable<WorkflowHookDeps['getStructuredOutputTool']> =
    deps.getStructuredOutputTool ??
    ((schema: unknown) =>
      typeof schema === 'object' && schema !== null
        ? getSchemaBoundStructuredOutputTool(schema)
        : { error: 'agent({schema}) requires a JSON Schema object' })
  const resolveCustomAgentType =
    deps.resolveCustomAgentType ?? resolveFromSessionRegistry

  // ── run-wide state ──────────────────────────────────────────────────────
  // One FIFO counting gate of the factory-time width holds around each
  // individual spawn; parallel()/pipeline() fan out unbounded through the VM.
  const lane = makeGate(computeConcurrencyCap(availableCores()))
  let admitted = 0 // agent() calls admitted past the gates; 1-based indices
  const failures: string[] = []

  // Realm bridges — host-side stand-ins until bindVMAwait swaps in the
  // functions compiled inside the VM context.
  let settle: (v: unknown) => Promise<{ v: unknown }> = async v => ({ v: await v })
  let call: (fn: unknown, ...a: unknown[]) => unknown = (fn, ...a) =>
    (fn as (...a: unknown[]) => unknown)(...a)
  let clone: (v: unknown) => unknown = v => cloneFromVM(v)

  // Resume-cache chain. The tip is seeded from the workflow's own args so a
  // changed input misses every cached step; undefined args seed '' and keep
  // argless workflows on their historical keys.
  let cacheChainTip = canonicalizeArgsSeed(deps.args)
  let replayWindowClosed = false // latched at the first miss; later calls run live
  // The executor's snapshot stores raw results and ours stores full entries —
  // one loosely-typed view reads both.
  const replayResults = (deps.journalSnapshot?.results ?? new Map()) as Map<string, unknown>

  // ── admission gates ─────────────────────────────────────────────────────
  function assertUnderAgentCap(): void {
    if (admitted >= AGENT_LIFETIME_CAP) throw new WorkflowAgentCapError()
  }
  function assertBudgetRemains(): void {
    if (budget?.total == null || budget.total <= 0) return
    const spent = budget.getTurnSpent()
    if (spent >= budget.total) throw new WorkflowBudgetExceededError(spent, budget.total)
  }

  // ── phase bookkeeping ───────────────────────────────────────────────────
  // Ids are 0-based and allocated on first sight of a title. Seeded titles
  // resolve FIRST, so a seeded id equals its meta.phases array position —
  // the join key the UI projectors and the run manifest rely on.
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

  // ── log ─────────────────────────────────────────────────────────────────
  const log = errorTunnel((msg: unknown) => {
    emit({
      type: 'progress',
      toolUseID: 'workflow_log',
      data: { type: 'workflow_log', message: String(msg) },
    })
  })

  // Default custom-agentType resolver: the session's active agent registry.
  function resolveFromSessionRegistry(type: string, hasSchema: boolean): unknown {
    const registry = contextView.options?.agentDefinitions?.activeAgents ?? []
    const found = registry.find(a => a.agentType === type)
    if (!found) {
      throw new Error(
        `Agent type '${type}' not found. Available agents: ${registry.map(a => a.agentType).join(', ')}`,
      )
    }
    // The return-value contract is grafted onto the custom prompt, and the
    // model is FORCED to 'inherit': a definition-pinned small tier must not
    // override the session model for workflow work — scope restrictions
    // belong in the prompt, not in a downgraded engine.
    const ownPrompt =
      typeof found.getSystemPrompt === 'function' ? found.getSystemPrompt() : ''
    const contractSuffix = hasSchema ? SCHEMA_APPEND : TEXT_APPEND
    return {
      ...found,
      model: 'inherit',
      getSystemPrompt: () => `${ownPrompt}${contractSuffix}`,
    }
  }

  // The schema-bound worker pool: the same base pool the adapter would
  // assemble, minus any tool already wearing the structured-output name, plus
  // the bound tool — so the worker can actually call it.
  function spliceStructuredTool(structuredTool: unknown, agentDef: unknown): unknown {
    const def = agentDef as { permissionMode?: string }
    const appState = contextView.getAppState()
    const basePool = assembleToolPool(
      { ...appState.toolPermissionContext, mode: def?.permissionMode ?? 'implement' } as Parameters<typeof assembleToolPool>[0],
      appState.mcp.tools as ToolPool,
    ) as unknown as Array<{ name?: string }>
    return [...basePool.filter(t => t?.name !== STRUCTURED_OUTPUT_TOOL_NAME), structuredTool]
  }

  // Stall-resume safety: the longest transcript prefix in which every
  // assistant tool_use id has its matching tool_result. An unpaired trailing
  // tool_use is truncated — resuming it would fail on the wire and risk
  // re-running a side effect — and a prefix with no assistant content
  // resumes nothing (null → fresh restart).
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

  // One stable host-side clone per distinct VM schema object: the cache key
  // and the tool builder must see the SAME shape across calls sharing a
  // schema.
  const stableSchemaByRaw = new WeakMap<object, unknown>()

  // agent() return contract: resolves to the subagent's result — a string on
  // the text path (empty output is '', NOT null) or the schema-validated
  // object. Null arrives in exactly TWO cases the bare value does not
  // distinguish: (1) the agent was skipped mid-run, and (2) it died on a
  // terminal API error after retries — case (2) is also recorded in
  // failures[] (the run-summary disambiguator). A stall/abandon THROWS, and
  // the schema path throws on no output, so neither reaches the caller as
  // null. Note that .filter(Boolean) over a fan-out drops null (skipped +
  // API-errored) AND '' (empty text) alike.
  const agent = errorTunnel(
    async (promptIn: unknown, optsIn?: unknown): Promise<unknown> => {
      // Normalization. The RAW schema identity is read off the VM value
      // first (guarded — a hostile getter must not escape; only non-null
      // objects count), the opts bag is deep-cloned host-side, and the
      // clone's schema member is swapped for the cached host-stable clone.
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

      // Once the run is aborted, never resolve — the run-level abort race
      // settles the script; resolving here would let it keep executing.
      if (ctx.abortController?.signal.aborted) return new Promise(() => {})

      // Loud validation, ahead of the cache key and the journal.
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
      // The tier is validated ALWAYS — a typo fails fast whether or not
      // routing is armed. A routed model is written into opts.model BEFORE
      // the cache key is computed, so a routing flip between runs is
      // honestly a cache miss; routing off leaves opts untouched, keeping
      // keys and frames byte-identical.
      validateWorkflowTier(opts?.tier)
      if (opts) {
        const routed = resolveWorkflowRoutedModel(opts)
        if (routed !== undefined) opts.model = routed
      }
      // The engine grammar is ONE law across chairs (lane CF): the same
      // model string must mean the same dispatch in the Agent tool and in
      // a workflow script. Class aliases ('gpt' · 'glm' · 'kimi' ·
      // 'deepseek' · 'gemini' · 'openrouter' · 'compat' · 'huggingface' ·
      // 'local') resolve to their exact catalogue ids and exact engine ids
      // validate — BEFORE the cache key, so a resolution change is
      // honestly a cache miss. A string the grammar refuses throws here
      // (the prompt's documented "fails the dispatch") instead of riding
      // to the wire as an invalid id; Anthropic-grammar strings pass
      // through untouched.
      if (opts?.model !== undefined && opts.model !== null) {
        const engine = await resolveEngineDispatch(String(opts.model))
        if (engine) opts.model = engine.model
      }

      // Admission. Either throw surfaces after one yielded tick so the
      // cap/budget error lands deterministically.
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

      // ── resume replay ─────────────────────────────────────────────────────
      let cacheKey: string | undefined
      if (journal) {
        cacheKey = agentCacheKey(prompt, opts, cacheChainTip)
        cacheChainTip = cacheKey // the chain advances on hit AND miss
        const hit = replayWindowClosed ? undefined : replayResults.get(cacheKey)
        if (hit !== undefined) {
          const entry = hit as JournalResultEntry
          // Replay PROVENANCE: the key omits absent opts, so a run that
          // never named a model still hits after the session default
          // changed — the replayed row must show what actually RAN. An
          // explicit opts.model rode the key and is faithful by itself;
          // otherwise the per-agent launch metadata (joined on the row's
          // agentId) holds the resolved model/effort, and absent metadata
          // reads 'provenance unknown' — never a rebuilt current default.
          let recordedModel: string | undefined
          let recordedEffort: string | undefined
          if (opts?.model == null && entry.agentId) {
            try {
              const meta = await readAgentMetadata(entry.agentId as never)
              recordedModel = meta?.model
              recordedEffort = meta?.effort ?? meta?.effortOverride
            } catch {
              /* unreadable metadata = unknown provenance */
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
              // effort rides EVERY frame: the batch reducer replaces rows
              // whole, so a frame that omitted it would erase a recorded
              // value a live run had written.
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
        replayWindowClosed = true // first miss: everything after runs live
      }

      // Journal receipts. A null result (skip / API failure) is deliberately
      // never recorded — it must re-run on resume, not replay.
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
          // 'remote' was rejected above, so the only isolation that can
          // reach a frame is 'worktree'.
          isolation: opts?.isolation === 'worktree' ? 'worktree' : undefined,
          state: 'start',
          lastProgressAt: queuedAt,
        }),
      )

      try {
        return await recordResult(
          await lane.run(() =>
            runAgentCall({
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
          ),
        )
      } catch (e) {
        // A pre-spawn throw (cap, budget, bad schema, unknown agentType)
        // settles the queued tile; once an attempt started, its own
        // per-attempt tiles own the story.
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

  // ── one agent() call: definition resolution, worktree, retry ladders ─────
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
    // The wait in the queue may have spent the budget — re-check.
    assertBudgetRemains()

    // Custom agentType — resolved against the same registry the Agent tool
    // uses; an unknown type throws before anything spawns.
    let customDef: unknown
    if (opts?.agentType != null) {
      customDef = resolveCustomAgentType(String(opts.agentType), Boolean(opts.schema))
    }

    // Schema → the bound structured-output tool; an invalid schema is the
    // caller's bug and throws.
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

    // Worktree isolation. The slug shape wf_<runId>-<idx> is what the stale
    // worktree sweeper recognizes — leaked trees get cleaned up because the
    // name matches.
    let worktree: WorktreeHandle | null = null
    if (opts?.isolation === 'worktree') {
      worktree = await createAgentWorktree(runId ? `wf_${runId}-${index}` : `wf-${index}`)
    }
    const worktreePath = worktree?.worktreePath
    const effectivePrompt = worktree
      ? `${prompt}\n\n---\nYou are running in an isolated git worktree at ${worktree.worktreePath} (a separate working copy of the repo). Changes you make here do NOT affect the main working directory or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.`
      : prompt

    // Totals carried across retries live in ONE mutable cell the frame
    // emitter reads live at emit time; the throttle rescue and the stall
    // ladder fold a finished attempt in before re-attempting. The
    // structured-output nudges deliberately do not fold.
    const carryover = { tokens: 0, toolCalls: 0, durationMs: 0 }
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

    // ── one attempt: spawn → stream → settle ──────────────────────────────
    const runAttempt = async (
      attemptLabel: string,
      attemptNo: number,
      reason?: string,
      continuation?: unknown[],
    ): Promise<AttemptReport> => {
      const agentId = createAgentId()
      onAttemptStarted(agentId)

      // The child controller chains to the run signal; the watchdog and the
      // task layer's skip/retry abort exactly this agent.
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
      // Per-attempt frame identity: each attempt keys its own live tile.
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

      // ── stall watchdog + declared-recovery machinery ────────────────────
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      let awaitingFirstToken = false
      let prefillGraceUsed = false
      let sawAssistant = false
      let recoveryWaitedMs = 0
      let recoveryHeartbeat: ReturnType<typeof setInterval> | undefined
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
        // One-shot first-token grace: a request still awaiting its first
        // token that has produced nothing gets a single re-arm — a bounded
        // first-token tolerance of 2×stallMs, surfaced on the frame.
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
      // Extend the budget across a DECLARED provider recovery: the declared
      // wait (capped) plus a fresh stallMs for the recovered request's own
      // first token. Arm, never disarm — a client dying mid-recovery must
      // still be killable.
      const armStallTimerForRecovery = (declaredMs: number): void => {
        clearStallTimer()
        if (stallMs > 0) {
          stallTimer = setTimeout(
            onStallExpiry,
            Math.min(declaredMs, RECOVERY_WAIT_CAP_MS) + stallMs,
          )
        }
      }

      // Token generation within a long single turn (no tool calls) must keep
      // the watchdog from firing: the runner reports progress per streamed
      // message, and re-arms are throttled so the bump stays cheap.
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
        // The recovery branch runs FIRST — the throttle drop below must
        // never swallow the one event that extends the budget. A declared
        // window is EITHER a real retry delay (retryInMs) OR a blocking
        // recovery call's ceiling (recoveryTimeoutMs); the two fields are
        // distinct and both must be read.
        if (m?.type === 'system' && m.subtype === 'api_error') {
          const isRealDelay = typeof m.retryInMs === 'number' && m.retryInMs > 0
          const declared = isRealDelay
            ? (m.retryInMs as number)
            : typeof m.recoveryTimeoutMs === 'number' && m.recoveryTimeoutMs > 0
              ? m.recoveryTimeoutMs
              : 0
          if (declared > 0) {
            recoveryWaitedMs += Math.min(declared, RECOVERY_WAIT_CAP_MS)
            if (recoveryWaitedMs > RECOVERY_TOTAL_CAP_MS) {
              // A held concurrency slot cannot wait forever.
              clearHeartbeat()
              childAbort.abort('throttled')
              return
            }
            armStallTimerForRecovery(declared)
            // A real scheduled delay rides retryInMs; a blocking call's
            // ceiling rides recoveryTimeoutMs — so no pane renders a fake
            // countdown.
            const window = isRealDelay
              ? { retryInMs: declared }
              : { recoveryTimeoutMs: declared }
            emitFrame('progress', {
              waiting: 'provider-backoff',
              ...window,
              retryAttempt: typeof m.retryAttempt === 'number' ? m.retryAttempt : undefined,
            })
            clearHeartbeat()
            recoveryHeartbeat = setInterval(() => {
              emitFrame('progress', { waiting: 'provider-backoff', ...window })
            }, RECOVERY_HEARTBEAT_MS)
            return
          }
        }
        // Prefill latch: request dispatched, first token still pending.
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
      // Deterministic-400 latch. The inner query machinery retries API
      // errors with backoff and each internal retry reports progress —
      // re-arming the watchdog — so a hopeless rejection would otherwise
      // spin until the watchdog fired, classify as 'stalled', and send the
      // OUTER ladder back into the same wall attempt after attempt. On
      // sighting the class in the stream the attempt aborts NOW and settles
      // as a terminal apiError, which the ladder never retries.
      let terminal400: string | undefined
      // The running conversation: the seed (fresh prompt OR the continuation
      // this attempt extends) plus every assistant/user message the worker
      // yields. A clean end returns it, so a corrective re-prompt can
      // CONTINUE this exact conversation.
      const conversation: unknown[] = continuation
        ? [...continuation]
        : [createUserMessage({ content: effectivePrompt })]

      // Schema-bound calls carry a worker pool with the structured-output
      // tool spliced in; without a schema the adapter assembles the default.
      const availableTools = structuredTool
        ? spliceStructuredTool(structuredTool, agentDef)
        : undefined

      const carry = statics.carryover
      const settledTotals = (elapsed: number): Record<string, unknown> => ({
        tokens: carry.tokens + tokens,
        toolCalls: carry.toolCalls + toolCalls,
        durationMs: carry.durationMs + elapsed,
      })
      // Delivered output beats a post-delivery failure: a schema-bound
      // worker that already called the structured-output tool has DELIVERED,
      // and context overflow arrives precisely late in long runs — exactly
      // when the output exists. Settle as done.
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
      // Terminal apiError settle: stallCut:false keeps the ladder's stall
      // and throttle retries permanently away from this class.
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
          model: opts?.model != null ? String(opts.model) : undefined,
          effort: opts?.effort != null ? String(opts.effort) : undefined,
          worktreePath,
          description: attemptPromptPreview,
          continuationMessages: continuation,
          onQueryProgress,
          // The badge binds to what the runner RESOLVED, not to what the
          // script declared: a definition-pinned model or the session's
          // effort repaints the tile the moment the run knows them.
          onResolvedIdentity: identity => {
            const changed = identity.model !== statics.model || identity.effort !== statics.effort
            statics.model = identity.model
            statics.effort = identity.effort
            if (changed) emitFrame('progress')
          },
        })) {
          if (ev.type === 'attachment') {
            const att = (ev as Extract<SubagentStreamEvent, { type: 'attachment' }>).attachment
            // Every attachment is consumed; structured_output stores its
            // data, last write wins.
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
            // Assignment, not accumulation — the runner reports cumulative
            // usage.
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
            // A pending tool result will restart progress — park the
            // watchdog entirely rather than racing the tool's own runtime.
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
          // Declared provider recovery exceeded the per-attempt total cap: a
          // THROTTLED settle with apiError semantics — never the stall
          // ladder, never a re-bill of the full context.
          const message = `provider throttled — declared recovery waits exceeded ${Math.round(RECOVERY_TOTAL_CAP_MS / 60000)}m for this attempt`
          return structured !== undefined
            ? deliveredSettle(elapsed)
            : apiErrorSettle(elapsed, message)
        }
        if (cutReason === 'stalled' || cutReason === 'user-retry') {
          // A stalled worker that already delivered structured output is
          // done.
          if (cutReason === 'stalled' && structured !== undefined) {
            return deliveredSettle(elapsed)
          }
          // Watchdog race: abort() on an already-aborted controller is a
          // no-op, so 'stalled' may have latched in the gap before the 400
          // event was pulled from the stream. With the latch set,
          // classifying this as a stall would send the ladder back into the
          // same wall up to the full retry count.
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
          // An operator skip is a deliberate settle, not a fault — the
          // frame's state says so, so no pane paints it with the error tone.
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
        // The runner throws AbortError on a parent abort — surfaced
        // uniformly as a workflow abort.
        emitFrame('error', {
          error: e instanceof Error ? e.message : String(e),
          ...settledTotals(elapsed),
        })
        if (e instanceof AbortError) throw new Error('Workflow aborted')
        throw e
      } finally {
        clearStallTimer()
        clearHeartbeat()
        parentSignal?.removeEventListener('abort', onParentAbort)
        onAgentController?.(agentId, null)
      }

      const elapsed = Date.now() - startedAt
      const finalText = lastAssistant
        ? extractTextContent(lastAssistant.message.content, '\n')
        : ''
      const finalOutputTokens = lastAssistant?.message.usage?.output_tokens
      if (lastAssistant?.isApiErrorMessage) {
        // Same delivered-output-wins guard as the abort paths.
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
      // The terminal done frame — what lifts a live successful tile out of
      // its start state.
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
    ): Promise<AttemptReport> =>
      worktreePath
        ? Promise.resolve(
            runWithCwdOverride(worktreePath, () =>
              runAttempt(attemptLabel, attemptNo, reason, continuation),
            ),
          )
        : runAttempt(attemptLabel, attemptNo, reason, continuation)

    try {
      let report = await attempt(label, 1)

      // THROTTLE rescue: the degraded-response shape (no stop reason, tiny
      // usage, long wall clock) worth one 45s-backoff re-run. Two apiError
      // classes are excluded on purpose: deterministic 400s (they settle via
      // the natural stream end with exactly this shape, and a re-run
      // re-bills the full prompt into the same wall) and the recovery-cap
      // throttled settle. Transient API errors that exhausted the inner
      // backoff KEEP the rescue — a retry can genuinely help there.
      const looksThrottled = (r: AttemptReport): boolean =>
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

      // STALL ladder — up to MAX_STALL_RETRIES further attempts while the
      // outcome is stall-cut; a taken throttle rescue disables it entirely.
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
        // Only a watchdog cut resumes the cut conversation; a user retry
        // (or an unbalanceable transcript) restarts fresh from the prompt.
        // The frame's lastAttemptReason carries `why` — the same operator
        // prose the log speaks — so the attempt chip explains itself
        // ('retry requested by user'), never a raw kind token.
        const resumable = cutKind === 'stalled' ? balancedTranscriptPrefix(report.transcript) : null
        report = resumable
          ? await attempt(`${label} (retry ${a})`, a + 1, why, [
              ...resumable,
              createUserMessage({ content: STALL_RESUME_PROMPT }),
            ])
          : await attempt(`${label} (retry ${a})`, a + 1, why)
      }

      // ── terminal settle of the call ─────────────────────────────────────
      if (report.skipped) return null // a skip is deliberate; no failure recorded
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
        // A terminal subagent API error resolves null, NOT a throw: the
        // failure is recorded for the run summary, and the script keeps its
        // fan-out shape. Null here is intentionally the same value a skip
        // returns — the failures list is the disambiguator.
        const msg = `[${label}] failed: ${report.apiError}`
        failures.push(msg)
        log(msg)
        return null
      }
      if (structuredTool) {
        // A clean stop without the structured-output call gets bounded
        // corrective re-prompts APPENDED to the same conversation — the
        // completed work is never re-run — and the terminal error reports
        // how many corrections were actually tried.
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
          // A correction settles through the same terminal semantics as a
          // first attempt.
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
      // Worktree settlement: ephemeral debris never blocks; a preserved tree
      // is NAMED in the workflow log instead of silently left behind.
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
            // A lane left behind is NAMED: the janitor reaps it later, but
            // the run log must never read as if the checkout settled.
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

  // Shared slot mapping for the two fan-out combinators: fulfilled slots
  // unwrap; a budget-named rejection drops to null and is tallied; any other
  // rejection drops to null with the failure recorded AND logged.
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

  // ── parallel ────────────────────────────────────────────────────────────
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
    // Barrier fan-out; never rejects — every slot settles.
    const outcomes = await Promise.allSettled(thunks.map(t => settle(call(t))))
    return clone(collectSlots(outcomes, 'parallel')) as unknown[]
  })

  // ── pipeline ────────────────────────────────────────────────────────────
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
      // Per item, concurrently — no barrier between stages.
      const outcomes = await Promise.allSettled(
        items.map(async (item, index) => {
          let acc = await settle(item)
          for (const stage of stages) {
            if (acc.v === null) break // a dropped item skips its later stages
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

// ── attempt result + per-call frame statics ─────────────────────────────────
interface AttemptReport {
  /** Structured payload actually delivered; undefined when none. */
  structured: unknown
  /** Final assistant text — '' when the attempt produced none. */
  text: string
  /** Terminal API error text; presence settles the call as a recorded
   *  failure rather than a retry. */
  apiError?: string
  /** Token / tool-call / wall-clock totals of THIS attempt only — carried
   *  totals live in the call's carryover cell. */
  tokens: number
  toolCalls: number
  durationMs: number
  /** The watchdog or a user retry cut this attempt; stallKind says which. */
  stallCut: boolean
  stallKind?: 'stalled' | 'user-retry'
  /** The operator skipped it — a deliberate settle, not a fault. */
  skipped: boolean
  /** Last assistant stop reason (null when absent) and its output_tokens;
   *  the throttle detector reads both. */
  stopReason?: string | null
  outputTokens?: number
  /** Structured-output tool calls observed, and the last such input —
   *  schema-shape diagnostics for the stall log. */
  schemaCallCount: number
  lastSchemaCallInput: unknown
  /**
   * The conversation (seed + every yielded assistant/user message) a
   * corrective re-prompt or stall resume can CONTINUE. Only cleanly-ended
   * and stall-cut attempts carry it; skip/terminal-abort settles never feed
   * a re-prompt.
   */
  transcript?: unknown[]
}

// Static per-agent-call fields the per-attempt frames carry, plus the mutable
// carried-totals cell read live at emit time.
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

// Best-effort one-line glance at a tool_use input for the frame's
// lastToolSummary: the first string-ish well-known field, else trimmed JSON.
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

// ── concurrency gate: a counter + FIFO queue semaphore ──────────────────────
interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>
}
function makeGate(max: number): Gate {
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<void> => {
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>(resolve => waiting.push(resolve))
  }
  const release = (): void => {
    active--
    const next = waiting.shift()
    if (next) {
      active++
      next()
    }
  }
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}

// Split a rejection reason into {name, msg}, reading both defensively — the
// reason may be a hostile VM value whose getters throw.
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

// Preview a value (string or JSON) trimmed to the frame preview budget.
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

// ── local structural views ───────────────────────────────────────────────────
interface WorktreeHandle {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}
// The slice of the tool-use context this module reads directly. The executor
// passes a full context as WorkflowToolContext; only these fields are touched.
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
