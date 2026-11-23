import { z } from 'zod/v4'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { buildTool, stringInputField, type Tool, type ToolDef, type ToolUseContext, type ToolResult } from '../../Tool.js'
import { POWERSHELL_TOOL_NAME } from '../../constants/tools/powershell.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlatform } from '../../utils/platform.js'
import { exec, resolveShellCwd } from '../../utils/Shell.js'
import { sessionEnvNoticeForResult } from '../shared/sessionEnvNotice.js'
import type { ExecResult } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from '../../tasks/LocalShellTask/LocalShellTask.js'
import { ShellError, errorMessage } from '../../utils/errors.js'
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js'
import { detectGitOperation, trackGitOperations } from '../../tools/shared/gitOperationTracking.js'
import { buildLargeToolResultMessage, generatePreview, PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'
import { interpretCommandResult } from './commandSemantics.js'
import { describeTimeout, getPrompt, getDefaultTimeoutMs, getMaxTimeoutMs } from './prompt.js'
import { describeCommandDescription, describeMaxOutputChars, describeRunInBackground } from '../BashTool/prompt.js'
import { resolveOutputBudget } from '../../utils/shell/outputLimits.js'
import { windowedError } from '../../utils/toolErrors.js'
import { getCachedPowerShellPath } from '../../utils/shell/powershellDetection.js'
import { firstCommandWord } from '../../utils/shell/shellToolUtils.js'
import { powershellToolHasPermission } from './powershellPermissions.js'
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical, stripPowerShellQuotes } from './readOnlyValidation.js'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'
import {
  BackgroundHint,
} from '../BashTool/UI.js'
import {
  applyShellOutputFilter,
  buildImageToolResult,
  formatExcerpt,
  formatOutput,
  redactedCopy,
  isImageOutput,
  outputBudgetClause,
  resizeShellImageOutput,
  stripEmptyLines,
} from '../../utils/shell/utils.js'
import { maxOutputCharsField, readMaxOutputChars, refuseMaxOutputChars } from '../BashTool/maxOutputChars.js'
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
import { stat, truncate } from 'node:fs/promises'
import { createShellResultRedactor } from '../../utils/redactSecrets.js'
import { controlCharacterPathRefusal } from '../../utils/path.js'
import { join } from 'node:path'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { pinnedGitBash } from '../../utils/windowsPaths.js'
import { passedOver } from '../../utils/passedOver.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { withDeadline } from '../../utils/deadline.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'


const SLEEP_THRESHOLD_SECONDS = 2

function detectBlockedSleepPattern(command: string): string | null {
  const trimmed = command.trim()
  const firstStatement = (trimmed.split(/[;|&\r\n]/)[0] ?? '').trim()
  const match = firstStatement.match(/^(?:start-sleep|sleep)(?:\s+(?:-s(?:econds)?)?\s*)?(\d+(?:\.\d+)?)\s*$/i)
  if (!match) return null
  const seconds = parseFloat(match[1])
  if (seconds < SLEEP_THRESHOLD_SECONDS) return null
  const remainder = trimmed.slice(firstStatement.length).trim()
  return remainder
    ? `A leading Start-Sleep of ${seconds}s (followed by "${remainder}") was blocked.`
    : `A standalone Start-Sleep of ${seconds}s was blocked.`
}

const detectSleep = detectBlockedSleepPattern


const QUIET_WINDOW_MS = 2_000
const SOFT_TIMEOUT_MS = 30_000
const PERSIST_THRESHOLD_CHARS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const BACKGROUND_TASKS_DISABLED = false
const NEVER_AUTO_BACKGROUND = new Set(['start-sleep', 'sleep'])


function buildModelSchema() {
  return z.strictObject({
    command: z.string().describe('The PowerShell command to execute'),
    cwd: z.string().optional().describe('Run in this directory: absolute, or relative to the starting folder; the session directory stays.'),
    timeout: semanticNumber(z.number().optional()).describe(describeTimeout()),
    description: z.string().optional().describe(describeCommandDescription()),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(describeRunInBackground()),
    inherit_session_env: semanticBoolean(z.boolean().optional()).describe("Hand the command the session's own MERCURY_* values; by default they are scrubbed, so a build or a proof never sees them."),
    max_output_chars: maxOutputCharsField.describe(describeMaxOutputChars()),
  })
}
const modelInputSchema = lazySchema(buildModelSchema)
type ModelInput = z.infer<ReturnType<typeof buildModelSchema>>
type PowerShellToolInput = ModelInput

