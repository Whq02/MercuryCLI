
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
  settleInFlightAgentRows,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
  type WorkflowNotificationArgs,
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

const TASK_STOP_TOOL_NAME = 'TaskStop'

const PROGRESS_FLUSH_MS = 16

export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowInputError'
  }
}

export function workflowRunLabel(meta: { name?: string; title?: string; description?: string }): string {
  const name = meta.name?.trim() ?? ''
  if (name !== '') return name
  const title = meta.title?.trim() ?? ''
  if (title !== '') return title
  return meta.description?.trim() ?? ''
}

type WorkflowInput = {
  script?: string
  name?: string
  description?: string
  title?: string
  args?: unknown
  scriptPath?: string
  resumeFromRunId?: string
  run_in_background?: boolean
}

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

const DISPATCH_RETRACTED = {
  result: false as const,
  message:
    'Tool dispatch was retracted by a server fallback; the input may be truncated.',
  errorCode: 7,
}

async function resolveScriptSource(input: WorkflowInput): Promise<ScriptSource> {
  if (input.scriptPath) {
    if (input.script) {
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

function isParseFailure(
  x: ParsedWorkflow | { ok: false; error: string } | undefined,
): x is { ok: false; error: string } {
  return !!x && (x as { ok?: boolean }).ok === false
}

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


function runDirectoryFor(runId: string): string {
  return path.join(workflowRunsRoot(getCwd()), runId)
}

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

function realCanonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

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

const WorkflowToolDef = {
  name: WORKFLOW_TOOL_NAME,
  aliases: ['RunWorkflow'],
  searchHint: 'orchestrate subagents with deterministic JavaScript workflow',
  shouldDefer: true,
  maxResultSizeChars: 1e5,
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
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input: WorkflowInput) {
    return input.script ?? input.name ?? ''
  },

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

    const deny = lookup('deny')
    if (deny) {
      return {
        behavior: 'deny',
        message: `Workflow ${ruleKey} blocked by permission rules`,
        decisionReason: { type: 'rule', rule: deny },
      }
    }

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

  async call(input: WorkflowInput, context: ToolUseContext, canUseTool: CanUseToolFn) {
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

    const errorResult = (error: string) => ({
      data: {
        status: 'async_launched' as const,
        taskId,
        taskType: 'local_workflow' as const,
        workflowName: meta.name,
        runId,
        summary: workflowRunLabel(meta),
        error,
      },
    })

    const compiled = compileWorkflow(scriptBody)
    if (!compiled.ok) return errorResult(compiled.error)

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
    const freshRunDir = !existsSync(runDir)

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
          executionCwd = recordedReal
        }
      }
    }
    const executionRepoRoot = findCanonicalGitRoot(executionCwd) ?? undefined
    const origin: NonNullable<WorkflowRunManifest['origin']> = {
      cwd: executionCwd,
      ...(executionRepoRoot ? { repoRoot: executionRepoRoot } : {}),
    }

    let claim!: Awaited<ReturnType<typeof claimRun>>

    const transcriptDirsSeen = new Set<string>(priorManifest?.transcriptDirs ?? [])

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

    const task = registerWorkflowTask({
      taskId,
      script,
      scriptPath,
      summary: workflowRunLabel(meta),
      workflowName: meta.name,
      title: meta.title,
      phases: meta.phases as WorkflowPhase[] | undefined,
      defaultModel: context.options.mainLoopModel,
      workflowRunId: runId,
      args: input.args,
      setAppState,
      toolUseId: context.toolUseId,
    })

    const runCtx: WorkflowToolContext = {
      ...context,
      abortController: task.abortController ?? context.abortController,
      canUseTool: makeWorkflowCanUseTool({
        taskId,
        setAppState,
        realCanUseTool: canUseTool,
        getAgentControllers: () => task.agentControllers,
        getAppState: () => context.getAppState(),
      }),
    }

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
      const liveTranscriptDir = getWorkflowTranscriptDir(runId)
      transcriptDirsSeen.add(liveTranscriptDir)
      const now = Date.now()
      const progressRows = final
        ? settleInFlightAgentRows(live?.workflowProgress ?? [], now)
        : (live?.workflowProgress ?? [])
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
        endTime: final ? now : undefined,
        status: final?.status ?? projectManifestStatus(live?.status),
        origin,
        owner: { instanceId: claim.instanceId, epoch: claim.epoch },
        transcriptDirs: [...transcriptDirsSeen],
        ownerPid: process.pid,
        agentCount: live?.agentCount ?? 0,
        totalTokens: live?.totalTokens ?? 0,
        ...(live?.usage !== undefined ? { usage: live.usage } : {}),
        totalToolCalls: live?.totalToolCalls ?? 0,
        error: final?.error ?? live?.error,
        logsTail: logsTail(live?.logs ?? []),
        agents: buildAgentSummaries(progressRows),
      }
      return manifestChain.write(snapshot, final !== undefined)
    }

    const settleRun = async (
      verdict: { status: 'completed' | 'completed_with_failures' | 'failed'; error?: string },
      transition: () => Promise<string | null> | void,
      notification: Omit<WorkflowNotificationArgs, 'status' | 'error' | 'outputWriteError'>,
    ): Promise<void> => {
      await writeManifest({
        status: verdict.status,
        ...(verdict.error !== undefined ? { error: verdict.error } : {}),
      })
      const outputWriteError = (await transition()) ?? undefined
      enqueueWorkflowNotification({
        ...notification,
        status: verdict.status,
        error: verdict.error,
        outputWriteError,
      })
    }

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

    const driveRun = async (): Promise<void> => {
      let trailingManifestWrite: NodeJS.Timeout | null = null
      const batcher = createProgressBatcher({
        apply: events => updateWorkflowProgressBatch(taskId, events, setAppState),
        afterFlush: () => {
          const sinceLast = Date.now() - lastManifestWrite
          if (sinceLast >= RUN_MANIFEST_WRITE_THROTTLE_MS) {
            writeManifest()
            return
          }
          if (trailingManifestWrite === null) {
            trailingManifestWrite = setTimeout(() => {
              trailingManifestWrite = null
              writeManifest()
            }, RUN_MANIFEST_WRITE_THROTTLE_MS - sinceLast)
            trailingManifestWrite.unref?.()
          }
        },
      })
      const onProgress = (frame: ProgressFrame): void => {
        if (frame.type !== 'progress') return
        if (!frame.data) return
        batcher.push(frame.data as unknown as WorkflowProgressEvent)
      }

      const spentAtStart = getTurnOutputTokens()
      const tokenBudget = {
        total: getCurrentTurnTokenBudget(),
        getTurnSpent: () => getTurnOutputTokens() - spentAtStart,
      }

      const manifestHeartbeat = setInterval(
        () => writeManifest(),
        RUN_MANIFEST_HEARTBEAT_MS,
      )
      try {
        const result = await runWorkflowScript(
          compiled.vmScript,
          runCtx,
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
            evolutionLedger: evolutionLedgerEnabled()
              ? makeWorkflowLedgerHost(
                  defaultEvolutionLedgerDir(getCwd()),
                  `workflow-run:${runId} · traces: ${runDir}`,
                )
              : undefined,
            themis: themisLevel() !== 'off' ? makeThemisWorkflowHost(runId) : undefined,
          },
        )
        batcher.drain()

        const live = context.getAppState().tasks?.[taskId] as
          | LocalWorkflowTaskState
          | undefined
        const totalTokens = live?.totalTokens ?? 0
        const usage = live?.usage
        const totalToolCalls = live?.totalToolCalls ?? 0
        const pausedLive = live?.status === 'paused'

        if (task.abortController?.signal.aborted) {
          await writeManifest({ status: pausedLive ? 'paused' : 'killed' })
          if (!pausedLive) {
            enqueueWorkflowNotification({
              taskId,
              summary: workflowRunLabel(meta),
              status: 'killed',
              agentCount: live?.agentCount ?? 0,
              totalTokens,
              usage,
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

        const terminal = deriveWorkflowTerminalStatus({
          error: result.error,
          failures: result.failures,
          agentCount: result.agentCount,
        })
        const terminalError = result.error ?? terminal.derivedError

        await settleRun(
          { status: terminal.status, ...(terminalError !== undefined ? { error: terminalError } : {}) },
          terminal.status === 'failed'
            ? () =>
                failWorkflowTask(
                  taskId,
                  terminalError ?? 'workflow failed',
                  result.agentCount,
                  result.logs,
                  setAppState,
                )
            : () =>
                completeWorkflowTask(
                  taskId,
                  result.result,
                  result.agentCount,
                  result.logs,
                  setAppState,
                ),
          {
            taskId,
            summary: workflowRunLabel(meta),
            result: result.result,
            failures: result.failures,
            agentCount: result.agentCount,
            totalTokens,
            usage,
            totalToolCalls,
            durationMs: result.durationMs,
            setAppState,
            toolUseId: context.toolUseId,
            transcriptDir: runDir,
            scriptPath,
            workflowRunId: runId,
            args: input.args,
            agents: evolutionLedgerEnabled()
              ? buildAgentSummaries(live?.workflowProgress ?? [])
              : undefined,
          },
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logError(msg)
        const live = context.getAppState().tasks?.[taskId] as
          | LocalWorkflowTaskState
          | undefined
        if (live?.status === 'paused') {
          await writeManifest({ status: 'paused' })
          return
        }
        await settleRun(
          { status: 'failed', error: msg },
          () =>
            failWorkflowTask(
              taskId,
              msg,
              live?.agentCount ?? 0,
              live?.logs ?? [],
              setAppState,
            ),
          {
            taskId,
            summary: workflowRunLabel(meta),
            agentCount: live?.agentCount ?? 0,
            totalTokens: live?.totalTokens ?? 0,
            usage: live?.usage,
            totalToolCalls: live?.totalToolCalls ?? 0,
            durationMs: Date.now() - task.startTime,
            setAppState,
            toolUseId: context.toolUseId,
            transcriptDir: runDir,
            scriptPath,
            workflowRunId: runId,
            args: input.args,
          },
        )
      } finally {
        clearInterval(manifestHeartbeat)
        if (trailingManifestWrite !== null) clearTimeout(trailingManifestWrite)
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
        summary: workflowRunLabel(meta),
        transcriptDir: runDir,
        scriptPath,
      },
    }
  },

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
