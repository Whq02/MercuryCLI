// =============================================================================
// The Workflow tool.
//
// Takes a workflow as an inline `script`, a registered `name`, or a
// `scriptPath`; checks, permission-gates, and compiles it; makes the launch
// durable; registers a `local_workflow` background task; drives the script
// through the run engine with production dependencies wired in; and answers
// IMMEDIATELY with `status: 'async_launched'`. The main loop learns of
// settlement through a <task-notification>; /workflows renders progress in
// the meantime.
//
// Production wiring happens HERE and nowhere else — the engine's dependency
// slots receive:
//   • makeHooks   → makeWorkflowHooks (host DSL + real subagent dispatch)
//   • journal     → LocalFileJournal under the run dir (replay cache)
//   • resolvers   → the workflow name registry
//   • getCwd      → the harness working-directory accessor
//   • ledger /    → capability hosts, wired only while their gates are on
//     themis        (gate off ⇒ the script global simply does not exist)
//
// There is no standalone task registry: rows live in AppState behind
// setAppState, the LocalWorkflowTask helpers own every status transition, and
// this file merely clears out settled rows before a resume re-registers.
//
// On-disk shape of a run (all under its run dir): workflow.js — the launched
// source, byte-for-byte; args.json — the launch arguments; run.json — the
// manifest, whose mtime is also the alive-signal; claim.json — ownership as
// {random instance id, incrementing epoch}; journal.jsonl — replay rows, each
// stamped with the owner epoch. A launch either lands whole or unwinds whole.
// =============================================================================

import type { ToolResultBlockParam } from '../../types/wire.js'
import crypto from 'node:crypto'
import { daedalusResolveModels } from './bundled/daedalus.js'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod/v4'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import {
  completeWorkflowTask,
  enqueueWorkflowNotification,
  failWorkflowTask,
  registerWorkflowTask,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
  type WorkflowPhase,
  type WorkflowProgressEvent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  getCurrentTurnTokenBudget,
  getSessionId,
  getTurnOutputTokens,
} from '../../bootstrap/state.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import {
  defaultEvolutionLedgerDir,
  evolutionLedgerEnabled,
  makeWorkflowLedgerHost,
} from '../../utils/evolution/evolutionLedger.js'
import { getWorkflowTranscriptDir } from '../../utils/sessionStorage.js'
import { themisLevel } from '../../substrate/themis/level.js'
import { makeThemisWorkflowHost } from '../../substrate/themis/workflowHost.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { makeWorkflowCanUseTool } from './workflowPermissionChannel.js'
import {
  renderWorkflowResultMessage,
  renderWorkflowToolUseMessage,
  type WorkflowResultContent,
} from './workflowToolRenderers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'

import {
  compileWorkflow,
  MAX_SCRIPT_BYTES,
  parseWorkflowScript,
  scriptUsesNonDeterminism,
  type ParsedWorkflow,
} from './compiler.js'
import { LocalFileJournal, makeWorkflowHooks } from './agentHooks.js'
import {
  deriveWorkflowTerminalStatus,
  runWorkflowScript,
  type ProgressFrame,
  type WorkflowToolContext,
} from './executor.js'

import { WORKFLOW_TOOL_NAME } from './workflowConstants.js'
import {
  dynamicWorkflowsEnabled,
  workflowsManagedDisabled,
} from './workflowEnablement.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { getWorkflowToolPrompt } from './workflowPrompt.js'
import { listWorkflows, resolveWorkflowName } from './registry.js'
import {
  RUN_MANIFEST_HEARTBEAT_MS,
  RUN_MANIFEST_VERSION,
  RUN_MANIFEST_WRITE_THROTTLE_MS,
  buildAgentSummaries,
  claimRun,
  createManifestWriteChain,
  embedArgs,
  logsTail,
  readRunClaim,
  readRunManifest,
  recordedOwnerAlive,
  type WorkflowRunManifest,
  workflowRunsRoot,
  writeRunManifest,
} from './runManifest.js'

// The stop tool named in the resume-conflict message and the schema text.
// Spelled inline so the describe() strings need no cross-module import.
const TASK_STOP_TOOL_NAME = 'TaskStop'

// Progress frames coalesce for this long before flushing into task state.
const PROGRESS_FLUSH_MS = 16

/** Thrown out of call()/validateInput() for inputs that cannot launch. */
export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowInputError'
  }
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type WorkflowInput = {
  script?: string
  name?: string
  description?: string
  title?: string
  args?: unknown
  scriptPath?: string
  resumeFromRunId?: string
  /** Tolerated no-op — every workflow already runs in the background. */
  run_in_background?: boolean
}

// In-process launch is the only shape a call can produce.
type WorkflowResultData = {
  status: 'async_launched'
  taskId: string
  taskType?: 'local_workflow'
  workflowName?: string
  runId?: string
  summary?: string
  transcriptDir?: string
  scriptPath?: string
  warning?: string
  error?: string
}

type ScriptSource =
  | { script: string; source?: string; resolvedScriptPath?: string }
  | { error: string }

// Returned whenever the dispatch was already aborted server-side: the input
// may be truncated, so nothing about it can be trusted.
const DISPATCH_RETRACTED = {
  result: false as const,
  message:
    'Tool dispatch was retracted by a server fallback; the input may be truncated.',
  errorCode: 7,
}