type Out = {
  stdout: string
  stderr: string
  interrupted: boolean
  isImage?: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  timeoutAutoBackgroundedAfterMs?: number
  preSpawnError?: string
  returnCodeInterpretation?: string
  persistedOutputPath?: string
  persistedOutputSize?: number
  gitOperation?: unknown
  scrubbedSessionEnv?: readonly string[]
  sessionEnvNotice?: string
  outputBudgetNotice?: string
  outputCopyNotice?: string
}


const NEUTRAL = new Set(['write-output', 'write-host'])
const SEARCH = new Set(['select-string', 'get-childitem', 'findstr', 'where.exe'])
const READ = new Set(['get-content', 'get-item', 'test-path', 'resolve-path', 'get-process', 'get-service', 'get-childitem', 'get-location', 'get-filehash', 'get-acl', 'format-hex'])

function isSearchOrRead(command: string): { isSearch: boolean; isRead: boolean } {
  const trimmed = command.trim()
  if (trimmed === '') return { isSearch: false, isRead: false }
  if (hasSyncSecurityConcerns(trimmed)) return { isSearch: false, isRead: false }
  const unquoted = stripPowerShellQuotes(trimmed)
  const withoutSafeRedirects = unquoted.replace(/[0-9*]?>>?(?:&\d|[ \t]*\$null(?=$|[\s;|\r\n&]))/gi, '')
  if (withoutSafeRedirects.includes('>')) return { isSearch: false, isRead: false }
  let isSearch = false, isRead = false, sawReal = false
  for (const fragment of withoutSafeRedirects.split(/[;|\r\n]|&&|\|\|/)) {
    const first = fragment.trim().split(/\s+/)[0]
    if (!first) continue
    const lower = first.toLowerCase()
    const canonical = lower.includes('.') ? lower : resolveToCanonical(first)
    if (NEUTRAL.has(canonical)) continue
    if (!SEARCH.has(canonical) && !READ.has(canonical)) return { isSearch: false, isRead: false }
    sawReal = true
    if (SEARCH.has(canonical)) isSearch = true
    if (READ.has(canonical)) isRead = true
  }
  return sawReal ? { isSearch, isRead } : { isSearch: false, isRead: false }
}

function backgroundNoticeFor(id: string, backgroundedByUser?: boolean): string {
  const outputPath = getTaskOutputPath(id)
  if (backgroundedByUser) return `You moved this command to the background (ID: ${id}). Output: ${outputPath}.`
  return `Running in the background (ID: ${id}). Output: ${outputPath}.`
}


const SLEEP_REFUSAL_HINT = 'Blocked: use the Monitor tool with an until-loop to wait for a condition (Monitor runs bash), or run_in_background to wait on a command you already started. Do not chain shorter sleeps to defeat this block.'

