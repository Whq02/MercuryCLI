/**
 * The PowerShell tool: schema, execution lifecycle, honest result mapping, and
 * the terminal renderers. The Windows twin of the Bash tool — it shares the
 * foreground-budget owner, the background-hint row, and the interrupt/timeout
 * backgrounding grammar, and diverges only where documented in the slice spec.
 *
 * A command that never ran must never look like a success: the not-started
 * rails carry a typed preSpawnError and never fabricate exit code 0.
 */
import { z } from 'zod/v4'
import { buildTool, stringInputField, type ToolUseContext, type ToolResult, type ToolPermissionContext } from '../../Tool.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { exec } from '../../utils/Shell.js'
import type { ExecResult } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  armForegroundBudget,
  backgroundExistingForegroundTask,
  isAssistantModeActive,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from '../../tasks/LocalShellTask/LocalShellTask.js'
import { ShellError, errorMessage } from '../../utils/errors.js'
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js'
import { formatDuration } from '../../utils/format.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { detectGitOperation, trackGitOperations } from '../../tools/shared/gitOperationTracking.js'
import { persistToolResult, buildLargeToolResultMessage, generatePreview, PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'
import { interpretCommandResult } from './commandSemantics.js'
import { getPrompt, getDefaultTimeoutMs, getMaxTimeoutMs } from './prompt.js'
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js'
import { getCachedPowerShellPath } from '../../utils/shell/powershellDetection.js'
import { firstCommandWord } from '../../utils/shell/shellToolUtils.js'
import { powershellToolHasPermission } from './powershellPermissions.js'
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical } from './readOnlyValidation.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import {
  BackgroundHint,
} from '../BashTool/UI.js'
import {
  buildImageToolResult,
  formatOutput,
  isImageOutput,
  resizeShellImageOutput,
  resetCwdIfOutsideProject,
  stdErrAppendShellResetMessage,
  stripEmptyLines,
} from '../BashTool/utils.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js'
import type { PowerShellProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { existsSync } from 'node:fs'
import { copyFile, link, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'

export type { PowerShellProgress }

/** The blocked-sleep threshold in seconds (contract data; a single tunable). */
const SLEEP_THRESHOLD_SECONDS = 2

/**
 * Detect a standalone leading sleep. Considers only the first statement.
 * Returns null when not blocked, otherwise a human-readable description.
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const trimmed = command.trim()
  const firstStatement = (trimmed.split(/[;|&\r\n]/)[0] ?? '').trim()
  // Start-Sleep or the `sleep` alias, optional -Seconds (or -s), then a number.
  const match = firstStatement.match(/^(?:start-sleep|sleep)(?:\s+(?:-s(?:econds)?)?\s*)?(\d+(?:\.\d+)?)\s*$/i)
  if (!match) return null
  const seconds = parseFloat(match[1] as string)
  if (seconds < SLEEP_THRESHOLD_SECONDS) return null
  const remainder = trimmed.slice(firstStatement.length).trim()
  return remainder
    ? `A leading Start-Sleep of ${seconds}s (followed by "${remainder}") was blocked.`
    : `A standalone Start-Sleep of ${seconds}s was blocked.`
}

/** Local alias so the lifecycle can call the exported detector. */
const detectSleep = detectBlockedSleepPattern

// ── constants ──────────────────────────────────────────────────────────────

const ASSISTANT_BLOCKING_BUDGET_MS = 15_000
const QUIET_WINDOW_MS = 2_000
const SOFT_TIMEOUT_MS = 30_000
const PERSIST_THRESHOLD_CHARS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
// Always enabled: the compat background-tasks env kill is retired.
const BACKGROUND_TASKS_DISABLED = false
const NEVER_AUTO_BACKGROUND = new Set(['start-sleep', 'sleep'])

// ── input schema ──────────────────────────────────────────────────────────

function buildModelSchema() {
  return z.strictObject({
    command: z.string().describe('The PowerShell command to execute'),
    timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
    description: z.string().optional().describe('A short description of what the command does, in active voice.'),
    run_in_background: semanticBoolean(z.boolean().optional()).describe('Set to true to run the command in the background and read its output later.'),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('An explicit, dangerous override that runs the command without sandboxing.'),
  })
}
const modelInputSchema = lazySchema(buildModelSchema)
type ModelInput = z.infer<ReturnType<typeof buildModelSchema>>
export type PowerShellToolInput = ModelInput

export type Out = {
  stdout: string
  stderr: string
  interrupted: boolean
  isImage?: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  assistantAutoBackgrounded?: boolean
  timeoutAutoBackgroundedAfterMs?: number
  preSpawnError?: string
  returnCodeInterpretation?: string
  persistedOutputPath?: string
  persistedOutputSize?: number
  gitOperation?: unknown
}

// ── search/read classification ─────────────────────────────────────────

const NEUTRAL = new Set(['write-output', 'write-host'])
const SEARCH = new Set(['select-string', 'get-childitem', 'findstr', 'where.exe'])
const READ = new Set(['get-content', 'get-item', 'test-path', 'resolve-path', 'get-process', 'get-service', 'get-childitem', 'get-location', 'get-filehash', 'get-acl', 'format-hex'])

function isSearchOrRead(command: string): { isSearch: boolean; isRead: boolean } {
  const trimmed = command.trim()
  if (trimmed === '') return { isSearch: false, isRead: false }
  let isSearch = false, isRead = false, sawReal = false
  for (const fragment of trimmed.split(/[;|]/)) {
    const first = fragment.trim().split(/\s+/)[0]
    if (!first) continue
    const canonical = resolveToCanonical(first)
    if (NEUTRAL.has(canonical)) continue
    if (!SEARCH.has(canonical) && !READ.has(canonical)) return { isSearch: false, isRead: false }
    sawReal = true
    if (SEARCH.has(canonical)) isSearch = true
    if (READ.has(canonical)) isRead = true
  }
  return sawReal ? { isSearch, isRead } : { isSearch: false, isRead: false }
}

// ── the not-started rails + lifecycle ───────────────────────────────

async function* runPowerShell(
  input: PowerShellToolInput,
  context: ToolUseContext,
  agentId: string | undefined,
): AsyncGenerator<{ toolUseID: string; data: PowerShellProgress }, Out, void> {
  const abortController = context.abortController
  const isMainThread = agentId === undefined
  const requestedTimeout = input.timeout
  const effectiveTimeout = Math.min(requestedTimeout || getDefaultTimeoutMs(), getMaxTimeoutMs())
  const firstToken = firstCommandWord(pinnedCommandAnalysis.splitCommand(input.command)[0] ?? '')
  const shouldAutoBackground = !BACKGROUND_TASKS_DISABLED && !NEVER_AUTO_BACKGROUND.has(resolveToCanonical(firstToken))
  // On Windows the sandbox is unconditionally off; otherwise delegate.
  const useSandbox = getPlatform() === 'windows' ? false : shouldUseSandbox(input)

  let progressResolve: (() => void) | null = null
  let latest = { recent: '', all: '', lines: 0, bytes: 0, incomplete: false }

  // Not-started rail 1: no PowerShell binary resolvable. A command that never
  // ran must never look like a success — exit code 127, never 0.
  const powershellPath = await getCachedPowerShellPath()
  if (powershellPath === null) {
    return await postProcess({
      stdout: '',
      stderr: 'PowerShell is unavailable on this system.',
      code: 127,
      interrupted: false,
      preSpawnError: 'PowerShell is unavailable on this system. Install PowerShell 7 (pwsh) to enable PowerShell commands.',
    })
  }

  // Not-started rail 2: the spawn itself rejected.
  let shellCommand: Awaited<ReturnType<typeof exec>>
  try {
    shellCommand = await exec(input.command, abortController.signal, 'powershell', {
      timeout: effectiveTimeout,
      preventCwdChanges: !isMainThread,
      shouldUseSandbox: useSandbox,
      shouldAutoBackground,
      onProgress: (recent, all, lines, bytes, incomplete) => {
        latest = { recent, all, lines, bytes: incomplete ? bytes : 0, incomplete }
        progressResolve?.()
      },
    })
  } catch (spawnError) {
    const message = errorMessage(spawnError)
    return await postProcess({
      stdout: '',
      stderr: `The PowerShell command failed to execute: ${message}`,
      code: 127,
      interrupted: false,
      preSpawnError: `The PowerShell command failed to execute: ${message}`,
    })
  }

  let assistantAutoBackgrounded = false
  let timeoutAutoBackgroundedAfterMs: number | undefined
  let foregroundTaskId: string | null = null
  let backgroundId: string | undefined

  const startBackgrounding = async (fromTrigger?: (id: string) => void): Promise<void> => {
    if (foregroundTaskId !== null) {
      const converted = backgroundExistingForegroundTask(foregroundTaskId, shellCommand, input.description ?? input.command, context.setAppState, context.toolUseId)
      if (!converted) return
      backgroundId = foregroundTaskId
      fromTrigger?.(backgroundId)
      return
    }
    const handle = await spawnShellTask(
      { command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.toolUseId, agentId: agentId as never },
      { abortController, getAppState: () => { throw new Error('spawn must not read app state') }, setAppState: context.setAppState },
    )
    backgroundId = handle.taskId
    progressResolve?.()
    fromTrigger?.(backgroundId)
  }

  shellCommand.onTimeout?.(backgroundFn => {
    timeoutAutoBackgroundedAfterMs = effectiveTimeout
    void startBackgrounding(backgroundFn as unknown as (id: string) => void)
  })

  const budget = armForegroundBudget({
    budgetMs: ASSISTANT_BLOCKING_BUDGET_MS,
    enabled: shouldAutoBackground && isAssistantModeActive(),
    resultPromise: shellCommand.result,
    signal: abortController.signal,
    onBudgetExceeded: () => {
      assistantAutoBackgrounded = true
      void startBackgrounding()
    },
  })
  void budget

  if (input.run_in_background && !BACKGROUND_TASKS_DISABLED) {
    const handle = await spawnShellTask(
      { command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.toolUseId, agentId: agentId as never },
      { abortController, getAppState: () => { throw new Error('spawn must not read app state') }, setAppState: context.setAppState },
    )
    return { stdout: '', stderr: '', interrupted: false, backgroundTaskId: handle.taskId }
  }

  // ONE completion promise for the whole run (the bash twin's law): the
  // quiet window and every progress-loop iteration race the same instance,
  // and the quiet timer is CLEARED when the command wins the race.
  const completed = shellCommand.result.then(() => 'done' as const)
  let quietTimerHandle: ReturnType<typeof setTimeout> | undefined
  const quietTimer = new Promise<'timer'>(resolve => {
    quietTimerHandle = setTimeout(() => resolve('timer'), QUIET_WINDOW_MS)
    if (typeof quietTimerHandle === 'object' && 'unref' in quietTimerHandle) quietTimerHandle.unref()
  })
  const settledEarly = await Promise.race([completed, quietTimer])
  if (settledEarly === 'done') {
    if (quietTimerHandle !== undefined) clearTimeout(quietTimerHandle)
    const result = await shellCommand.result
    shellCommand.cleanup()
    return await postProcess(result)
  }
  if (backgroundId !== undefined) {
    return { stdout: '', stderr: '', interrupted: false, backgroundTaskId: backgroundId, assistantAutoBackgrounded, timeoutAutoBackgroundedAfterMs }
  }

  TaskOutput.startPolling(shellCommand.taskOutput.taskId)
  const startedAt = Date.now()
  let interruptBackgroundingStarted = false
  try {
    while (true) {
      const progressSignal = new Promise<'progress'>(resolve => { progressResolve = () => resolve('progress') })
      const outcome = await Promise.race([completed, progressSignal])
      const settled = outcome === 'done' ? await shellCommand.result : null

      if (settled && settled.backgroundTaskId !== undefined) {
        markTaskNotified(settled.backgroundTaskId, context.setAppState)
        const reconstructed = settled.outputFilePath && !shellCommand.taskOutput.outputFileRedundant ? { ...settled } : settled
        shellCommand.cleanup()
        return await postProcess({ ...reconstructed, backgroundTaskId: undefined })
      }
      if (settled) {
        if (foregroundTaskId !== null) unregisterForeground(foregroundTaskId, context.setAppState)
        shellCommand.cleanup()
        return await postProcess(settled)
      }

      // Interrupt steer (parity with the Bash twin's interrupt-backgrounding branch).
      if (!interruptBackgroundingStarted && abortController.signal.reason === 'interrupt') {
        interruptBackgroundingStarted = true
        if (BACKGROUND_TASKS_DISABLED) shellCommand.kill()
        else { await startBackgrounding(); continue }
      }
      if (backgroundId !== undefined) {
        const fullOutput = latest.all
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '', interrupted: false, backgroundTaskId: backgroundId,
          assistantAutoBackgrounded, timeoutAutoBackgroundedAfterMs,
        }
      }
      if (foregroundTaskId !== null && shellCommand.status === 'backgrounded') {
        return { stdout: '', stderr: '', interrupted: false, backgroundTaskId: foregroundTaskId, backgroundedByUser: true }
      }

      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      if (!BACKGROUND_TASKS_DISABLED && backgroundId === undefined && Date.now() - startedAt >= QUIET_WINDOW_MS && context.setToolJSX) {
        if (foregroundTaskId === null) {
          foregroundTaskId = registerForeground({ command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.toolUseId }, context.setAppState, context.toolUseId)
        }
        context.setToolJSX({ jsx: <BackgroundHint />, shouldHidePromptInput: false, shouldContinueAnimation: true, showSpinner: true })
      }
      let display = latest.recent
      if (elapsedSeconds >= SOFT_TIMEOUT_MS / 1000) {
        const note = requestedTimeout ? `, timing out at ${Math.round(effectiveTimeout / 1000)}s` : ''
        display = `[still running after ${elapsedSeconds}s${note}]\n${display}`
      }
      yield {
        toolUseID: context.toolUseId ?? '',
        data: {
          type: 'powershell_progress', output: display, fullOutput: latest.all,
          elapsedTimeSeconds: elapsedSeconds, totalLines: latest.lines, totalBytes: latest.bytes,
          taskId: foregroundTaskId ?? undefined, ...(requestedTimeout ? { timeoutMs: effectiveTimeout } : {}),
          // LIVENESS: the command's own deadline (default or requested) —
          // the daemon-hosted status row names it beside the elapsed time.
          budgetMs: effectiveTimeout,
        },
      }
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId)
  }

  async function postProcess(result: ExecResult): Promise<Out> {
    // (1) Git metrics only for settled, actually-executed results.
    const notExecuted = result.preSpawnError !== undefined || result.backgroundTaskId !== undefined
    if (!notExecuted) {
      trackGitOperations(input.command, result.code, result.stdout)
    }
    let gitOperation: unknown
    if (!notExecuted && result.code === 0) {
      const classification = detectGitOperation(input.command, `${result.stdout}\n${result.stderr}`)
      if (classification && Object.keys(classification).length > 0) gitOperation = classification
    }

    const interruptedByUser = result.interrupted && abortController.signal.reason === 'interrupt'

    let stderr = ''
    if (isMainThread) {
      const appContext = context.getAppState().toolPermissionContext as ToolPermissionContext
      if (resetCwdIfOutsideProject(appContext)) stderr = stdErrAppendShellResetMessage(stderr)
    }

    // Backgrounded early return.
    if (result.backgroundTaskId !== undefined) {
      return {
        stdout: result.stdout, stderr: [stderr].filter(Boolean).join('\n'), interrupted: false,
        backgroundTaskId: result.backgroundTaskId, backgroundedByUser: result.backgroundedByUser,
        assistantAutoBackgrounded: result.assistantAutoBackgrounded, gitOperation,
      }
    }

    const accumulator = new EndTruncatingAccumulator()
    const trailingTrimmed = result.stdout.trimEnd()
    accumulator.append(trailingTrimmed + '\n')
    let out = stripEmptyLines(accumulator.toString())
    const interpretation = interpretCommandResult(input.command, result.code, trailingTrimmed, result.stderr)

    // Not-started throw BEFORE acting on the exit-code interpretation.
    if (result.preSpawnError) {
      throw new ShellError('', result.preSpawnError, result.code, result.interrupted)
    }
    if (interpretation.isError && !interruptedByUser) {
      const annotated = SandboxManager.annotateStderrWithSandboxFailures(input.command, out)
      throw new ShellError(out, annotated, result.code, result.interrupted)
    }

    // Large-output persistence (after the throws).
    let persistedOutputPath: string | undefined
    let persistedOutputSize: number | undefined
    if (result.outputFilePath && result.outputTaskId) {
      // Awaited async on purpose (the bash twin's law): only spilled outputs
      // reach here, and the link fallback COPIES the large file — the sync
      // spelling froze the cockpit for the copy. Ordering holds: the block
      // completes before the return, the model sees the final path.
      try {
        const stats = await stat(result.outputFilePath)
        persistedOutputSize = stats.size
        const destination = join(getScratchpadDir(), `${result.outputTaskId}.output`)
        if (stats.size > MAX_OUTPUT_BYTES) await truncate(result.outputFilePath, MAX_OUTPUT_BYTES)
        try {
          await link(result.outputFilePath, destination)
        } catch {
          await copyFile(result.outputFilePath, destination)
        }
        persistedOutputPath = destination
      } catch { /* the inline preview is sufficient */ }
    }

    let isImage = isImageOutput(out)
    if (isImage) {
      const resized = await resizeShellImageOutput(out, result.outputFilePath, persistedOutputSize)
      if (resized === null) isImage = false
      else out = resized
    }

    // The tail-keep law, the same cut Bash applies: past the cap the model
    // sees the head AND the tail around one middle notice — a build or test
    // run states its verdict at the end. An image output passes untouched.
    // A spilled result is already TaskOutput's excerpt around its honest
    // byte+path notice — never re-cut into a fabricated line count.
    return {
      stdout: formatOutput(out, { preExcerpted: result.outputFilePath !== undefined }).truncatedContent, stderr, interrupted: result.interrupted, isImage,
      returnCodeInterpretation: interpretation.message, gitOperation,
      ...(persistedOutputPath ? { persistedOutputPath, persistedOutputSize } : {}),
    }
  }
}

// ── mapping to the model-visible result ────────────────────────────────

function mapResultToBlock(output: Out, toolUseID: string): ToolResultBlockParam {
  if (output.isImage) {
    const image = buildImageToolResult(output.stdout, toolUseID)
    if (image) return image
  }
  let stdout = output.stdout.replace(/^\s*\n/g, '').trimEnd()
  if (output.persistedOutputPath) {
    // The preview keeps the head AND the tail (the message labels it so) —
    // the head-only slice under that label sent the model to the file for
    // the verdict every long run states at its end.
    const { preview, hasMore } = generatePreview(stdout, PREVIEW_SIZE_CHARS)
    stdout = buildLargeToolResultMessage({
      filepath: output.persistedOutputPath, originalSize: output.persistedOutputSize ?? 0,
      isJson: false, preview, hasMore,
    })
  }
  let errorText = output.stderr.trimEnd()
  if (output.interrupted) errorText += `\n<error>The command was cut short before it finished.</error>`
  const backgroundNotice = output.backgroundTaskId ? backgroundNoticeFor(output) : ''
  const content = [stdout, errorText, backgroundNotice].filter(p => p !== '').join('\n')
  return { tool_use_id: toolUseID, type: 'tool_result', content, is_error: output.interrupted }
}

function backgroundNoticeFor(output: Out): string {
  const id = output.backgroundTaskId as string
  const outputPath = getTaskOutputPath(id)
  if (output.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${id}. It is still running — you will be notified when it completes. Output: ${outputPath}. Delegate long-running work to a sub-agent, or use run_in_background, to keep the conversation responsive.`
  }
  if (output.backgroundedByUser) return `You moved this command to the background (ID: ${id}). Output: ${outputPath}.`
  return `Running in the background (ID: ${id}). Output: ${outputPath}.`
}

// ── the tool ─────────────────────────────────────────────────────────────────

export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'Executes PowerShell commands.',
  get inputSchema() { return modelInputSchema() },
  maxResultSizeChars: PERSIST_THRESHOLD_CHARS,
  strict: true,
  async description(input: PowerShellToolInput): Promise<string> {
    return input?.description ?? 'Run a PowerShell command'
  },
  async prompt(): Promise<string> { return getPrompt() },
  userFacingName() { return POWERSHELL_TOOL_NAME },
  isConcurrencySafe(input: PowerShellToolInput): boolean { return isPsReadOnly(input) },
  isReadOnly(input: PowerShellToolInput): boolean { return isPsReadOnly(input) },
  isSearchOrReadCommand(input: unknown) {
    const command = stringInputField(input, 'command')
    if (command === undefined) return { isSearch: false, isRead: false }
    const { isSearch, isRead } = isSearchOrRead(command)
    return { isSearch, isRead }
  },
  toAutoClassifierInput(input: PowerShellToolInput): string { return input.command },
  async validateInput(input: PowerShellToolInput) {
    // The Windows sandbox-policy refusal (error code 11) is duplicated here
    // because the `!`-prefix path bypasses input validation.
    if (getPlatform() === 'windows' && input.dangerouslyDisableSandbox && !SandboxManager.areUnsandboxedCommandsAllowed()) {
      return { result: false as const, message: 'Unsandboxed commands are not permitted by policy.', errorCode: 11 }
    }
    // The blocked-sleep gate (error code 10).
    if (sleepGatePreconditions(input)) {
      const blocked = detectSleep(input.command)
      if (blocked) {
        return {
          result: false as const,
          message: `${blocked}\nBlocked: use the Monitor tool with an until-loop to wait for a condition (Monitor runs bash), or run_in_background to wait on a command you already started. Do not chain shorter sleeps to defeat this block.`,
          errorCode: 10,
        }
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: PowerShellToolInput, context: ToolUseContext) {
    return powershellToolHasPermission(input, context)
  },
  async call(
    input: PowerShellToolInput,
    context: ToolUseContext,
    _canUseTool?: unknown,
    _parentMessage?: unknown,
    onProgress?: (progress: { toolUseID: string; data: PowerShellProgress }) => void,
  ): Promise<ToolResult<Out>> {
    const agentId = context.agentId as string | undefined
    try {
      const generator = runPowerShell(input, context, agentId)
      let counter = 0
      let step = await generator.next()
      while (!step.done) {
        counter++
        onProgress?.({ toolUseID: `${context.toolUseId ?? 'pwsh'}-${counter}`, data: step.value.data })
        step = await generator.next()
      }
      return { data: step.value }
    } finally {
      context.setToolJSX?.(null)
    }
  },
  mapToolResultToToolResultBlockParam(output: Out, toolUseID: string) { return mapResultToBlock(output, toolUseID) },
  extractSearchText(output: Out): string { return output.stderr ? `${output.stdout}\n${output.stderr}` : output.stdout },
  // Truncation is reported the way every other tool reports it: the shared
  // terminal line-truncation predicate over the RAW output. The render-time
  // ellipsis marker never appears in the output this method receives.
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr)
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

/** isReadOnly: sync security heuristics first, then the AST-less read-only allowlist. */
function isPsReadOnly(input: PowerShellToolInput): boolean {
  if (hasSyncSecurityConcerns(input.command)) return false
  return isReadOnlyCommand(input.command)
}

/** The sleep-gate preconditions: monitor surface live, git-bash available, background enabled, not backgrounded. */
function sleepGatePreconditions(input: PowerShellToolInput): boolean {
  if (BACKGROUND_TASKS_DISABLED || input.run_in_background) return false
  // The Monitor tool is always-on, so the scheduler/monitor surface is live.
  return isGitBashAvailable()
}

/** validateInput runs the probe on every call and the scan stats dozens of
 *  directories; the (PATH, override) pair changing is the only way the
 *  answer changes without a restart, so the verdict is cached per pair. */
let gitBashProbe: { key: string; available: boolean } | null = null

/** Non-throwing git-bash availability probe. */
function isGitBashAvailable(): boolean {
  if (getPlatform() !== 'windows') return true
  const probeKey = `${process.env.PATH ?? ''}\u0000${process.env.MERCURY_GIT_BASH_PATH ?? ''}`
  if (gitBashProbe !== null && gitBashProbe.key === probeKey) {
    return gitBashProbe.available
  }
  const available = scanForGitBash()
  gitBashProbe = { key: probeKey, available }
  return available
}

function scanForGitBash(): boolean {
  const override = process.env.MERCURY_GIT_BASH_PATH
  if (override && existsSync(override)) return true
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  const candidates = [
    ...dirs.map(d => join(d, 'git.exe')),
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  ]
  for (const gitExe of candidates) {
    try {
      if (existsSync(gitExe)) {
        const bash = join(gitExe.replace(/cmd[\\/]git\.exe$/i, ''), 'bin', 'bash.exe')
        if (existsSync(bash)) return true
      }
    } catch { /* probe must not throw */ }
  }
  return false
}