// -----------------------------------------------------------------------------
// Script-source resolution. Precedence: scriptPath beats name beats inline.
// -----------------------------------------------------------------------------
async function resolveScriptSource(input: WorkflowInput): Promise<ScriptSource> {
  if (input.scriptPath) {
    if (input.script) {
      // scriptPath + inline script together mean "persist THIS text at that
      // path": fresh text always beats the possibly-stale file on disk.
      return {
        script: input.script,
        resolvedScriptPath: path.resolve(getCwd(), input.scriptPath),
      }
    }
    const fromDisk = await readScriptFromDisk(input.scriptPath)
    if ('error' in fromDisk) return fromDisk
    return { script: fromDisk.script, resolvedScriptPath: fromDisk.path }
  }
  if (input.name) {
    const found = await resolveWorkflowName(input.name, getCwd())
    if (found) {
      // An inline script overrides the stored body even for a named workflow.
      return { script: input.script ?? found.script, source: found.source }
    }
    const available = (await listWorkflows(getCwd())).map(w => w.name).join(', ')
    return {
      error: `Workflow "${input.name}" not found. Available: ${available || '(none)'}`,
    }
  }
  if (input.script) return { script: input.script }
  return { error: 'Must provide script, name, or scriptPath' }
}

/** Load script text from a path, anchored at the harness working directory. */
async function readScriptFromDisk(
  scriptPath: string,
): Promise<{ script: string; path: string } | { error: string }> {
  const resolved = path.resolve(getCwd(), scriptPath)
  try {
    const { readFile } = await import('node:fs/promises')
    const script = await readFile(resolved, 'utf8')
    return { script, path: resolved }
  } catch (e) {
    return {
      error: `Could not read workflow script at ${resolved}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
}

/** True for the parse/compile failure union ({ ok:false, error }). */
function isParseFailure(
  x: ParsedWorkflow | { ok: false; error: string } | undefined,
): x is { ok: false; error: string } {
  return !!x && (x as { ok?: boolean }).ok === false
}

// -----------------------------------------------------------------------------
// Schemas. The describe() text is model-facing contract.
// -----------------------------------------------------------------------------
export const inputSchema = lazySchema(() =>
  z
    .strictObject({
      script: z
        .string()
        .max(MAX_SCRIPT_BYTES)
        .optional()
        .describe(
          'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` ' +
            '(pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Name of a predefined workflow (built-in or from the project workflows directory). Resolves to a self-contained script.',
        ),
      description: z
        .string()
        .optional()
        .describe(
          "Ignored — set the workflow description in the script's `meta` block.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "Ignored — set the workflow title in the script's `meta` block.",
        ),
      args: z
        .unknown()
        .optional()
        .describe(
          'Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual ' +
            'JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the ' +
            'script. Use for parameterized named workflows (e.g. a research question).',
        ),
      scriptPath: z
        .string()
        .optional()
        .describe(
          'Path to a workflow script file on disk. Every Workflow invocation persists its script under the session ' +
            'directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and ' +
            're-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence ' +
            'over `script` and `name`.',
        ),
      resumeFromRunId: z
        .string()
        .regex(/^wf_[a-z0-9-]{6,}$/)
        .optional()
        .describe(
          `Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged ` +
            `(prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session ` +
            `only. Stop the prior run first (${TASK_STOP_TOOL_NAME}) before resuming.`,
        ),
      // Tolerated no-op. Models copy the shell tool's backgrounding habit and
      // send this key; with a strict object schema that stray key would sink
      // an otherwise-valid call. semanticBoolean also absorbs the quoted
      // "true"/"false" variants of the same habit.
      run_in_background: semanticBoolean(z.boolean().optional()).describe(
        'Ignored — workflows always run in the background; the tool returns immediately with a task ID.',
      ),
    })
    .refine(h => h.script || h.name || h.scriptPath, {
      message: 'Must provide script, name, or scriptPath',
    }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    status: z.literal('async_launched'),
    taskId: z.string(),
    taskType: z
      .literal('local_workflow')
      .optional()
      .describe('TaskType of the registered background task (in-process run).'),
    workflowName: z
      .string()
      .optional()
      .describe('meta.name from the workflow script.'),
    runId: z
      .string()
      .optional()
      .describe('Local workflow run identifier for resumeFromRunId.'),
    summary: z.string().optional(),
    transcriptDir: z
      .string()
      .optional()
      .describe(
        'Directory where subagent transcripts are written during execution',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe('Path to the persisted workflow script for this invocation.'),
    warning: z.string().optional().describe('Non-blocking heads-up.'),
    error: z.string().optional().describe('Set if syntax check failed'),
  }),
)

// -----------------------------------------------------------------------------
// Run-dir layout + atomic launch persistence.
// -----------------------------------------------------------------------------

/** The per-run directory: journal, persisted script, manifest, and subagent
 *  transcripts co-locate under <project workflows dir>/runs/<runId>. */
function runDirectoryFor(runId: string): string {
  return path.join(workflowRunsRoot(getCwd()), runId)
}

/**
 * Write the launch state to disk — awaited before the tool answers. Three
 * pieces: the run dir itself; workflow.js, written unconditionally even when
 * the source came from a file (recovery must survive the source file being
 * edited or deleted later); and args.json carrying the launch arguments
 * byte-exactly (the manifest only inlines small ones, and a replay with
 * approximate args would poison the cache). Failures propagate with their
 * cause so the caller can roll everything back.
 */