async function postProcessPowerShell(
  result: ExecResult,
  input: PowerShellToolInput,
  context: ToolUseContext,
  shellCommand: ShellCommand | undefined,
): Promise<Out> {
  let prLinkNote: string | undefined
  let gitOperation: unknown
  if (result.backgroundTaskId === undefined && !result.preSpawnError) {
    prLinkNote = await trackGitOperations(input.command, result.code, result.stdout)
    if (result.code === 0) {
      gitOperation = detectGitOperation(input.command, result.stdout)
    }
  }

  const trimmedStdout = result.stdout.trimEnd()
  const trimmedStderr = result.stderr.trimEnd()
  const accumulator = new EndTruncatingAccumulator()
  if (trimmedStdout !== '') accumulator.append(trimmedStdout)
  if (trimmedStderr !== '') accumulator.append((accumulator.length > 0 ? '\n' : '') + trimmedStderr)
  if (prLinkNote) accumulator.append((accumulator.length > 0 ? '\n' : '') + prLinkNote)

  const redact = createShellResultRedactor()
  let out = redact(accumulator.toString())
  if (shellCommand !== undefined) {
    out = await applyShellOutputFilter(out, {
      taskId: shellCommand.taskOutput.taskId,
      spilledPath: result.outputFilePath,
    })
  }
  const budget = resolveOutputBudget(readMaxOutputChars(input.max_output_chars))
  const windowed = result.outputFilePath === undefined
  const clause = outputBudgetClause(budget)
  const outputBudgetNotice = windowed ? clause : undefined

  if (result.preSpawnError) {
    throw new ShellError('', result.preSpawnError, result.code, false, false)
  }

  const interpretation = interpretCommandResult(input.command, result.code, trimmedStdout, trimmedStderr)
  const interruptedByUser = result.interrupted && context.abortController.signal.reason === 'interrupt'
  if (interpretation.isError && !interruptedByUser) {
    const thrown =
      budget.requested === undefined
        ? out
        : windowed
          ? formatOutput(out, { maxLength: budget.effective }).truncatedContent
          : formatExcerpt(out, budget.effective)
    const notice = sessionEnvNoticeForResult({
      scrubbed: shellCommand?.scrubbedSessionEnv,
      commandText: input.command,
    })
    const error = new ShellError(
      '',
      [thrown, clause].filter(Boolean).join('\n'),
      result.code,
      result.interrupted,
      true,
      notice,
    )
    throw budget.requested === undefined ? error : windowedError(error)
  }

  let persistedOutputPath: string | undefined
  let persistedOutputSize: number | undefined
  let outputCopyNotice: string | undefined
  if (result.outputFilePath && result.outputTaskId) {
    try {
      const stats = await stat(result.outputFilePath)
      persistedOutputSize = stats.size
      const destination = join(getScratchpadDir(), `${result.outputTaskId}.output`)
      if (stats.size > MAX_OUTPUT_BYTES) await truncate(result.outputFilePath, MAX_OUTPUT_BYTES)
      await redactedCopy(result.outputFilePath, destination, redact)
      persistedOutputPath = destination
    } catch (error) {
      outputCopyNotice = `[the full output could not be kept for reading (${errorMessage(error)}); only the excerpt above is shown — send the output to a file to read all of it]`
    }
  }

  out = stripEmptyLines(out)

  let isImage = isImageOutput(out)
  if (isImage) {
    const resized = await resizeShellImageOutput(out, result.outputFilePath, persistedOutputSize)
    if (resized === null) {
      isImage = false
    } else {
      out = resized
    }
  }

  const formatted = formatOutput(out, {
    preExcerpted: result.outputFilePath !== undefined,
    maxLength: budget.effective,
  })
  return {
    stdout: formatted.truncatedContent,
    stderr: '',
    interrupted: result.interrupted,
    isImage,
    ...(interpretation.message !== undefined ? { returnCodeInterpretation: interpretation.message } : {}),
    ...(gitOperation !== undefined ? { gitOperation } : {}),
    ...(outputBudgetNotice !== undefined ? { outputBudgetNotice } : {}),
    ...(outputCopyNotice !== undefined ? { outputCopyNotice } : {}),
    ...(persistedOutputPath !== undefined ? { persistedOutputPath } : {}),
    ...(persistedOutputSize !== undefined ? { persistedOutputSize } : {}),
    ...(shellCommand?.scrubbedSessionEnv && shellCommand.scrubbedSessionEnv.length > 0
      ? { scrubbedSessionEnv: shellCommand.scrubbedSessionEnv }
      : {}),
  }
}

