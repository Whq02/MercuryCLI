import { z } from 'zod/v4'
import { buildTool, stringInputField, type ToolUseContext, type ToolResult, type ToolPermissionContext } from '../../Tool.js'
import { loginFilesLineOnce, settleShellRecord } from '../../utils/shell/shellRecord.js'
import { bashToolAvailable } from '../../utils/shell/windowsShellRoad.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isRunInputClosed } from '../../bootstrap/state.js'
import { SLEEP_TOOL_NAME } from '../SleepTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { exec, resolveShellCwd, settleLoginFiles, signalsCountIn, terminalShellInvocation } from '../../utils/Shell.js'
import { captureVerificationStart } from '../../utils/verification/verificationState.js'
import { processOwnerForLane } from '../../services/run/resolveOwner.js'
import { execViaIdeTerminal, IdeTerminalUnavailableError, ideTerminalAvailable } from '../../services/acp/ideToolBridge.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
  type ShellLaunchFacts,
} from '../../tasks/LocalShellTask/LocalShellTask.js'
import { registerShellRun } from './backgroundRequest.js'
import { ShellError, errorMessage } from '../../utils/errors.js'
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js'
import { formatDuration } from '../../utils/format.js'
import { recordBashAudit } from '../../utils/spawnLedger.js'
import { trackGitOperations } from '../../tools/shared/gitOperationTracking.js'
import { sessionEnvNoticeForResult } from '../../tools/shared/sessionEnvNotice.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
} from '../../utils/file.js'
import { exitLine, interpretCommandResult } from './commandSemantics.js'
import { describeCommandDescription, describeMaxOutputChars, describeRunInBackground, describeTimeout, EDITOR_TERMINAL_RESULT_NOTE, getDefaultTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from './prompt.js'
import { firstCommandWord } from '../../utils/shell/shellToolUtils.js'
import { isSedInPlaceEdit, parseSedEditCommand } from './sedEditParser.js'
import { prepareBashReadOnly, preparedBashReadsOnly } from './readOnlyValidation.js'
import { bashToolHasPermission } from './bashPermissions.js'
import {
  parseForSecurity,
  splitCommandWithOperators,
  pinnedCommandAnalysis,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  stripEmptyLines,
  formatOutput,
  isImageOutput,
  formatExcerpt,
  outputBudgetClause,
  resizeShellImageOutput,
  applyShellOutputFilter,
  redactedCopy,
  sayWhatTheShellOwes,
  truncateForSummary,
} from './utils.js'
import { maxOutputCharsField, readMaxOutputChars, refuseMaxOutputChars } from './maxOutputChars.js'
import { resolveOutputBudget } from '../../utils/shell/outputLimits.js'
import { windowedError } from '../../utils/toolErrors.js'
import { userFacingName as fileEditUserFacingName } from '../../tools/FileEditTool/UI.js'
import {
  BackgroundHint,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js'
import type { BashProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../Tool.js'
import { existsSync, readFileSync } from 'node:fs'
import { modifiedSinceReadMessage } from '../FileEditTool/otherSession.js'
import { tailFile } from '../../utils/fsOperations.js'
import { stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { settleCreations, snapshotCreations } from '../../utils/permissions/ownGround.js'
import { controlCharacterPathRefusal, expandPath } from '../../utils/path.js'
import { createShellResultRedactor } from '../../utils/redactSecrets.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { shellWebContentNotice } from './webContent.js'
import { boxLockLineForCommand, commandNamesBoxLock, refreshBoxReading } from '../../utils/boxLock.js'
import { mapResultToBlock } from './resultBlock.js'
import { withDeadline } from '../../utils/deadline.js'



const QUIET_WINDOW_MS = 2_000
const SOFT_TIMEOUT_MS = 30_000
const PERSIST_THRESHOLD_CHARS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const BACKGROUND_TASKS_DISABLED = false

const NEVER_AUTO_BACKGROUND = new Set(['sleep'])
const SLEEP_TIMEOUT_WHY = 'A command whose first word is `sleep` is killed at its timeout instead of moving to the background; to wait longer, pass a larger `timeout` or use the Sleep tool.'


function buildModelSchema() {
  return z.strictObject({
    command: z.string().describe('The command to execute'),
    cwd: z.string().optional().describe('Run in this directory: absolute, or relative to the starting folder; the session directory stays.'),
    timeout: semanticNumber(z.number().optional()).describe(describeTimeout()),
    description: z.string().optional().describe(describeCommandDescription()),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(describeRunInBackground()),
    inherit_session_env: semanticBoolean(z.boolean().optional()).describe(
      "Hand the command the session's own MERCURY_* values; by default they are scrubbed, so a build or a proof never sees them.",
    ),
    max_output_chars: maxOutputCharsField.describe(describeMaxOutputChars()),
  })
}

const modelInputSchema = lazySchema(buildModelSchema)
type ModelInput = z.infer<ReturnType<typeof buildModelSchema>>

type BashToolInput = ModelInput & {
  _simulatedSedEdit?: { filePath: string; newContent: string; beforeBytes: string }
}


type BackgroundLifetime = 'session' | 'turn' | 'crewmate'

export type Out = {
  stdout: string
  stderr: string
  interrupted: boolean
  code?: number
  pipelineStatus?: number[]
  isImage?: boolean
  backgroundTaskId?: string
  backgroundPid?: number
  backgroundLifetime?: BackgroundLifetime
  stopOffered?: boolean
  serviceOffered?: boolean
  sleepOffered?: boolean
  backgroundOutputIsTail?: boolean
  backgroundedByUser?: boolean
  timeoutAutoBackgroundedAfterMs?: number
  returnCodeInterpretation?: string
  exitNote?: string
  timeoutClampNotice?: string
  noOutputExpected?: boolean
  persistedOutputPath?: string
  persistedOutputSize?: number
  structuredContent?: ToolResultBlockParam['content']
  rawOutputPath?: string
  scrubbedSessionEnv?: readonly string[]
  sessionEnvNotice?: string
  outputBudgetNotice?: string
  outputCopyNotice?: string
}


const NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
const SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'])
const LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const REDIRECT_OPERATORS = new Set(['>', '>>', '>&'])
const CONTROL_OPERATORS = new Set(['||', '&&', '|', ';'])
const SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait'])

function isSearchOrReadBashCommand(command: string): { isSearch: boolean; isRead: boolean; isList: boolean } {
  const parts = splitCommandWithOperators(command)
  if (parts.length === 0) return { isSearch: false, isRead: false, isList: false }
  let isSearch = false
  let isRead = false
  let isList = false
  let sawReal = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    if (REDIRECT_OPERATORS.has(part)) {
      i++
      continue
    }
    if (CONTROL_OPERATORS.has(part)) continue
    const base = part.trim().split(/\s+/)[0]
    if (!base) continue
    if (NEUTRAL_COMMANDS.has(base)) continue
    sawReal = true
    if (SEARCH_COMMANDS.has(base)) isSearch = true
    else if (READ_COMMANDS.has(base)) isRead = true
    else if (LIST_COMMANDS.has(base)) isList = true
    else return { isSearch: false, isRead: false, isList: false }
  }
  if (!sawReal) return { isSearch: false, isRead: false, isList: false }
  return { isSearch, isRead, isList }
}

function isSilentCommand(command: string): boolean {
  const parts = splitCommandWithOperators(command)
  if (parts.length === 0) return false
  let precededBy = ''
  let sawReal = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    if (REDIRECT_OPERATORS.has(part)) {
      i++
      continue
    }
    if (CONTROL_OPERATORS.has(part)) {
      precededBy = part
      continue
    }
    const base = part.trim().split(/\s+/)[0]
    if (!base) continue
    if (precededBy === '||' && NEUTRAL_COMMANDS.has(base)) continue
    sawReal = true
    if (!SILENT_COMMANDS.has(base)) return false
  }
  return sawReal
}

function isBashReadOnly(input: BashToolInput): boolean {
  return preparedBashReadsOnly(input)
}


async function preparePermissionMatcher(input: BashToolInput): Promise<(pattern: string) => boolean> {
  const parsed = await parseForSecurity(input.command)
  if (parsed.kind !== 'simple') {
    return () => true
  }
  const argvTexts = parsed.commands.map(command => command.argv.join(' '))
  return (pattern: string): boolean => {
    return argvTexts.some(argv => matchGlob(pattern, argv))
  }
}

function matchGlob(pattern: string, text: string): boolean {
  const body = pattern
    .split('*')
    .map(segment => segment.replace(/[.+?^${}()|[\]\\]/g, ch => `\\${ch}`))
    .join('[\\s\\S]*')
  return new RegExp(`^${body}$`).test(text)
}


function userFacingName(input: Partial<BashToolInput> | undefined): string {
  const command = stringInputField(input, 'command')
  if (!command) return BASH_TOOL_NAME
  if (isSedInPlaceEdit(command)) {
    const info = parseSedEditCommand(command)
    if (info) {
      return fileEditUserFacingName({ file_path: info.filePath, old_string: '' })
    }
  }
  return BASH_TOOL_NAME
}


async function runSimulatedSedEdit(
  input: BashToolInput,
  context: ToolUseContext,
  parentMessageId: string | undefined,
): Promise<Out> {
  const sed = input._simulatedSedEdit as { filePath: string; newContent: string; beforeBytes: string }
  const filePath = expandPath(sed.filePath, resolveShellCwd(input.cwd))
  if (!existsSync(filePath)) {
    return {
      stdout: '',
      stderr: `sed: can't read ${sed.filePath}: No such file or directory\nexit code 1`,
      interrupted: false,
    }
  }
  const encoding = detectFileEncoding(filePath)
  const endings = detectLineEndings(filePath, encoding)
  if (fileHistoryEnabled() && parentMessageId) {
    await fileHistoryTrackEdit(context.updateFileHistoryState, filePath, parentMessageId as `${string}-${string}-${string}-${string}-${string}`)
  }
  if (typeof sed.beforeBytes !== 'string' || readFileSync(filePath).toString('base64') !== sed.beforeBytes) {
    return { stdout: '', stderr: modifiedSinceReadMessage(), interrupted: false }
  }
  writeTextContent(filePath, sed.newContent, encoding, endings)
  context.readFileState.set(filePath, {
    content: sed.newContent,
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
  return { stdout: '', stderr: '', interrupted: false }
}


async function* runBash(
  input: BashToolInput,
  context: ToolUseContext,
  agentId: string | undefined,
): AsyncGenerator<{ toolUseID: string; data: BashProgress }, Out, void> {
  const abortController = context.abortController
  const isMainThread = agentId === undefined
  const cwd = resolveShellCwd(input.cwd)
  const webNotice = await shellWebContentNotice(input.command)
  const { setToolJSX, setTaskState, requestedTimeout, effectiveTimeout, timeoutClampNotice, shouldAutoBackground, creations, launchedAt } = shellRunPlan(input, context, cwd)
  let progressResolve: (() => void) | null = null
  let latest: { recent: string; all: string; lines: number; bytes: number; incomplete: boolean } = {
    recent: '',
    all: '',
    lines: 0,
    bytes: 0,
    incomplete: false,
  }
  const onProgress = (recent: string, all: string, lines: number, bytes: number, incomplete: boolean): void => {
    latest = { recent, all, lines, bytes: incomplete ? bytes : 0, incomplete }
    progressResolve?.()
  }
  let editorTerminalNote: string | undefined
  const verificationStart = captureVerificationStart(input.command, cwd, processOwnerForLane(agentId ?? null))
  const ideShellCommand =
    isMainThread && !input.run_in_background && ideTerminalAvailable()
      ? await execViaIdeTerminal(abortController.signal, {
          cwd,
          timeout: effectiveTimeout,
          shell: await terminalShellInvocation(input.command, input.inherit_session_env === true),
          shouldAutoBackground,
          onProgress,
        }).catch((error: unknown) => {
          if (!(error instanceof IdeTerminalUnavailableError)) throw error
          editorTerminalNote = error.message
          return null
        })
      : null
  if (ideShellCommand !== null) editorTerminalNote = EDITOR_TERMINAL_RESULT_NOTE
  const shellCommand =
    ideShellCommand ??
    (await exec(input.command, abortController.signal, 'bash', {
      timeout: effectiveTimeout,
      cwd: input.cwd === undefined ? undefined : cwd,
      preventCwdChanges: !isMainThread || input.cwd !== undefined,
      shouldAutoBackground,
      backgroundIntent: input.run_in_background === true && !BACKGROUND_TASKS_DISABLED,
      inheritSessionEnv: input.inherit_session_env === true,
      owner: agentId,
      onProgress,
    }))

  shellCommand.verificationStart = verificationStart
  const postNeeds: PostProcessNeeds = { input, creations, editorTerminalNote, agentId, shouldAutoBackground, cwd, abortController, shellCommand, webNotice, timeoutClampNotice }
  let timeoutAutoBackgroundedAfterMs: number | undefined
  let foregroundTaskId: string | null = null
  let backgroundId: string | undefined
  const backgroundFacts = (): Pick<Out, 'backgroundPid' | 'backgroundLifetime' | 'stopOffered' | 'serviceOffered' | 'sleepOffered'> => ({
    ...(shellCommand.pid !== undefined ? { backgroundPid: shellCommand.pid } : {}),
    backgroundLifetime: agentId !== undefined ? 'crewmate' : isRunInputClosed() ? 'turn' : 'session',
    stopOffered: context.options.tools.some(tool => tool.name === TASK_STOP_TOOL_NAME),
    serviceOffered: context.options.tools.some(tool => tool.name === 'Service'),
    sleepOffered: context.options.tools.some(tool => tool.name === SLEEP_TOOL_NAME),
  })
  const outputSoFar = async (): Promise<{ stdout: string; isTail: boolean }> => {
    const window = resolveOutputBudget(readMaxOutputChars(input.max_output_chars)).effective
    const cut = (text: string): string => formatOutput(stripEmptyLines(text), { maxLength: window }).truncatedContent
    try {
      const tail = await tailFile(shellCommand.taskOutput.path, window)
      return { stdout: cut(tail.content), isTail: tail.bytesRead < tail.bytesTotal }
    } catch {
      return { stdout: cut(latest.all), isTail: latest.incomplete }
    }
  }
  const launchFacts = (): ShellLaunchFacts => ({
    command: input.command,
    description: input.description ?? input.command,
    agentId,
    cwd,
    startTime: launchedAt,
    toolUseId: context.toolUseId,
  })

  const startBackgrounding = async (fromTrigger?: (id: string) => void): Promise<void> => {
    if (foregroundTaskId !== null) {
      const converted = backgroundExistingForegroundTask(
        foregroundTaskId,
        shellCommand,
        input.description ?? input.command,
        setTaskState,
        context.toolUseId,
        launchFacts(),
      )
      if (!converted) return
      backgroundId = foregroundTaskId
      fromTrigger?.(backgroundId)
      return
    }
    const handle = await spawnShellTask(
      {
        command: input.command,
        description: input.description ?? input.command,
        shellCommand,
        toolUseId: context.toolUseId,
        agentId,
        startTime: launchedAt,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('spawn must not read app state')
        },
        setAppState: setTaskState,
      },
    )
    if (handle.accepted === false) return
    backgroundId = handle.taskId
    progressResolve?.()
    fromTrigger?.(backgroundId)
  }

  shellCommand.onTimeout?.(backgroundFn => {
    timeoutAutoBackgroundedAfterMs = effectiveTimeout
    void startBackgrounding(backgroundFn)
  })

  if (input.run_in_background && !BACKGROUND_TASKS_DISABLED) {
    const handle = await spawnShellTask(
      {
        command: input.command,
        description: input.description ?? input.command,
        shellCommand,
        toolUseId: context.toolUseId,
        agentId,
        startTime: launchedAt,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('spawn must not read app state')
        },
        setAppState: setTaskState,
      },
    )
    if (handle.accepted === false) {
      const result = await shellCommand.result
      shellCommand.cleanup()
      return await postProcess(result, postNeeds)
    }
    return { stdout: webNotice, stderr: '', interrupted: false, backgroundTaskId: handle.taskId, scrubbedSessionEnv: shellCommand.scrubbedSessionEnv, ...backgroundFacts() }
  }

  let backgroundAsked = false
  let backgroundAskHandled = false
  let backgroundAskResolve: (() => void) | null = null
  const backgroundAsk = new Promise<'background'>(resolve => {
    backgroundAskResolve = () => resolve('background')
  })
  const unregisterRun = registerShellRun({
    agentId,
    request: () => {
      backgroundAsked = true
      backgroundAskResolve?.()
      progressResolve?.()
    },
  })
  try {
  const completed = shellCommand.result.then(() => 'done' as const)
  if (context.shellInputId !== undefined) {
    foregroundTaskId = registerForeground(
      { command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.shellInputId },
      setTaskState,
      context.shellInputId,
    )
  }

  const settledEarly = await withDeadline(
    Promise.race([completed, backgroundAsk]),
    QUIET_WINDOW_MS,
    () => 'timer' as const,
    { unref: true },
  )
  if (settledEarly === 'done') {
    const result = await shellCommand.result
    shellCommand.cleanup()
    return await postProcess(result, postNeeds)
  }
  if (settledEarly === 'background') {
    backgroundAskHandled = true
    await startBackgrounding()
    if (backgroundId === undefined) {
      const result = await shellCommand.result
      shellCommand.cleanup()
      return await postProcess(result, postNeeds)
    }
    return userBackgroundedAnswer({ webNotice, latest, backgroundId, shellCommand, backgroundFacts })
  }
  if (backgroundId !== undefined) {
    const soFar = timeoutAutoBackgroundedAfterMs !== undefined ? await outputSoFar() : { stdout: '', isTail: false }
    return timeoutBackgroundedAnswer({ webNotice, soFar, backgroundId, shellCommand, timeoutAutoBackgroundedAfterMs, timeoutClampNotice, backgroundFacts })
  }

  TaskOutput.startPolling(shellCommand.taskOutput.taskId)
  const startedAt = Date.now()
  let interruptBackgroundingStarted = false
  try {
    while (true) {
      const progressSignal = new Promise<'progress'>(resolve => {
        progressResolve = () => resolve('progress')
      })
      const outcome = await Promise.race([completed, progressSignal])

      const settled = outcome === 'done' ? await shellCommand.result : null
      if (settled && settled.backgroundTaskId !== undefined) {
        markTaskNotified(settled.backgroundTaskId, setTaskState)
        shellCommand.cleanup()
        return await postProcess({ ...settled, backgroundTaskId: undefined }, postNeeds)
      }

      if (settled) {
        if (foregroundTaskId !== null) unregisterForeground(foregroundTaskId, setTaskState)
        shellCommand.cleanup()
        return await postProcess(settled, postNeeds)
      }

      if (!interruptBackgroundingStarted && abortController.signal.reason === 'interrupt') {
        interruptBackgroundingStarted = true
        if (BACKGROUND_TASKS_DISABLED) {
          shellCommand.kill()
        } else {
          await startBackgrounding()
        }
      }

      if (backgroundAsked && !backgroundAskHandled && !interruptBackgroundingStarted && backgroundId === undefined) {
        backgroundAskHandled = true
        await startBackgrounding()
      }

      if (backgroundId !== undefined) {
        const fullOutput = latest.all
        const soFar = timeoutAutoBackgroundedAfterMs !== undefined ? await outputSoFar() : { stdout: '', isTail: false }
        return loopBackgroundedAnswer({ webNotice, interruptBackgroundingStarted, backgroundAskHandled, fullOutput, soFar, backgroundId, shellCommand, timeoutAutoBackgroundedAfterMs, backgroundFacts })
      }

      if (foregroundTaskId !== null && shellCommand.status === 'backgrounded') {
        return foregroundBackgroundedAnswer({ webNotice, foregroundTaskId, shellCommand, backgroundFacts })
      }

      const elapsedSeconds = Math.floor((Date.now() - launchedAt) / 1000)
      if (!BACKGROUND_TASKS_DISABLED && backgroundId === undefined && Date.now() - startedAt >= QUIET_WINDOW_MS && setToolJSX) {
        if (foregroundTaskId === null) {
          foregroundTaskId = registerForeground(
            { command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.toolUseId },
            setTaskState,
            context.toolUseId,
          )
        }
        setToolJSX({ jsx: <BackgroundHint />, shouldHidePromptInput: false, shouldContinueAnimation: true, showSpinner: true })
      }
      let display = latest.recent
      if (elapsedSeconds >= SOFT_TIMEOUT_MS / 1000) {
        const timeoutNote = requestedTimeout ? `, timing out at ${Math.round(effectiveTimeout / 1000)}s` : ''
        display = `[still running after ${elapsedSeconds}s${timeoutNote}]\n${display}`
      }
      yield {
        toolUseID: context.toolUseId ?? '',
        data: {
          type: 'bash_progress',
          output: display,
          fullOutput: latest.all,
          elapsedTimeSeconds: elapsedSeconds,
          totalLines: latest.lines,
          ...(latest.incomplete ? { totalBytes: latest.bytes } : {}),
          taskId: foregroundTaskId ?? undefined,
          ...(requestedTimeout ? { timeoutMs: effectiveTimeout } : {}),
          budgetMs: effectiveTimeout,
        },
      }
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId)
  }
  } finally {
    if (foregroundTaskId !== null) unregisterForeground(foregroundTaskId, setTaskState)
    unregisterRun()
  }
}

function shellRunPlan(input: BashToolInput, context: ToolUseContext, cwd: string) {
  const setToolJSX = context.setToolJSX
  const setTaskState = context.setAppStateForTasks ?? context.setAppState

  const requestedTimeout = input.timeout
  const effectiveTimeout = Math.min(requestedTimeout || getDefaultTimeoutMs(), getMaxTimeoutMs())
  const timeoutClampNotice =
    requestedTimeout !== undefined && requestedTimeout > getMaxTimeoutMs()
      ? `The timeout asked for (${formatDuration(requestedTimeout)}) is above the cap (${formatDuration(getMaxTimeoutMs())}), so ${formatDuration(getMaxTimeoutMs())} applied; a command that needs longer runs with run_in_background.`
      : undefined
  const firstSubcommand = pinnedCommandAnalysis.splitCommand(input.command)[0]?.trim() ?? input.command.trim()
  const shouldAutoBackground = !BACKGROUND_TASKS_DISABLED && !NEVER_AUTO_BACKGROUND.has(firstCommandWord(firstSubcommand))

  const creations = snapshotCreations(input.command, cwd)
  const launchedAt = Date.now()
  return { setToolJSX, setTaskState, requestedTimeout, effectiveTimeout, timeoutClampNotice, shouldAutoBackground, creations, launchedAt }
}

interface PostProcessNeeds {
  input: BashToolInput
  creations: ReturnType<typeof snapshotCreations>
  editorTerminalNote: string | undefined
  agentId: string | undefined
  shouldAutoBackground: boolean
  cwd: string
  abortController: ToolUseContext['abortController']
  shellCommand: ShellCommand
  webNotice: string
  timeoutClampNotice: string | undefined
}

async function postProcess(result: ExecResult, { input, creations, editorTerminalNote, agentId, shouldAutoBackground, cwd, abortController, shellCommand, webNotice, timeoutClampNotice }: PostProcessNeeds): Promise<Out> {
  let prLinkNote: string | undefined
  if (result.backgroundTaskId === undefined) {
    prLinkNote = await trackGitOperations(input.command, result.code, result.stdout)
    settleCreations(creations, result.code)
  }

  const accumulator = new EndTruncatingAccumulator()
  accumulator.append(result.stdout.trimEnd() + '\n')
  if (result.stderr.trim() !== '') accumulator.append(result.stderr.trimEnd() + '\n')
  for (const note of [editorTerminalNote, result.preSpawnError ? null : loginFilesLineOnce(agentId ?? 'main'), prLinkNote]) if (note) accumulator.append(note + '\n')
  if (!shouldAutoBackground && result.stderr.includes('Command timed out after')) accumulator.append(SLEEP_TIMEOUT_WHY + '\n')
  if (commandNamesBoxLock(input.command)) await refreshBoxReading()
  const boxLine = boxLockLineForCommand(input.command, `${result.stdout}\n${result.stderr}`, { cwd })
  if (boxLine !== null) accumulator.append(boxLine + '\n')
  const interpretation = interpretCommandResult(input.command, result.code, result.stdout, '')
  const returnCodeInterpretation = interpretation.message
  const exitNote =
    !interpretation.isError && result.code !== 0 && interpretation.message !== undefined
      ? `${interpretation.message} (exit code ${result.code})`
      : undefined
  const noOutputExpected = isSilentCommand(input.command)
  const interruptedByUser = result.interrupted && abortController.signal.reason === 'interrupt'
  if (interpretation.isError && !interruptedByUser && result.code !== 0) {
    accumulator.append(`\n${exitLine(result.code, !result.interrupted && result.stderr.trim() === '', signalsCountIn(result))}`)
  }

  let stderr = ''

  const redact = createShellResultRedactor()
  let out = await applyShellOutputFilter(redact(accumulator.toString()), { taskId: shellCommand.taskOutput.taskId, spilledPath: result.outputFilePath })
  const budget = resolveOutputBudget(readMaxOutputChars(input.max_output_chars))
  const windowed = result.outputFilePath === undefined
  const clause = outputBudgetClause(budget)
  const outputBudgetNotice = windowed ? clause : undefined

  if (result.preSpawnError) {
    throw new ShellError('', result.preSpawnError, result.code, result.interrupted, false)
  }
  if (interpretation.isError && !interruptedByUser) {
    const thrown = budget.requested === undefined ? out : windowed ? formatOutput(out, { maxLength: budget.effective }).truncatedContent : formatExcerpt(out, budget.effective)
    const notice = sessionEnvNoticeForResult({ scrubbed: shellCommand.scrubbedSessionEnv, commandText: input.command })
    const error = new ShellError('', [webNotice + thrown, clause].filter(Boolean).join('\n'), result.code, result.interrupted, true, notice)
    error.pipelineStatus = result.pipelineStatus
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
      let prefix = webNotice
      await redactedCopy(result.outputFilePath, destination, text => {
        const marked = prefix + redact(text)
        prefix = ''
        return marked
      })
      persistedOutputSize += Buffer.byteLength(webNotice)
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

  if (result.backgroundTaskId === undefined) {
    recordBashAudit(input.command, result.code, result.interrupted)
  }

  const formatted = formatOutput(out, { preExcerpted: result.outputFilePath !== undefined, maxLength: budget.effective })
  return {
    stdout: webNotice + formatted.truncatedContent,
    stderr,
    interrupted: result.interrupted,
    code: result.code,
    ...(result.pipelineStatus ? { pipelineStatus: result.pipelineStatus } : {}),
    isImage,
    returnCodeInterpretation,
    ...(exitNote !== undefined ? { exitNote } : {}),
    ...(timeoutClampNotice !== undefined ? { timeoutClampNotice } : {}),
    ...(outputBudgetNotice !== undefined ? { outputBudgetNotice } : {}),
    ...(outputCopyNotice !== undefined ? { outputCopyNotice } : {}),
    noOutputExpected,
    ...(persistedOutputPath ? { persistedOutputPath, persistedOutputSize } : {}),
    ...(shellCommand.scrubbedSessionEnv && shellCommand.scrubbedSessionEnv.length > 0
      ? { scrubbedSessionEnv: shellCommand.scrubbedSessionEnv }
      : {}),
  }
}

type BackgroundFacts = () => Pick<Out, 'backgroundPid' | 'backgroundLifetime' | 'stopOffered' | 'serviceOffered' | 'sleepOffered'>
type OutputSoFar = { stdout: string; isTail: boolean }

function userBackgroundedAnswer({ webNotice, latest, backgroundId, shellCommand, backgroundFacts }: { webNotice: string; latest: { all: string }; backgroundId: string | undefined; shellCommand: ShellCommand; backgroundFacts: BackgroundFacts }): Out {
  return {
    stdout: webNotice + latest.all,
    stderr: '',
    interrupted: false,
    backgroundTaskId: backgroundId,
    scrubbedSessionEnv: shellCommand.scrubbedSessionEnv,
    backgroundedByUser: true,
    ...backgroundFacts(),
  }
}

function timeoutBackgroundedAnswer({ webNotice, soFar, backgroundId, shellCommand, timeoutAutoBackgroundedAfterMs, timeoutClampNotice, backgroundFacts }: { webNotice: string; soFar: OutputSoFar; backgroundId: string | undefined; shellCommand: ShellCommand; timeoutAutoBackgroundedAfterMs: number | undefined; timeoutClampNotice: string | undefined; backgroundFacts: BackgroundFacts }): Out {
  return {
    stdout: webNotice + soFar.stdout,
    stderr: '',
    interrupted: false,
    backgroundTaskId: backgroundId,
    scrubbedSessionEnv: shellCommand.scrubbedSessionEnv,
    timeoutAutoBackgroundedAfterMs,
    ...(timeoutClampNotice !== undefined ? { timeoutClampNotice } : {}),
    ...backgroundFacts(),
    ...(soFar.isTail ? { backgroundOutputIsTail: true } : {}),
  }
}

function loopBackgroundedAnswer({ webNotice, interruptBackgroundingStarted, backgroundAskHandled, fullOutput, soFar, backgroundId, shellCommand, timeoutAutoBackgroundedAfterMs, backgroundFacts }: { webNotice: string; interruptBackgroundingStarted: boolean; backgroundAskHandled: boolean; fullOutput: string; soFar: OutputSoFar; backgroundId: string | undefined; shellCommand: ShellCommand; timeoutAutoBackgroundedAfterMs: number | undefined; backgroundFacts: BackgroundFacts }): Out {
  return {
    stdout: webNotice + (interruptBackgroundingStarted || backgroundAskHandled ? fullOutput : soFar.stdout),
    stderr: '',
    interrupted: false,
    backgroundTaskId: backgroundId,
    scrubbedSessionEnv: shellCommand.scrubbedSessionEnv,
    timeoutAutoBackgroundedAfterMs,
    ...(backgroundAskHandled ? { backgroundedByUser: true } : {}),
    ...backgroundFacts(),
    ...(soFar.isTail ? { backgroundOutputIsTail: true } : {}),
  }
}

function foregroundBackgroundedAnswer({ webNotice, foregroundTaskId, shellCommand, backgroundFacts }: { webNotice: string; foregroundTaskId: string; shellCommand: ShellCommand; backgroundFacts: BackgroundFacts }): Out {
  return {
    stdout: webNotice,
    stderr: '',
    interrupted: false,
    backgroundTaskId: foregroundTaskId,
    scrubbedSessionEnv: shellCommand.scrubbedSessionEnv,
    backgroundedByUser: true,
    ...backgroundFacts(),
  }
}


export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  shellCommandOf: (input: unknown) => stringInputField(input, 'command'),
  searchHint: 'Executes shell commands.',
  get inputSchema() {
    return modelInputSchema()
  },
  get inputJSONSchema() {
    const schema = z.toJSONSchema(modelInputSchema()) as { properties?: Record<string, unknown>; required?: string[] }
    if (BACKGROUND_TASKS_DISABLED && schema.properties) {
      delete schema.properties.run_in_background
    }
    return schema
  },
  maxResultSizeChars: PERSIST_THRESHOLD_CHARS,
  strict: true,
  straightQuoteInputs: ['command'],
  isEnabled: () => bashToolAvailable(),
  async description(input: BashToolInput): Promise<string> {
    return input?.description ?? 'Run a shell command'
  },
  async prompt({ tools }): Promise<string> {
    await Promise.all([settleShellRecord(), settleLoginFiles()])
    return getSimplePrompt(new Set(tools.map(tool => tool.name)))
  },
  userFacingName,
  prepare: prepareBashReadOnly,
  isConcurrencySafe(input: BashToolInput): boolean {
    return isBashReadOnly(input)
  },
  isReadOnly(input: BashToolInput): boolean {
    return isBashReadOnly(input)
  },
  isSearchOrReadCommand(input: unknown) {
    const command = stringInputField(input, 'command')
    if (command === undefined) return { isSearch: false, isRead: false, isList: false }
    return isSearchOrReadBashCommand(command)
  },
  getToolUseSummary(input: Partial<BashToolInput> | undefined): string | null {
    if (!input?.command) return null
    return input.description ?? truncateForSummary(input.command)
  },
  getActivityDescription(input: Partial<BashToolInput> | undefined): string | null {
    if (!input?.command) return 'Running a shell command'
    return `Running ${input.description ?? truncateForSummary(input.command)}`
  },
  async validateInput(input: BashToolInput) {
    const cwdRefusal = controlCharacterPathRefusal(input.cwd)
    if (cwdRefusal !== null) return { result: false as const, message: cwdRefusal, errorCode: 1 }
    if (input.command.trim() === '') {
      return { result: false as const, message: EMPTY_COMMAND_REFUSAL, errorCode: 1 }
    }
    const refused = refuseMaxOutputChars(input.max_output_chars)
    if (refused !== undefined) {
      return { result: false as const, message: refused, errorCode: 2 }
    }
    return { result: true as const }
  },
  async checkPermissions(input: BashToolInput, context: ToolUseContext) {
    return bashToolHasPermission(input, context.getAppState().toolPermissionContext as ToolPermissionContext)
  },
  preparePermissionMatcher,
  async call(
    input: BashToolInput,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
    parentMessage?: AssistantMessage,
    onProgress?: (progress: { toolUseID: string; data: BashProgress }) => void,
  ): Promise<ToolResult<Out>> {
    const agentId = context.agentId as string | undefined
    const parentMessageId = parentMessage?.uuid
    let counter = 0
    try {
      if (input._simulatedSedEdit) {
        return { data: await runSimulatedSedEdit(input, context, parentMessageId) }
      }
      await sayWhatTheShellOwes(context)
      const generator = runBash(input, context, agentId)
      let step = await generator.next()
      while (!step.done) {
        counter++
        onProgress?.({ toolUseID: `${context.toolUseId ?? 'bash'}-${counter}`, data: step.value.data })
        step = await generator.next()
      }
      const out = step.value
      out.sessionEnvNotice = sessionEnvNoticeForResult({ scrubbed: out.scrubbedSessionEnv, commandText: input.command })
      return { data: out }
    } finally {
      context.setToolJSX?.(null)
    }
  },
  mapToolResultToToolResultBlockParam(output: Out, toolUseID: string) {
    return mapResultToBlock(output, toolUseID)
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
})

const EMPTY_COMMAND_REFUSAL = 'Nothing to run: the command is empty. Pass the command to execute.'