async function persistLaunchState(
  runDir: string,
  script: string,
  args: unknown,
): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.js'), script, 'utf8')
  if (args !== undefined) {
    await writeFile(path.join(runDir, 'args.json'), JSON.stringify(args), 'utf8')
  }
}

/** realpath with a resolve() fallback, so origin comparisons survive
 *  symlinked spellings of the same directory. */
function realCanonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Project a live task status into the manifest union: only the terminal
 *  members pass through; anything pre-terminal (or unknown) reads 'running' —
 *  the board's orphan detection covers crashed-while-running. */
function projectManifestStatus(
  liveStatus: LocalWorkflowTaskState['status'] | undefined,
): WorkflowRunManifest['status'] {
  return liveStatus === 'completed' ||
    liveStatus === 'failed' ||
    liveStatus === 'killed' ||
    liveStatus === 'paused'
    ? liveStatus
    : 'running'
}

/**
 * Coalesce progress events and flush them on a fixed cadence. push() arms the
 * timer; drain() cancels it and flushes whatever is queued (safe when empty).
 * afterFlush runs after every non-empty flush — the manifest re-stamp rides
 * it, throttled by its own clock.
 */
function createProgressBatcher(opts: {
  apply: (events: WorkflowProgressEvent[]) => void
  afterFlush: () => void
}): { push: (event: WorkflowProgressEvent) => void; drain: () => void } {
  let pending: WorkflowProgressEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    flushTimer = undefined
    if (pending.length === 0) return
    const batch = pending
    pending = []
    opts.apply(batch)
    opts.afterFlush()
  }
  return {
    push(event) {
      pending.push(event)
      if (flushTimer === undefined) {
        flushTimer = setTimeout(flush, PROGRESS_FLUSH_MS)
      }
    },
    drain() {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flush()
    },
  }
}