function buildBackgroundOut(
  backgroundTaskId: string,
  scrubbed: readonly string[] | undefined,
  opts?: { stdout?: string; backgroundedByUser?: boolean; timeoutAutoBackgroundedAfterMs?: number },
): Out {
  return {
    stdout: opts?.stdout ?? '',
    stderr: '',
    interrupted: false,
    backgroundTaskId,
    ...(opts?.backgroundedByUser ? { backgroundedByUser: true } : {}),
    ...(opts?.timeoutAutoBackgroundedAfterMs !== undefined ? { timeoutAutoBackgroundedAfterMs: opts.timeoutAutoBackgroundedAfterMs } : {}),
    ...(scrubbed && scrubbed.length > 0 ? { scrubbedSessionEnv: scrubbed } : {}),
  }
}
function createWakeSignal(): {
  wake: () => void
  wait: () => Promise<void>
  clear: () => void
} {
  let woken = false
  let notify: (() => void) | null = null
  return {
    wake() {
      woken = true
      const fn = notify
      notify = null
      fn?.()
    },
    wait() {
      if (woken) {
        woken = false
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        notify = () => {
          woken = false
          resolve()
        }
      })
    },
    clear() {
      notify = null
    },
  }
}
async function* executePowerShell(
  input: PowerShellToolInput,
  context: ToolUseContext,
  agentId?: string,
): AsyncGenerator<PowerShellProgress, Out> {
  const setTaskState = context.setAppStateForTasks ?? context.setAppState
  const setToolJSX = context.setToolJSX
  const requestedTimeout = input.timeout
  const effectiveTimeout = Math.min(requestedTimeout || getDefaultTimeoutMs(), getMaxTimeoutMs())
  const firstSubcommand = pinnedCommandAnalysis.splitCommand(input.command)[0]?.trim() ?? input.command.trim()
  const firstWord = resolveToCanonical(firstCommandWord(firstSubcommand)).toLowerCase()
  const shouldAutoBackground = !BACKGROUND_TASKS_DISABLED && !NEVER_AUTO_BACKGROUND.has(firstWord)
  const explicitCwd = input.cwd !== undefined ? resolveShellCwd(input.cwd) : undefined
  const launchedAt = Date.now()

  const psPath = await getCachedPowerShellPath()
  if (!psPath) {
    const unavailable: ExecResult = {
      stdout: '',
      stderr: 'PowerShell is unavailable on this system.',
      code: 127,
      interrupted: false,
      preSpawnError: 'PowerShell is unavailable on this system. Install PowerShell 7 (pwsh) to enable PowerShell commands.',
    }
    return await postProcessPowerShell(unavailable, input, context, undefined)
  }

  let latest = { recent: '', all: '', lines: 0, bytes: 0, incomplete: false }
  const wakeSignal = createWakeSignal()
  const wakeProgress = wakeSignal.wake
  const waitForWake = wakeSignal.wait
  const clearWakeWaiter = wakeSignal.clear
  let shellCommand: ShellCommand
  try {
    shellCommand = await exec(input.command, context.abortController.signal, 'powershell', {
      timeout: effectiveTimeout,
      shouldAutoBackground,
      backgroundIntent: !BACKGROUND_TASKS_DISABLED && Boolean(input.run_in_background),
      ...(explicitCwd !== undefined ? { cwd: explicitCwd } : {}),
      preventCwdChanges: explicitCwd !== undefined || agentId !== undefined,
      inheritSessionEnv: input.inherit_session_env === true,
      onProgress: (recentLines, allLines, numLines, numBytes, incomplete) => {
        latest = { recent: recentLines, all: allLines, lines: numLines, bytes: numBytes, incomplete }
        wakeProgress()
      },
    })
  } catch (error) {
    const msg = errorMessage(error)
    const failed: ExecResult = {
      stdout: '',
      stderr: `The PowerShell command failed to execute: ${msg}`,
      code: 127,
      interrupted: false,
      preSpawnError: `The PowerShell command failed to execute: ${msg}`,
    }
    return await postProcessPowerShell(failed, input, context, undefined)
  }

  const scrubbed = shellCommand.scrubbedSessionEnv
  let backgroundId: string | undefined
  let foregroundTaskId: string | undefined
  let timeoutAutoBackgroundedAfterMs: number | undefined
  let interruptHandled = false
  let hintShown = false

  let handoverPromise: Promise<string | undefined> | null = null
  let resolveBackgroundAssigned: (() => void) | null = null
  const backgroundAssignedPromise = new Promise<void>(resolve => {
    resolveBackgroundAssigned = resolve
  })

  const tryBackground = (onAccepted?: (taskId: string) => void): Promise<string | undefined> => {
    if (handoverPromise !== null) return handoverPromise
    handoverPromise = (async () => {
      if (backgroundId !== undefined) return backgroundId
      const description = input.description || input.command
      if (foregroundTaskId !== undefined) {
        const ok = backgroundExistingForegroundTask(
          foregroundTaskId,
          shellCommand,
          description,
          setTaskState,
          context.toolUseId,
          {
            command: input.command,
            description,
            agentId,
            cwd: explicitCwd ?? resolveShellCwd(),
            startTime: launchedAt,
            toolUseId: context.toolUseId,
          },
        )
        if (ok) {
          const accepted = foregroundTaskId
          backgroundId = accepted
          foregroundTaskId = undefined
          onAccepted?.(accepted)
          resolveBackgroundAssigned?.()
          resolveBackgroundAssigned = null
          wakeProgress()
          return accepted
        }
        return undefined
      }
      const handle = await spawnShellTask(
        {
          command: input.command,
          description,
          timeout: effectiveTimeout,
          toolUseId: context.toolUseId,
          agentId,
          shellCommand,
          startTime: launchedAt,
        },
        {
          abortController: context.abortController,
          getAppState: () => {
            throw new Error('spawn must not read app state')
          },
          setAppState: setTaskState,
        },
      )
      if (handle.accepted !== false) {
        const accepted: string = handle.taskId
        backgroundId = accepted
        onAccepted?.(accepted)
        resolveBackgroundAssigned?.()
        resolveBackgroundAssigned = null
        wakeProgress()
        return accepted
      }
      return undefined
    })()
    return handoverPromise
  }

  if (shouldAutoBackground && !input.run_in_background) {
    shellCommand.onTimeout?.((bg: (taskId: string) => boolean) => {
      timeoutAutoBackgroundedAfterMs = effectiveTimeout
      void tryBackground(taskId => {
        bg(taskId)
      })
    })
  }
  if (!BACKGROUND_TASKS_DISABLED && input.run_in_background) {
    const acceptedId = await tryBackground()
    if (acceptedId !== undefined) return buildBackgroundOut(acceptedId, scrubbed)
    const res = await shellCommand.result
    shellCommand.cleanup()
    return await postProcessPowerShell(res, input, context, shellCommand)
  }

  const onAbort = (): void => {
    wakeProgress()
  }
  context.abortController.signal.addEventListener('abort', onAbort, { once: true })

  let settledResult: ExecResult | undefined
  void shellCommand.result.then((res: ExecResult) => {
    settledResult = res
    wakeProgress()
  })

  const quietWinner = await withDeadline(
    Promise.race([
      shellCommand.result.then(res => ({ kind: 'done' as const, res })),
      backgroundAssignedPromise.then(() => ({ kind: 'bg' as const })),
    ]),
    QUIET_WINDOW_MS,
    () => ({ kind: 'timeout' as const }),
    { unref: true },
  )
  if (quietWinner.kind === 'done') {
    context.abortController.signal.removeEventListener('abort', onAbort)
    if (quietWinner.res.backgroundTaskId) {
      markTaskNotified(quietWinner.res.backgroundTaskId, setTaskState)
      quietWinner.res.backgroundTaskId = undefined
    }
    shellCommand.cleanup()
    return await postProcessPowerShell(quietWinner.res, input, context, shellCommand)
  }
  if (backgroundId !== undefined) {
    context.abortController.signal.removeEventListener('abort', onAbort)
    return buildBackgroundOut(backgroundId, scrubbed, { timeoutAutoBackgroundedAfterMs })
  }

  const pollStart = Date.now()
  const pollTaskId = shellCommand.taskOutput.taskId
  TaskOutput.startPolling(pollTaskId)
  try {
    for (;;) {
      if (settledResult !== undefined) {
        let finalResult = settledResult
        if (finalResult.backgroundTaskId) {
          markTaskNotified(finalResult.backgroundTaskId, setTaskState)
          finalResult = { ...finalResult, backgroundTaskId: undefined }
        } else if (foregroundTaskId !== undefined) {
          unregisterForeground(foregroundTaskId, setTaskState)
          foregroundTaskId = undefined
        }
        shellCommand.cleanup()
        return await postProcessPowerShell(finalResult, input, context, shellCommand)
      }

      if (context.abortController.signal.aborted && context.abortController.signal.reason === 'interrupt' && !interruptHandled) {
        interruptHandled = true
        if (BACKGROUND_TASKS_DISABLED) {
          shellCommand.kill()
        } else {
          const accepted = await tryBackground()
          if (accepted !== undefined) return buildBackgroundOut(accepted, scrubbed, { stdout: latest.all })
          shellCommand.kill()
        }
      }

      if (backgroundId !== undefined) {
        return buildBackgroundOut(backgroundId, scrubbed, { timeoutAutoBackgroundedAfterMs })
      }

      if (foregroundTaskId !== undefined && shellCommand.status === 'backgrounded') {
        const movedId = foregroundTaskId
        foregroundTaskId = undefined
        return buildBackgroundOut(movedId, scrubbed, { backgroundedByUser: true })
      }

      const elapsedMs = Date.now() - pollStart
      if (
        !hintShown &&
        !BACKGROUND_TASKS_DISABLED &&
        backgroundId === undefined &&
        shellCommand.status !== 'backgrounded' &&
        elapsedMs >= QUIET_WINDOW_MS &&
        setToolJSX
      ) {
        hintShown = true
        if (foregroundTaskId === undefined) {
          foregroundTaskId = registerForeground(
            {
              command: input.command,
              description: input.description || input.command,
              timeout: effectiveTimeout,
              toolUseId: context.toolUseId,
              agentId,
              shellCommand,
            },
            setTaskState,
            context.toolUseId,
          )
        }
        setToolJSX({
          jsx: <BackgroundHint onBackground={wakeProgress} />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        })
      }

      const elapsedTimeSeconds = Math.floor(elapsedMs / 1000)
      let output = latest.recent
      if (elapsedMs >= SOFT_TIMEOUT_MS) {
        const timeoutPart = requestedTimeout ? `, timing out at ${Math.round(effectiveTimeout / 1000)}s` : ''
        const banner = `[still running after ${elapsedTimeSeconds}s${timeoutPart}]`
        output = `${banner}\n${output}`
      }
      yield {
        type: 'powershell_progress',
        output,
        fullOutput: latest.all,
        elapsedTimeSeconds,
        totalLines: latest.lines,
        totalBytes: latest.incomplete ? latest.bytes : 0,
        taskId: foregroundTaskId ?? pollTaskId,
        ...(requestedTimeout ? { timeoutMs: requestedTimeout } : {}),
        budgetMs: effectiveTimeout,
      }

      await withDeadline(waitForWake(), 1_000, clearWakeWaiter, { unref: true })
    }
  } finally {
    TaskOutput.stopPolling(pollTaskId)
    context.abortController.signal.removeEventListener('abort', onAbort)
    if (foregroundTaskId !== undefined && shellCommand.status !== 'backgrounded') {
      unregisterForeground(foregroundTaskId, setTaskState)
    }
  }
}

