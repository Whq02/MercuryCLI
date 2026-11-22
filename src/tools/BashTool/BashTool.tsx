import { z } from 'zod/v4'
import { buildTool, stringInputField, type ToolUseContext, type ToolResult, type ToolPermissionContext } from '../../Tool.js'
import { loginFilesLineOnce, settleShellRecord } from '../../utils/shell/shellRecord.js'
import { bashToolAvailable } from '../../utils/shell/windowsShellRoad.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isRunInputClosed } from '../../bootstrap/state.js'
import { SLEEP_TOOL_NAME } from '../SleepTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../../constants/tools/taskStop.js'
import { exec, resolveShellCwd, settleLoginFiles, signalsCountIn, terminalShellInvocation } from '../../utils/Shell.js'
import { captureVerificationStart } from '../../utils/verification/verificationState.js'
import { processOwnerForLane } from '../../utils/run/resolveOwner.js'
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
import { recordBashAudit } from '../../daemon/spawnLedger.js'
import { trackGitOperations } from '../../tools/shared/gitOperationTracking.js'
import { sessionEnvNoticeForResult } from '../../tools/shared/sessionEnvNotice.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../services/changeTransaction/fileHistory.js'
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
} from '../../utils/shell/utils.js'
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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


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
const REDIRECT_OPERATORS: Unbuilt = unbuilt('src/tools/BashTool/BashTool.tsx:166')
const CONTROL_OPERATORS: Unbuilt = unbuilt('src/tools/BashTool/BashTool.tsx:167')
const SILENT_COMMANDS: Unbuilt = unbuilt('src/tools/BashTool/BashTool.tsx:168')

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


export const BashTool: Unbuilt = unbuilt('src/tools/BashTool/BashTool.tsx:774')

const EMPTY_COMMAND_REFUSAL = 'Nothing to run: the command is empty. Pass the command to execute.'