// =============================================================================
// The tool definition itself.
// =============================================================================
const WorkflowToolDef = {
  name: WORKFLOW_TOOL_NAME,
  aliases: ['RunWorkflow'],
  searchHint: 'orchestrate subagents with deterministic JavaScript workflow',
  // The compiled contract below is the largest tool description in the
  // catalogue (~23KB) and is deliberate-orchestration vocabulary, not turn-1
  // vocabulary — defer it so it loads on demand through tool search.
  shouldDefer: true,
  maxResultSizeChars: 1e5,
  // Presence follows authority: prompt builds re-ask this, so a session that
  // lacks the right to launch stops listing the tool — advertising a call
  // that would only refuse helps nobody. validateInput asks again per call,
  // catching grants that arrive mid-turn.
  isEnabled: () => dynamicWorkflowsEnabled() && evaluateLaunchAuthority('workflows').allowed,

  async prompt() {
    return getWorkflowToolPrompt()
  },
  async description() {
    return getWorkflowToolPrompt()
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  isConcurrencySafe() {
    // The call itself only launches, but each run owns durable state —
    // launches serialize.
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input: WorkflowInput) {
    return input.script ?? input.name ?? ''
  },

  // --- validateInput: the refusal ladder — managed-disable, enablement,
  //     launch authority, resolve, parse, determinism (inline scripts only),
  //     resume-conflict scan. ------------------------------------------------
  async validateInput(
    input: WorkflowInput,
    context: ToolUseContext,
  ): Promise<ValidationResult> {
    if (context.abortController.signal.aborted) return DISPATCH_RETRACTED
    if (workflowsManagedDisabled()) {
      return {
        result: false,
        message:
          'Dynamic workflows are disabled by managed settings (`disableWorkflows`).',
        errorCode: 5,
      }
    }
    if (!dynamicWorkflowsEnabled()) {
      return {
        result: false,
        message:
          'Dynamic workflows are not enabled for this session (org policy, launch gate, or the "Dynamic workflows" setting in /config).',
        errorCode: 6,
      }
    }
    // Launch authority gates every call, and the check goes back to the
    // durable record each time — a grant given while this turn is in flight
    // must take effect without a restart.
    const launchAuthority = evaluateLaunchAuthority('workflows')
    if (!launchAuthority.allowed) {
      return { result: false, message: launchAuthority.reason, errorCode: 7 }
    }
    const resolved = await resolveScriptSource(input)
    if (context.abortController.signal.aborted) return DISPATCH_RETRACTED
    if ('error' in resolved) {
      return { result: false, message: resolved.error, errorCode: 1 }
    }
    const parsed = parseWorkflowScript(resolved.script)
    if (isParseFailure(parsed)) {
      return {
        result: false,
        message: `Invalid workflow script: ${parsed.error}`,
        errorCode: 2,
      }
    }
    // The static determinism check applies to INLINE scripts only: stored
    // scripts were validated on save, and skipping them avoids a re-parse.
    if (input.script && scriptUsesNonDeterminism(parsed.scriptBody)) {
      return {
        result: false,
        message:
          'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks ' +
          'resume). Stamp results after the workflow returns, or pass timestamps via args.',
        errorCode: 4,
      }
    }
    if (input.resumeFromRunId) {
      // In-process conflict scan: a still-running task for this run id must
      // be stopped before a resume can take over.
      for (const [taskId, t] of Object.entries(context.getAppState().tasks)) {
        if (
          t.type === 'local_workflow' &&
          t.status === 'running' &&
          (t as LocalWorkflowTaskState).workflowRunId === input.resumeFromRunId
        ) {
          return {
            result: false,
            message: `Workflow ${input.resumeFromRunId} is still running (task ${taskId}). Stop it first with ${TASK_STOP_TOOL_NAME}({taskId: "${taskId}"}) before resuming.`,
            errorCode: 3,
          }
        }
      }
    }
    return { result: true }
  },

  // --- checkPermissions: only a NAMED workflow has a stable rule key, so
  //     only named workflows can be allow/deny-listed; anything inline or
  //     path-based lands at "ask" every time. -------------------------------
  async checkPermissions(
    input: WorkflowInput,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    const permCtx = context.getAppState().toolPermissionContext
    const ruleKey = input.scriptPath ? undefined : input.name
    const lookup = (behavior: 'deny' | 'ask' | 'allow') =>
      ruleKey
        ? getRuleByContentsForToolName(permCtx, WORKFLOW_TOOL_NAME, behavior).get(
            ruleKey,
          )
        : undefined

    // Deny wins before any script resolution happens.
    const deny = lookup('deny')
    if (deny) {
      return {
        behavior: 'deny',
        message: `Workflow ${ruleKey} blocked by permission rules`,
        decisionReason: { type: 'rule', rule: deny },
      }
    }

    // Fill updatedInput.script with the resolved source: the consent dialog
    // should show the operator the actual code, not just a name or a path.
    let updatedInput: WorkflowInput = input
    if (input.scriptPath) {
      const file = await readScriptFromDisk(input.scriptPath)
      if (!('error' in file)) updatedInput = { ...input, script: file.script }
    } else if (input.name) {
      const found = await resolveWorkflowName(input.name, getCwd())
      updatedInput = { ...input, script: found?.script }
    }

    const ask = lookup('ask')
    if (ask) {
      return {
        behavior: 'ask',
        message: 'Review dynamic workflow before running',
        updatedInput,
        decisionReason: { type: 'rule', rule: ask },
      }
    }
    const allow = lookup('allow')
    if (allow) {
      return {
        behavior: 'allow',
        updatedInput,
        decisionReason: { type: 'rule', rule: allow },
      }
    }
    return {
      behavior: 'ask',
      message: 'Review dynamic workflow before running',
      updatedInput,
      ...(ruleKey && {
        suggestions: [
          {
            type: 'addRules' as const,
            rules: [
              { toolName: WORKFLOW_TOOL_NAME, ruleContent: ruleKey },
            ],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          },
        ],
      }),
    }
  },

  userFacingName() {
    return 'Workflow'
  },

  getToolUseSummary(input: WorkflowInput | undefined): string | null {
    if (input?.name) return `dynamic workflow: ${input.name}`
    const script = input?.script
    if (!script) return null
    const parsed = parseWorkflowScript(script)
    if (!isParseFailure(parsed)) return (parsed as ParsedWorkflow).meta.description
    const firstLine = script.split('\n').find(l => l.trim()) ?? ''
    return firstLine.length > 50 ? `${firstLine.slice(0, 49)}…` : firstLine
  },

  // ===========================================================================
  // call — the launch pipeline: resolve → parse → mint identities → compile →
  // claim ownership + write launch state + first manifest (one transaction) →
  // register the task → hand off to the engine in the background → settle
  // (status transition, terminal manifest, notification) → answer immediately
  // with async_launched.
  //
  // The third parameter is the session's actual permission callback. Agents
  // spawned from a background run still raise permission questions, and those
  // questions must reach the operator through the wrapped channel — a run
  // with no permission path dies on its first 'ask'.
  // ===========================================================================
  async call(input: WorkflowInput, context: ToolUseContext, canUseTool: CanUseToolFn) {
    // Prefer the task-scoped state writer: for async agents the per-turn
    // writer discards updates, and a task nobody can see also cannot be
    // stopped.
    const setAppState = context.setAppStateForTasks ?? context.setAppState

    const resolved = await resolveScriptSource(input)
    if ('error' in resolved) throw new WorkflowInputError(resolved.error)
    const { script, resolvedScriptPath } = resolved

    const parsed = parseWorkflowScript(script)
    if (isParseFailure(parsed)) {
      throw new WorkflowInputError(`Invalid workflow script: ${parsed.error}`)
    }
    const { meta, scriptBody } = parsed as ParsedWorkflow

    const runId =
      input.resumeFromRunId ?? `wf_${crypto.randomUUID().slice(0, 12)}`
    const taskId = `local_workflow_${crypto.randomUUID().slice(0, 12)}`

    // The pre-launch refusal shape: nothing was registered or written yet, so
    // the result only has to name what stopped the launch.
    const errorResult = (error: string) => ({
      data: {
        status: 'async_launched' as const,
        taskId,
        taskType: 'local_workflow' as const,
        workflowName: meta.name,
        runId,
        summary: meta.description,
        error,
      },
    })

    // Compile before touching anything: a broken script must cost nothing —
    // no task row, no disk writes.
    const compiled = compileWorkflow(scriptBody)
    if (!compiled.ok) return errorResult(compiled.error)

    // daedalus is special-cased for model selection: missing model args pick
    // up the operator's saved choices, and each candidate is checked against
    // the live catalogue. A bad pick stops the launch and names what IS
    // compatible — swapping in some other model behind the operator's back is
    // exactly what this refusal exists to prevent.
    if (meta.name === 'daedalus') {
      const modelChoice = daedalusResolveModels(input.args)
      if (!modelChoice.ok) {
        return errorResult(modelChoice.error ?? 'invalid model choice')
      }
      input = { ...input, args: modelChoice.args }
    }

    const runDir = runDirectoryFor(runId)
    const scriptPath =
      (input.scriptPath ? resolvedScriptPath : undefined) ??
      path.join(runDir, 'workflow.js')
    const scriptDigest = crypto.createHash('sha256').update(script).digest('hex')
    // Remember whether the run dir predates this call: rollback after a
    // launch failure may delete a directory we minted, and must not touch one
    // that already holds a prior run's records.
    const freshRunDir = !existsSync(runDir)

    // ── execution origin, decided once ───────────────────────────────────────
    // The background run is pinned to this directory for its whole life via
    // the cwd override below — otherwise an operator who switches worktrees
    // or clears the session mid-run drags in-flight work to the new location.
    // Canonicalized so two spellings of one directory (symlinks) compare
    // equal. Resumes must honour the origin the manifest recorded, or refuse.
    const originCwd = realCanonicalPath(getCwd())
    let executionCwd = originCwd
    let priorManifest: Awaited<ReturnType<typeof readRunManifest>> | undefined
    if (input.resumeFromRunId != null) {
      const prior = await readRunManifest(runDir)
      if (!prior) {
        throw new WorkflowInputError(
          `workflow ${input.resumeFromRunId} has no run record under ${runDir} — ` +
            `it was launched from a different working directory (you are in ${originCwd}). ` +
            `Resume it from its origin directory; nothing was started here.`,
        )
      }
      priorManifest = prior
      // Cross-process conflict: the in-memory scan in validateInput only sees
      // THIS process's tasks. A fresh manifest heartbeat means the recorded
      // owner is alive SOMEWHERE — resuming under a healthy owner would put
      // two writers on one run.
      if (recordedOwnerAlive(prior, prior.mtimeMs, Date.now())) {
        throw new WorkflowInputError(
          `workflow ${input.resumeFromRunId} is still RUNNING (its owner's heartbeat is fresh` +
            `${prior.owner ? `, epoch ${prior.owner.epoch}` : ''}). ` +
            `Stop it first; never resume under a healthy owner. Nothing was started.`,
        )
      }
      const recorded = prior.origin?.cwd
      if (recorded !== undefined) {
        const recordedReal = realCanonicalPath(recorded)
        if (recordedReal !== originCwd) {
          if (!existsSync(recordedReal)) {
            throw new WorkflowInputError(
              `workflow ${input.resumeFromRunId} was launched from ${recorded}, ` +
                `which no longer exists — cannot resume against a missing origin. ` +
                `Nothing was started.`,
            )
          }
          // Resume follows the run's home directory — the operator's current
          // location is irrelevant to where the work belongs.
          executionCwd = recordedReal
        }
      }
    }
    const executionRepoRoot = findCanonicalGitRoot(executionCwd) ?? undefined
    const origin: NonNullable<WorkflowRunManifest['origin']> = {
      cwd: executionCwd,
      ...(executionRepoRoot ? { repoRoot: executionRepoRoot } : {}),
    }

    // Ownership identity. claim.json holds {instanceId: random, epoch:
    // incrementing} — deliberately NOT a pid, because the OS recycles pids
    // and a recycled pid would impersonate a live owner. Each takeover bumps
    // the epoch, which is how everything downstream (journal indexing, the
    // manifest fence) can tell an old owner's late writes from the current
    // owner's. Assigned inside the transactional block below; no reader runs
    // before the assignment.
    let claim!: Awaited<ReturnType<typeof claimRun>>

    // Transcript locations accumulate — the set only grows. Session changes
    // mid-run redirect where new transcripts go, and a reader that only knew
    // the latest location would lose the earlier ones.
    const transcriptDirsSeen = new Set<string>(priorManifest?.transcriptDirs ?? [])

    // On resume: evict the prior settled task rows for this run id so the
    // fresh registration below re-seeds cleanly.
    if (input.resumeFromRunId != null) {
      const stale = Object.entries(context.getAppState().tasks)
        .filter(
          ([, t]) =>
            t.type === 'local_workflow' &&
            (t as LocalWorkflowTaskState).workflowRunId === input.resumeFromRunId &&
            t.status !== 'running',
        )
        .map(([id]) => id)
      if (stale.length > 0) {
        setAppState(prev => {
          const tasks = { ...prev.tasks }
          for (const id of stale) delete tasks[id]
          return { ...prev, tasks }
        })
      }
    }

    // Register the background task (fresh abort controller + per-agent
    // controller map come back on the task).
    const task = registerWorkflowTask({
      taskId,
      script,
      scriptPath,
      summary: meta.description,
      workflowName: meta.name,
      title: meta.title,
      phases: meta.phases as WorkflowPhase[] | undefined,
      defaultModel: context.options.mainLoopModel,
      workflowRunId: runId,
      args: input.args,
      setAppState,
      toolUseId: context.toolUseId,
    })

    // The engine receives the task's own abort controller (so stop and skip
    // reach it) and a permission callback dressed in the workflow channel,
    // which tracks outstanding asks for the UI and enforces a deny-on-timeout
    // whose damage is confined to the one agent that asked.
    const runCtx: WorkflowToolContext = {
      ...context,
      abortController: task.abortController ?? context.abortController,
      canUseTool: makeWorkflowCanUseTool({
        taskId,
        setAppState,
        realCanUseTool: canUseTool,
        getAgentControllers: () => task.agentControllers,
        // The ask-label source: the consent card names the workflow + agent.
        getAppState: () => context.getAppState(),
      }),
    }

    // ── the manifest writer ──────────────────────────────────────────────────
    // run.json is a projection of the task's coalesced state, re-stamped on a
    // throttle and a heartbeat so its mtime says "alive". The chain gives
    // writes strict ordering (an earlier queued snapshot can never publish
    // after a later terminal one), per-write acknowledgement (the returned
    // promise is true only once THAT snapshot is on disk), a bounded terminal
    // retry, and an ownership fence that drops this process's writes after
    // another owner takes the run over.
    let lastManifestWrite = 0
    const manifestChain = createManifestWriteChain(
      writeRunManifest,
      e =>
        logError(
          `Failed to write workflow run manifest for ${runId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      {
        stillOwner: async () => {
          const current = await readRunClaim(runDir)
          return current === undefined || current.instanceId === claim.instanceId
        },
        onFenced: () =>
          logError(
            `workflow run ${runId} was re-claimed by a newer owner — this process's manifest writes are fenced`,
          ),
      },
    )
    const writeManifest = (final?: {
      status: WorkflowRunManifest['status']
      error?: string
    }): Promise<boolean> => {
      if (manifestChain.finalized()) return Promise.resolve(true)
      lastManifestWrite = Date.now()
      const live = context.getAppState().tasks?.[taskId] as
        | LocalWorkflowTaskState
        | undefined
      // Recompute the transcript destination on every write: routing follows
      // the current session id, which can change under a running workflow,
      // and the manifest should point at reality rather than at the launch-
      // time snapshot.
      const liveTranscriptDir = getWorkflowTranscriptDir(runId)
      transcriptDirsSeen.add(liveTranscriptDir)
      const snapshot: WorkflowRunManifest = {
        version: RUN_MANIFEST_VERSION,
        runId,
        workflowName: meta.name,
        title: meta.title,
        description: meta.description,
        phases: meta.phases as WorkflowPhase[] | undefined,
        scriptPath,
        scriptDigest,
        ...embedArgs(input.args),
        sessionId: getSessionId(),
        transcriptDir: liveTranscriptDir,
        runDir,
        startTime: task.startTime,
        endTime: final ? Date.now() : undefined,
        status: final?.status ?? projectManifestStatus(live?.status),
        origin,
        owner: { instanceId: claim.instanceId, epoch: claim.epoch },
        transcriptDirs: [...transcriptDirsSeen],
        ownerPid: process.pid,
        agentCount: live?.agentCount ?? 0,
        totalTokens: live?.totalTokens ?? 0,
        totalToolCalls: live?.totalToolCalls ?? 0,
        error: final?.error ?? live?.error,
        logsTail: logsTail(live?.logs ?? []),
        agents: buildAgentSummaries(live?.workflowProgress ?? []),
      }
      return manifestChain.write(snapshot, final !== undefined)
    }

    // ── the launch transaction ───────────────────────────────────────────────
    // Ownership claim, launch files, and the first manifest snapshot must all
    // be durable before this tool reports a launch. On any failure the
    // registration is rolled back (and a directory this call minted is
    // deleted) and a precise error goes back to the model — the invariant is
    // that no run can ever exist that disk cannot fully account for.
    try {
      claim = await claimRun(runDir)
      await persistLaunchState(runDir, script, input.args)
      if (!(await writeManifest())) {
        throw new Error(`initial run.json write failed under ${runDir}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setAppState(prev => {
        const tasks = { ...prev.tasks }
        delete tasks[taskId]
        return { ...prev, tasks }
      })
      if (freshRunDir) {
        await rm(runDir, { recursive: true, force: true }).catch(() => {})
      }
      throw new WorkflowInputError(
        `workflow not launched: persisting the run under ${runDir} failed (${msg}). ` +
          `Nothing was started — fix the path/permissions and retry.`,
      )
    }

    // ── the background run ───────────────────────────────────────────────────
    // Wrapped in the cwd override so async-local storage carries the pinned
    // origin to every descendant: the engine's injected getCwd, per-command
    // cwd reads inside agents, nested workflow() registry lookups.
    const driveRun = async (): Promise<void> => {
      // Progress batching: coalesce frames, flush into task state, and ride
      // each flush with a throttled manifest re-stamp (setAppState applies
      // synchronously, so the projection reads the just-applied batch).
      const batcher = createProgressBatcher({
        apply: events => updateWorkflowProgressBatch(taskId, events, setAppState),
        afterFlush: () => {
          if (Date.now() - lastManifestWrite >= RUN_MANIFEST_WRITE_THROTTLE_MS) {
            writeManifest()
          }
        },
      })
      const onProgress = (frame: ProgressFrame): void => {
        if (frame.type !== 'progress') return
        if (!frame.data) return
        batcher.push(frame.data as unknown as WorkflowProgressEvent)
      }

      // Token budget: total from the live turn budget (null ⇒ unlimited);
      // spend measured from THIS point, so budget.spent() reports tokens
      // spent since the workflow started.
      const spentAtStart = getTurnOutputTokens()
      const tokenBudget = {
        total: getCurrentTurnTokenBudget(),
        getTurnSpent: () => getTurnOutputTokens() - spentAtStart,
      }

      // Liveness heartbeat. During a long silent agent turn no progress
      // frames arrive, which starves the flush-path re-stamp — and a stale
      // manifest mtime makes a healthy run look orphaned. Torn down in
      // finally; the writer's latch neutralizes any stamp that fires late.
      const manifestHeartbeat = setInterval(
        () => writeManifest(),
        RUN_MANIFEST_HEARTBEAT_MS,
      )
      try {
        const result = await runWorkflowScript(
          compiled.vmScript,
          runCtx,
          // The engine's tap fires BOTH this positional channel AND
          // opts.onProgress for every frame. The batcher must see each log
          // exactly once (the task reducer APPENDS logs), so the positional
          // channel is a deliberate no-op.
          () => {},
          {
            makeHooks: makeWorkflowHooks,
            workflowRunId: runId,
            onProgress,
            onAgentController: (agentId, controller) => {
              if (controller) task.agentControllers?.set(agentId, controller)
              else task.agentControllers?.delete(agentId)
            },
            args: input.args,
            seedPhaseTitles: meta.phases?.map(p => p.title),
            tokenBudget,
            // The replay cache. When the journal degrades — an append that
            // failed, a line that would not parse — the run's progress log
            // announces it, because the alternative is a resume that
            // quietly replays less than it claims. Rows are epoch-stamped
            // so the loader can discard anything an out-of-date owner
            // appended after losing the run.
            journal: new LocalFileJournal(runDir, {
              onDegraded: reason =>
                onProgress({
                  type: 'progress',
                  toolUseID: 'workflow_journal_degraded',
                  data: {
                    type: 'workflow_log',
                    message: `journal degraded — cached replay may be incomplete: ${reason}`,
                  },
                } as ProgressFrame),
              epoch: claim.epoch,
            }),
            getCwd,
            resolveWorkflow: resolveWorkflowName,
            getAllWorkflows: listWorkflows,
            // The `ledger` script global exists only while its gate is on.
            // Each recorded row is anchored to this run's own trace
            // directory, so claims stay traceable to their evidence.
            evolutionLedger: evolutionLedgerEnabled()
              ? makeWorkflowLedgerHost(
                  defaultEvolutionLedgerDir(getCwd()),
                  `workflow-run:${runId} · traces: ${runDir}`,
                )
              : undefined,
            // The `themis` script global — present only while the themis
            // level is on.
            themis: themisLevel() !== 'off' ? makeThemisWorkflowHost(runId) : undefined,
          },
        )
        batcher.drain()

        const live = context.getAppState().tasks?.[taskId] as
          | LocalWorkflowTaskState
          | undefined
        const totalTokens = live?.totalTokens ?? 0
        const totalToolCalls = live?.totalToolCalls ?? 0
        // Pausing and killing share one abort controller, so the abort flag
        // alone cannot say which happened — the task's live status can.
        // Conflate them and every pause hits disk as a kill, which reads to
        // the operator as a run that lost its history.
        const pausedLive = live?.status === 'paused'

        if (task.abortController?.signal.aborted) {
          // Awaited deliberately: if this finalizer exits with the write
          // still queued and the process dies fast, run.json keeps saying
          // 'running' about a run that is over.
          await writeManifest({ status: pausedLive ? 'paused' : 'killed' })
          // Killed is a TERMINAL state and the launching agent is told —
          // same task-notification path as completed/failed, sequenced
          // after the manifest so whoever hears it finds a run.json that
          // agrees. Paused stays silent: it is not terminal, and the pause
          // transition latched `notified` for its own resume UX.
          if (!pausedLive) {
            enqueueWorkflowNotification({
              taskId,
              summary: meta.description,
              status: 'killed',
              agentCount: live?.agentCount ?? 0,
              totalTokens,
              totalToolCalls,
              durationMs: Date.now() - task.startTime,
              setAppState,
              toolUseId: context.toolUseId,
              transcriptDir: runDir,
              scriptPath,
              workflowRunId: runId,
              args: input.args,
              agents: evolutionLedgerEnabled()
                ? buildAgentSummaries(live?.workflowProgress ?? [])
                : undefined,
            })
          }
          return
        }

        // The verdict weighs agent outcomes, not just the script's own exit:
        // "returned normally, but every agent it launched died" must not be
        // reported as success.
        const terminal = deriveWorkflowTerminalStatus({
          error: result.error,
          failures: result.failures,
          agentCount: result.agentCount,
        })
        const terminalError = result.error ?? terminal.derivedError

        let outputWriteError: string | undefined
        if (terminal.status === 'failed') {
          failWorkflowTask(
            taskId,
            terminalError ?? 'workflow failed',
            result.agentCount,
            result.logs,
            setAppState,
          )
          // Sequenced ahead of the notification: whoever hears the run
          // ended must find a run.json that agrees.
          await writeManifest({
            status: 'failed',
            ...(terminalError !== undefined ? { error: terminalError } : {}),
          })
        } else {
          // The notification points the model at an output file. Await the
          // write first: the pointer must reference bytes that exist, or —
          // when the write failed — carry that failure by name.
          outputWriteError =
            (await completeWorkflowTask(
              taskId,
              result.result,
              result.agentCount,
              result.logs,
              setAppState,
            )) ?? undefined
          await writeManifest({ status: terminal.status })
        }

        enqueueWorkflowNotification({
          taskId,
          summary: meta.description,
          status: terminal.status,
          error: terminalError,
          result: result.result,
          failures: result.failures,
          agentCount: result.agentCount,
          totalTokens,
          totalToolCalls,
          durationMs: result.durationMs,
          setAppState,
          toolUseId: context.toolUseId,
          transcriptDir: runDir,
          scriptPath,
          workflowRunId: runId,
          args: input.args,
          outputWriteError,
          // The per-agent trace index for the notification's agent section
          // rides the same gate as the ledger; gate off ⇒ absent.
          agents: evolutionLedgerEnabled()
            ? buildAgentSummaries(live?.workflowProgress ?? [])
            : undefined,
        })
      } catch (e) {
        // Crash safety: mark failed + notify even when the launch body
        // itself throws.
        const msg = e instanceof Error ? e.message : String(e)
        logError(msg)
        const live = context.getAppState().tasks?.[taskId] as
          | LocalWorkflowTaskState
          | undefined
        // Suspending a run frequently manifests here as a VM-side throw.
        // Check the status before condemning the run: paused is paused.
        if (live?.status === 'paused') {
          await writeManifest({ status: 'paused' })
          return
        }
        failWorkflowTask(
          taskId,
          msg,
          live?.agentCount ?? 0,
          live?.logs ?? [],
          setAppState,
        )
        await writeManifest({ status: 'failed', error: msg })
        enqueueWorkflowNotification({
          taskId,
          summary: meta.description,
          status: 'failed',
          error: msg,
          agentCount: live?.agentCount ?? 0,
          totalTokens: live?.totalTokens ?? 0,
          totalToolCalls: live?.totalToolCalls ?? 0,
          durationMs: Date.now() - task.startTime,
          setAppState,
          toolUseId: context.toolUseId,
          transcriptDir: runDir,
          scriptPath,
          workflowRunId: runId,
          args: input.args,
        })
      } finally {
        clearInterval(manifestHeartbeat)
      }
    }
    void runWithCwdOverride(executionCwd, driveRun)

    return {
      data: {
        status: 'async_launched' as const,
        taskId,
        taskType: 'local_workflow' as const,
        workflowName: meta.name,
        runId,
        summary: meta.description,
        transcriptDir: runDir,
        scriptPath,
      },
    }
  },

  // --- the tool_result the model reads: launch receipt + how to watch,
  //     iterate, and resume (or the error variant). --------------------------
  mapToolResultToToolResultBlockParam(
    data: WorkflowResultData,
    toolUseId: string,
  ): ToolResultBlockParam {
    if (data.error) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: `Workflow script has a syntax error and was not launched:\n${data.error}`,
        is_error: true,
      }
    }
    let content = `Workflow launched in background. Task ID: ${data.taskId}`
    if (data.summary) content += `\nSummary: ${data.summary}`
    if (data.transcriptDir) content += `\nTranscript dir: ${data.transcriptDir}`
    if (data.scriptPath) {
      content += `\nScript file: ${data.scriptPath}\n(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${data.scriptPath}"} to iterate without resending the script.)`
    }
    if (data.scriptPath && data.runId) {
      content += `\nRun ID: ${data.runId}\nTo resume after editing the script: Workflow({scriptPath: "${data.scriptPath}", resumeFromRunId: "${data.runId}"}) — completed agents return cached results.`
    }
    if (data.runId) {
      // Point watchers at the typed status resource — the alternative
      // observed in the wild is reverse-engineering the manifest by eye.
      content += `\nLive status: Inspect mercury://workflow/${data.runId} (run/phase/liveness/agent state; per-agent detail via ?child=<agentId>).`
    }
    content +=
      '\n\nYou will be notified when it completes. Use /workflows to watch live progress.'
    return {
      tool_use_id: toolUseId,
      type: 'tool_result',
      content,
      is_error: false,
    }
  },

  // Transcript renderers: the description line for the tool use, and a result
  // line that subscribes to task state — running workflows animate, finished
  // ones show their final summary. Rejection keeps the shared "cancelled"
  // default, which is accurate for a workflow that never started.
  renderToolUseMessage(input: Partial<WorkflowInput>, { verbose }: { verbose: boolean }) {
    return renderWorkflowToolUseMessage(
      { name: input.name, script: input.script },
      verbose,
      script => {
        const parsed = parseWorkflowScript(script)
        return isParseFailure(parsed)
          ? { ok: false }
          : { ok: true, description: (parsed as ParsedWorkflow).meta.description }
      },
    )
  },
  renderToolResultMessage(content: WorkflowResultData) {
    return renderWorkflowResultMessage(content as WorkflowResultContent)
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, WorkflowResultData>

export const WorkflowTool = buildTool(WorkflowToolDef)