export const PowerShellTool: Tool<PowerShellToolInput, Out, PowerShellProgress> = buildTool({
  name: POWERSHELL_TOOL_NAME,
  strict: true,
  searchHint: 'Executes PowerShell commands.',
  maxResultSizeChars: PERSIST_THRESHOLD_CHARS,
  straightQuoteInputs: ['command'],
  get inputSchema() {
    return modelInputSchema()
  },
  async description(input: Partial<PowerShellToolInput> | undefined) {
    return input?.description ?? 'Run a PowerShell command'
  },
  async prompt() {
    return getPrompt()
  },
  shellCommandOf(input: unknown) {
    return stringInputField(input, 'command')
  },
  isConcurrencySafe(input: unknown) {
    const command = stringInputField(input, 'command')
    if (!command) return false
    if (hasSyncSecurityConcerns(command)) return false
    return isReadOnlyCommand(command)
  },
  isReadOnly(input: unknown) {
    const command = stringInputField(input, 'command')
    if (!command) return false
    if (hasSyncSecurityConcerns(command)) return false
    return isReadOnlyCommand(command)
  },
  isSearchOrReadCommand(input: unknown) {
    const command = stringInputField(input, 'command')
    if (!command) return { isSearch: false, isRead: false }
    return isSearchOrRead(command)
  },
  checkPermissions(input: PowerShellToolInput, context: ToolUseContext) {
    return powershellToolHasPermission(input, context)
  },
  async validateInput(input: PowerShellToolInput) {
    const cwdRefusal = controlCharacterPathRefusal(input.cwd)
    if (cwdRefusal !== null) {
      return { result: false, message: cwdRefusal, errorCode: 1 }
    }
    if (sleepGatePreconditions(input)) {
      const blocked = detectSleep(input.command)
      if (blocked !== null) {
        return { result: false, message: `${blocked}\n${SLEEP_REFUSAL_HINT}`, errorCode: 10 }
      }
    }
    const maxOutputRefusal = refuseMaxOutputChars(input.max_output_chars)
    if (maxOutputRefusal !== undefined) {
      return { result: false, message: maxOutputRefusal, errorCode: 2 }
    }
    return { result: true }
  },
  async call(input, context, _canUseTool, _parentAssistantMessage, onProgress): Promise<ToolResult<Out>> {
    const setToolJSX = context.setToolJSX
    try {
      const generator = executePowerShell(input, context, context.agentId)
      let progressCount = 0
      for (;;) {
        const step = await generator.next()
        if (step.done) {
          const data = step.value
          const envNotice = sessionEnvNoticeForResult({
            scrubbed: data.scrubbedSessionEnv,
            commandText: input.command,
          })
          if (envNotice !== '') {
            data.sessionEnvNotice = envNotice
          }
          return { data }
        }
        progressCount += 1
        onProgress?.({
          toolUseID: `${context.toolUseId || 'pwsh'}-${progressCount}`,
          data: step.value,
        })
      }
    } finally {
      setToolJSX?.(null)
    }
  },
  mapToolResultToToolResultBlockParam(output: Out, toolUseID: string): ToolResultBlockParam {
    if (output.isImage) {
      const image = buildImageToolResult(output.stdout, toolUseID)
      if (image) return image
    }
    let stdout = output.stdout.replace(/^\s*\n/g, '').trimEnd()
    if (output.persistedOutputPath) {
      const { preview, hasMore } = generatePreview(stdout, PREVIEW_SIZE_CHARS, output.persistedOutputSize)
      stdout = buildLargeToolResultMessage({
        filepath: output.persistedOutputPath,
        originalSize: output.persistedOutputSize ?? 0,
        isJson: false,
        preview,
        hasMore,
      })
    }
    let errorText = output.stderr.trimEnd()
    if (output.interrupted) {
      errorText += '\n<error>The command was cut short before it finished.</error>'
    }
    const backgroundNotice = output.backgroundTaskId ? backgroundNoticeFor(output.backgroundTaskId, output.backgroundedByUser) : ''
    const content = [
      stdout,
      errorText,
      output.outputBudgetNotice ?? '',
      output.outputCopyNotice ?? '',
      backgroundNotice,
      output.sessionEnvNotice ?? '',
    ]
      .filter(part => part !== '')
      .join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      is_error: output.interrupted,
    }
  },
  extractSearchText(output: Out): string {
    return output.stderr ? `${output.stdout}\n${output.stderr}` : output.stdout
  },
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr)
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
} satisfies ToolDef<ReturnType<typeof buildModelSchema>, Out, PowerShellProgress>)

function sleepGatePreconditions(input: PowerShellToolInput): boolean {
  if (BACKGROUND_TASKS_DISABLED || input.run_in_background) return false
  return isGitBashAvailable()
}

let gitBashProbe: { key: string; available: boolean } | null = null

function isGitBashAvailable(): boolean {
  if (getPlatform() !== 'windows') return true
  const probeKey = `${hostEnv().PATH ?? ''}\u0000${flagEnv('MERCURY_GIT_BASH_PATH') ?? ''}`
  if (gitBashProbe !== null && gitBashProbe.key === probeKey) {
    return gitBashProbe.available
  }
  const available = scanForGitBash()
  gitBashProbe = { key: probeKey, available }
  return available
}

function scanForGitBash(): boolean {
  if (pinnedGitBash() !== null) return true
  const dirs = (hostEnv().PATH ?? '').split(';').filter(Boolean)
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
    } catch (error) { passedOver(error) }
  }
  return false
}
