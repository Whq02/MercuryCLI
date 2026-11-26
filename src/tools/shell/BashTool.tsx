import { z } from 'zod/v4'
import { buildTool, stringInputField, type ToolInputJSONSchema, type ToolUseContext, type ToolResult } from '../kit/tool.js'
import { loginFilesLineOnce, settleShellRecord } from '../../platform/shell/shellRecord.js'
import { bashToolAvailable } from '../../platform/shell/windowsShellRoad.js'
import { BASH_TOOL_NAME } from '../kit/names/bash.js'
import { semanticBoolean } from '../kit/semanticBoolean.js'
import { semanticNumber } from '../kit/semanticNumber.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { isRunInputClosed } from '../../boot/process-state/processState.js'
import { SLEEP_TOOL_NAME } from '../sleep/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../kit/names/taskStop.js'
import { exec, resolveShellCwd, settleLoginFiles, signalsCountIn, terminalShellInvocation } from '../../platform/shell/shellExec.js'
import { captureVerificationStart } from '../../platform/verification/verificationState.js'
import { processOwnerForLane } from '../../engine/run-owner/resolveOwner.js'
import { execViaIdeTerminal, IdeTerminalUnavailableError, ideTerminalAvailable } from '../../integrations/acp/ideToolBridge.js'
import type { ExecResult, ShellCommand } from '../../platform/shell/shellProcess.js'
import { TaskOutput } from '../../engine/task-framework/taskOutput.js'
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
  type ShellLaunchFacts,
} from '../../engine/tasks/local-shell/shellTask.js'
import { registerShellRun } from './backgroundRequest.js'
import { ShellError, errorMessage } from '../../platform/errors/errors.js'
import { EndTruncatingAccumulator } from '../../platform/text/strings.js'
import { formatDuration } from '../../platform/text/format.js'
import { recordBashAudit } from '../../daemon/roster/spawnLedger.js'
import { trackGitOperations } from '../kit/gitOperationTracking.js'
import { sessionEnvNoticeForResult } from '../kit/sessionEnvNotice.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../engines/change-transaction/fileHistory.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
} from '../../platform/files/file.js'
import { closingTableCommand, exitLine, interpretCommandResult } from './commandSemantics.js'
import { describeCommandDescription, describeMaxOutputChars, describeRunInBackground, describeTimeout, EDITOR_TERMINAL_RESULT_NOTE, getDefaultTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from './prompt.js'
import { firstCommandWord } from '../kit/shellTools.js'
import { isSedInPlaceEdit, parseSedEditCommand } from './sedEditParser.js'
import { prepareBashReadOnly, preparedBashReadsOnly } from './readOnlyValidation.js'
import { bashToolHasPermission } from './bashPermissions.js'
import {
  parseForSecurity,
  splitCommandWithOperators,
  pinnedCommandAnalysis,
} from '../../permissions/rules/decision/commandAnalysis.js'
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
} from '../../platform/shell/shellOutput.js'
import { maxOutputCharsField, readMaxOutputChars, refuseMaxOutputChars } from './maxOutputChars.js'
import { resolveOutputBudget } from '../../platform/shell/outputLimits.js'
import { windowedError } from '../kit/toolErrors.js'
import { userFacingName as fileEditUserFacingName } from '../edit/rows.js'
import {
  BackgroundHint,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './rows.js'
import type { BashProgress } from '../kit/toolProgress.js'
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import type { CanUseToolFn } from '../kit/tool.js'
import { existsSync, readFileSync } from 'node:fs'
import { modifiedSinceReadMessage } from '../edit/otherSession.js'
import { tailFile } from '../../platform/files/fsOperations.js'
import { stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { getScratchpadDir } from '../../permissions/rules/filesystem.js'
import { settleCreations, snapshotCreations } from '../../permissions/rules/ownGround.js'
import { controlCharacterPathRefusal, expandPath } from '../../platform/files/path.js'
import { createShellResultRedactor } from '../../platform/secrets/redactSecrets.js'
import { isOutputLineTruncated } from '../kit/truncatedOutput.js'
import { shellWebContentNotice } from './webContent.js'
import { boxLockLineForCommand, commandNamesBoxLock, refreshBoxReading } from '../../platform/storage/boxLock.js'
import { mapResultToBlock } from './resultBlock.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { passedOver } from '../../platform/errors/passedOver.js'


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


const SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'strings',
  'jq',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
])
const LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set(['>', '>>', '>&'])
const CONTROL_OPERATORS: ReadonlySet<string> = new Set(['||', '&&', '|', ';'])
const SILENT_COMMANDS: ReadonlySet<string> = new Set([
  'mv',
  'cp',
  'rm',
  'mkdir',
  'rmdir',
  'chmod',
  'chown',
  'chgrp',
  'touch',
  'ln',
  'cd',
  'export',
  'unset',
  'wait',
])

function classifyCommand(command: string): { isSearch: boolean; isRead: boolean; isList: boolean } {
  const parts = splitCommandWithOperators(command)
  if (parts.length === 0) return { isSearch: false, isRead: false, isList: false }
  let isSearch = false
  let isRead = false
  let isList = false
  let sawRecognized = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    if (REDIRECT_OPERATORS.has(part)) {
      i++
      continue
    }
    if (CONTROL_OPERATORS.has(part)) continue
    const base = part.trim().split(/\s+/)[0]
    if (!base) continue
    if (NEUTRAL_COMMANDS.has(base)) continue
    const matchesSearch = SEARCH_COMMANDS.has(base)
    const matchesRead = READ_COMMANDS.has(base)
    const matchesList = LIST_COMMANDS.has(base)
    if (!matchesSearch && !matchesRead && !matchesList) {
      return { isSearch: false, isRead: false, isList: false }
    }
    sawRecognized = true
    if (matchesSearch) isSearch = true
    if (matchesRead) isRead = true
    if (matchesList) isList = true
  }
  return sawRecognized ? { isSearch, isRead, isList } : { isSearch: false, isRead: false, isList: false }
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
  const closing = closingTableCommand(input.command)
  return { setToolJSX, setTaskState, requestedTimeout, effectiveTimeout, timeoutClampNotice, shouldAutoBackground, creations, launchedAt, closing }
}

interface PostProcessNeeds {
  input: BashToolInput
  closing: ReturnType<typeof closingTableCommand>
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

async function postProcess(result: ExecResult, { input, closing, creations, editorTerminalNote, agentId, shouldAutoBackground, cwd, abortController, shellCommand, webNotice, timeoutClampNotice }: PostProcessNeeds): Promise<Out> {
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
  const ran = closing === undefined || result.closingEndedOnOne === undefined ? undefined : { stage: closing.stage, endedOnOne: result.closingEndedOnOne, pipeline: result.pipelineStatus }
  const interpretation = interpretCommandResult(input.command, result.code, result.stdout, '', ran)
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


const EMPTY_COMMAND_REFUSAL = 'Nothing to run: the command is empty. Pass the command to execute.'

function getBashInputJSONSchema(): ToolInputJSONSchema {
  const converted = z.toJSONSchema(modelInputSchema())
  if (!BACKGROUND_TASKS_DISABLED) return converted
  const properties = converted.properties
  if (properties === undefined) return converted
  const rest = Object.fromEntries(
    Object.entries(properties).filter(([key]) => key !== 'run_in_background'),
  )
  return { ...converted, properties: rest }
}

async function runSimulatedSedEdit(
  edit: NonNullable<BashToolInput['_simulatedSedEdit']>,
  inputCwd: string | undefined,
  context: ToolUseContext,
  parentAssistantMessage: AssistantMessage,
): Promise<ToolResult<Out>> {
  const cwd = resolveShellCwd(inputCwd)
  const resolvedPath = expandPath(edit.filePath, cwd)
  if (!existsSync(resolvedPath)) {
    return {
      data: {
        stdout: '',
        stderr: `sed: can't read ${edit.filePath}: No such file or directory\nexit code 1`,
        interrupted: false,
      },
    }
  }
  const encoding = detectFileEncoding(resolvedPath)
  const lineEndings = detectLineEndings(resolvedPath, encoding)
  if (fileHistoryEnabled() && parentAssistantMessage?.uuid) {
    await fileHistoryTrackEdit(
      context.updateFileHistoryState,
      resolvedPath,
      parentAssistantMessage.uuid,
    )
  }
  const currentBase64 = readFileSync(resolvedPath).toString('base64')
  if (typeof edit.beforeBytes !== 'string' || currentBase64 !== edit.beforeBytes) {
    return {
      data: {
        stdout: '',
        stderr: modifiedSinceReadMessage(),
        interrupted: false,
      },
    }
  }
  writeTextContent(resolvedPath, edit.newContent, encoding, lineEndings)
  context.readFileState.set(resolvedPath, {
    content: edit.newContent,
    timestamp: getFileModificationTime(resolvedPath),
    offset: undefined,
    limit: undefined,
  })
  return {
    data: {
      stdout: '',
      stderr: '',
      interrupted: false,
    },
  }
}

async function launchShell(args: {
  input: BashToolInput
  context: ToolUseContext
  cwd: string
  effectiveTimeout: number
  shouldAutoBackground: boolean
  isBackgroundRequest: boolean
  closing: ReturnType<typeof closingTableCommand>
  owner: ReturnType<typeof processOwnerForLane>
  onProgress: (recentLines: string, allLines: string, numLines: number, numBytes: number, incomplete: boolean) => void
}): Promise<{ shellCommand: ShellCommand; editorTerminalNote: string | undefined }> {
  const { input, context, cwd, effectiveTimeout, shouldAutoBackground, isBackgroundRequest, closing, owner, onProgress } = args
  const verificationStart = captureVerificationStart(input.command, cwd, owner)
  let editorTerminalNote: string | undefined
  let shellCommand: ShellCommand | null = null
  if (!isBackgroundRequest && context.agentId === undefined && ideTerminalAvailable()) {
    try {
      const shell = await terminalShellInvocation(input.command, input.inherit_session_env === true)
      shellCommand = await execViaIdeTerminal(context.abortController.signal, {
        cwd,
        timeout: effectiveTimeout,
        shell,
        shouldAutoBackground,
        onProgress,
      })
      if (shellCommand !== null) {
        editorTerminalNote = EDITOR_TERMINAL_RESULT_NOTE
      }
    } catch (error) {
      if (error instanceof IdeTerminalUnavailableError) {
        editorTerminalNote = error.message
      } else {
        throw error
      }
    }
  }
  if (shellCommand === null) {
    shellCommand = await exec(input.command, context.abortController.signal, 'bash', {
      ...(input.cwd !== undefined ? { cwd } : {}),
      timeout: effectiveTimeout,
      shouldAutoBackground,
      preventCwdChanges: context.agentId !== undefined || input.cwd !== undefined,
      ...(isBackgroundRequest ? { backgroundIntent: true } : {}),
      ...(closing === undefined ? {} : { closing }),
      ...(input.inherit_session_env === true ? { inheritSessionEnv: true } : {}),
      owner,
      onProgress,
    })
  }
  shellCommand.verificationStart = verificationStart
  return { shellCommand, editorTerminalNote }
}

async function* runShellCommand(
  input: BashToolInput,
  context: ToolUseContext,
): AsyncGenerator<BashProgress, Out> {
  await sayWhatTheShellOwes(context)
  const cwd = resolveShellCwd(input.cwd)
  const webNotice = await shellWebContentNotice(input.command)
  const {
    setToolJSX,
    setTaskState,
    requestedTimeout,
    effectiveTimeout,
    timeoutClampNotice,
    shouldAutoBackground,
    creations,
    launchedAt,
    closing,
  } = shellRunPlan(input, context, cwd)
  const owner = processOwnerForLane(context.agentId ?? null)
  const isBackgroundRequest = !BACKGROUND_TASKS_DISABLED && Boolean(input.run_in_background)

  let latest: {
    recent: string
    all: string
    totalLines: number
    totalBytes: number | undefined
    incomplete: boolean
  } = { recent: '', all: '', totalLines: 0, totalBytes: undefined, incomplete: false }
  let woken = false
  let wakeWaiter: (() => void) | null = null
  const wake = (): void => {
    woken = true
    const fn = wakeWaiter
    wakeWaiter = null
    fn?.()
  }
  const waitForWake = (): Promise<void> => {
    if (woken) {
      woken = false
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      wakeWaiter = () => {
        woken = false
        resolve()
      }
    })
  }
  const onProgress = (
    recentLines: string,
    allLines: string,
    numLines: number,
    numBytes: number,
    incomplete: boolean,
  ): void => {
    latest = {
      recent: recentLines,
      all: allLines,
      totalLines: numLines,
      totalBytes: incomplete ? numBytes : undefined,
      incomplete,
    }
    wake()
  }

  const { shellCommand, editorTerminalNote } = await launchShell({
    input,
    context,
    cwd,
    effectiveTimeout,
    shouldAutoBackground,
    isBackgroundRequest,
    closing,
    owner,
    onProgress,
  })

  const postNeeds: PostProcessNeeds = {
    input,
    closing,
    creations,
    editorTerminalNote,
    agentId: context.agentId,
    shouldAutoBackground,
    cwd,
    abortController: context.abortController,
    shellCommand,
    webNotice,
    timeoutClampNotice,
  }

  const backgroundLifetime: BackgroundLifetime =
    context.agentId !== undefined ? 'crewmate' : isRunInputClosed() ? 'turn' : 'session'
  const offeredNames = new Set((context.options?.tools ?? []).map(tool => tool.name))
  const backgroundFacts: BackgroundFacts = () => ({
    ...(shellCommand.pid !== undefined ? { backgroundPid: shellCommand.pid } : {}),
    backgroundLifetime,
    stopOffered: offeredNames.has(TASK_STOP_TOOL_NAME),
    serviceOffered: offeredNames.has('Service'),
    sleepOffered: offeredNames.has(SLEEP_TOOL_NAME),
  })
  const description = input.description ?? input.command
  const launchFacts: ShellLaunchFacts = {
    command: input.command,
    description,
    agentId: context.agentId,
    cwd,
    startTime: launchedAt,
    toolUseId: context.toolUseId,
  }

  let foregroundTaskId: string | undefined
  let backgroundId: string | undefined
  let timeoutAutoBackgroundedAfterMs: number | undefined
  let handoverPromise: Promise<string | undefined> | null = null
  let resolveBackgroundAssigned: (() => void) | null = null
  const backgroundAssignedPromise = new Promise<void>(resolve => {
    resolveBackgroundAssigned = resolve
  })

  const moveToBackground = (timeoutBg?: (id: string) => boolean): Promise<string | undefined> => {
    if (handoverPromise !== null) return handoverPromise
    handoverPromise = (async () => {
      if (foregroundTaskId !== undefined) {
        const accepted = backgroundExistingForegroundTask(
          foregroundTaskId,
          shellCommand,
          description,
          setTaskState,
          context.toolUseId,
          launchFacts,
        )
        if (accepted) {
          backgroundId = foregroundTaskId
          timeoutBg?.(backgroundId)
          resolveBackgroundAssigned?.()
          resolveBackgroundAssigned = null
          wake()
          return backgroundId
        }
        return undefined
      }
      const handle = await spawnShellTask(
        {
          command: input.command,
          description,
          shellCommand,
          toolUseId: context.toolUseId,
          agentId: context.agentId,
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
      if (handle.accepted) {
        backgroundId = handle.taskId
        timeoutBg?.(backgroundId)
        resolveBackgroundAssigned?.()
        resolveBackgroundAssigned = null
        wake()
        return backgroundId
      }
      return undefined
    })()
    return handoverPromise
  }

  const readOutputSoFar = async (): Promise<OutputSoFar> => {
    const budget = resolveOutputBudget(readMaxOutputChars(input.max_output_chars))
    try {
      const tailed = await tailFile(shellCommand.taskOutput.path, budget.effective)
      const cleaned = stripEmptyLines(tailed.content)
      const formatted = formatOutput(cleaned, { maxLength: budget.effective })
      return { stdout: formatted.truncatedContent, isTail: tailed.bytesRead < tailed.bytesTotal }
    } catch (error) {
      passedOver(error)
      const cleaned = stripEmptyLines(latest.all)
      const formatted = formatOutput(cleaned, { maxLength: budget.effective })
      return { stdout: formatted.truncatedContent, isTail: latest.incomplete }
    }
  }

  if (shouldAutoBackground && !isBackgroundRequest) {
    shellCommand.onTimeout?.((bg: (id: string) => boolean) => {
      timeoutAutoBackgroundedAfterMs = effectiveTimeout
      void moveToBackground(bg)
    })
  }

  if (isBackgroundRequest) {
    const id = await moveToBackground()
    if (id !== undefined) {
      return {
        stdout: webNotice,
        stderr: '',
        interrupted: false,
        backgroundTaskId: id,
        scrubbedSessionEnv: shellCommand.scrubbedSessionEnv,
        ...backgroundFacts(),
      }
    }
    const result = await shellCommand.result
    shellCommand.cleanup()
    return postProcess(result, postNeeds)
  }

  return yield* runForegroundCommand({
    input,
    context,
    description,
    setToolJSX,
    setTaskState,
    requestedTimeout,
    effectiveTimeout,
    timeoutClampNotice,
    launchedAt,
    webNotice,
    shellCommand,
    postNeeds,
    backgroundFacts,
    getLatest: () => latest,
    getBackgroundId: () => backgroundId,
    getTimeoutAutoBackgroundedAfterMs: () => timeoutAutoBackgroundedAfterMs,
    getForegroundTaskId: () => foregroundTaskId,
    setForegroundTaskId: id => {
      foregroundTaskId = id
    },
    backgroundAssignedPromise,
    moveToBackground,
    readOutputSoFar,
    wake,
    waitForWake,
    clearWakeWaiter: () => {
      wakeWaiter = null
    },
  })
}

interface ForegroundRunArgs {
  input: BashToolInput
  context: ToolUseContext
  description: string
  setToolJSX: ToolUseContext['setToolJSX']
  setTaskState: NonNullable<ToolUseContext['setAppStateForTasks']>
  requestedTimeout: number | undefined
  effectiveTimeout: number
  timeoutClampNotice: string | undefined
  launchedAt: number
  webNotice: string
  shellCommand: ShellCommand
  postNeeds: PostProcessNeeds
  backgroundFacts: BackgroundFacts
  getLatest: () => { recent: string; all: string; totalLines: number; totalBytes: number | undefined; incomplete: boolean }
  getBackgroundId: () => string | undefined
  getTimeoutAutoBackgroundedAfterMs: () => number | undefined
  getForegroundTaskId: () => string | undefined
  setForegroundTaskId: (id: string | undefined) => void
  backgroundAssignedPromise: Promise<void>
  moveToBackground: (timeoutBg?: (id: string) => boolean) => Promise<string | undefined>
  readOutputSoFar: () => Promise<OutputSoFar>
  wake: () => void
  waitForWake: () => Promise<void>
  clearWakeWaiter: () => void
}

async function* runForegroundCommand(args: ForegroundRunArgs): AsyncGenerator<BashProgress, Out> {
  const {
    input,
    context,
    description,
    setToolJSX,
    setTaskState,
    requestedTimeout,
    effectiveTimeout,
    timeoutClampNotice,
    launchedAt,
    webNotice,
    shellCommand,
    postNeeds,
    backgroundFacts,
    getLatest,
    getBackgroundId,
    getTimeoutAutoBackgroundedAfterMs,
    getForegroundTaskId,
    setForegroundTaskId,
    backgroundAssignedPromise,
    moveToBackground,
    readOutputSoFar,
    wake,
    waitForWake,
    clearWakeWaiter,
  } = args

  let userBackgroundAsked = false
  let resolveUserBackground: (() => void) | null = null
  const userBackgroundPromise = new Promise<void>(resolve => {
    resolveUserBackground = resolve
  })
  const requestUserBackground = (): void => {
    userBackgroundAsked = true
    const fn = resolveUserBackground
    resolveUserBackground = null
    fn?.()
    wake()
  }
  const unregisterRun = registerShellRun({
    agentId: context.agentId,
    request: requestUserBackground,
  })

  const ensureForegroundRegistered = (): string => {
    const existing = getForegroundTaskId()
    if (existing !== undefined) return existing
    const id = context.shellInputId ?? context.toolUseId
    const registered = registerForeground(
      {
        command: input.command,
        description,
        shellCommand,
        toolUseId: id,
      },
      setTaskState,
      id,
    )
    setForegroundTaskId(registered)
    return registered
  }
  if (context.shellInputId !== undefined) {
    ensureForegroundRegistered()
  }

  type SettledResult = { ok: true; result: ExecResult } | { ok: false; error: unknown }
  let settled: SettledResult | null = null
  const readSettled = (): SettledResult | null => settled
  void shellCommand.result.then(
    result => {
      settled = { ok: true, result }
      wake()
    },
    error => {
      settled = { ok: false, error }
      wake()
    },
  )

  const settleCompleted = (result: ExecResult): Promise<Out> => {
    if (result.backgroundTaskId !== undefined) {
      markTaskNotified(result.backgroundTaskId, setTaskState)
      result.backgroundTaskId = undefined
    } else {
      const fgId = getForegroundTaskId()
      if (fgId !== undefined) {
        unregisterForeground(fgId, setTaskState)
        setForegroundTaskId(undefined)
      }
    }
    shellCommand.cleanup()
    return postProcess(result, postNeeds)
  }

  const onAbortWake = (): void => wake()
  context.abortController.signal.addEventListener('abort', onAbortWake)

  try {
    const quietWinner = await withDeadline(
      Promise.race([
        shellCommand.result.then(result => ({ kind: 'done' as const, result })),
        userBackgroundPromise.then(() => ({ kind: 'user-bg' as const })),
        backgroundAssignedPromise.then(() => ({ kind: 'bg-assigned' as const })),
      ]),
      QUIET_WINDOW_MS,
      () => ({ kind: 'window-end' as const }),
      { unref: true },
    )

    if (quietWinner.kind === 'done') {
      return await settleCompleted(quietWinner.result)
    }
    if (quietWinner.kind === 'user-bg') {
      await moveToBackground()
      const assigned = getBackgroundId()
      if (assigned !== undefined) {
        return userBackgroundedAnswer({
          webNotice,
          latest: getLatest(),
          backgroundId: assigned,
          shellCommand,
          backgroundFacts,
        })
      }
      const result = await shellCommand.result
      return await settleCompleted(result)
    }
    const quietBgId = getBackgroundId()
    if (quietBgId !== undefined) {
      const afterMs = getTimeoutAutoBackgroundedAfterMs()
      const soFar: OutputSoFar = afterMs !== undefined ? await readOutputSoFar() : { stdout: '', isTail: false }
      return timeoutBackgroundedAnswer({
        webNotice,
        soFar,
        backgroundId: quietBgId,
        shellCommand,
        timeoutAutoBackgroundedAfterMs: afterMs,
        timeoutClampNotice,
        backgroundFacts,
      })
    }

    const progressPhaseStartedAt = Date.now()
    let backgroundHintShown = false
    let interruptBackgroundingStarted = false
    let backgroundAskHandled = false
    TaskOutput.startPolling(shellCommand.taskOutput.taskId)
    try {
      for (;;) {
        const currentSettled = readSettled()
        if (currentSettled !== null) {
          if (!currentSettled.ok) throw currentSettled.error
          return await settleCompleted(currentSettled.result)
        }
        const isInterrupt =
          context.abortController.signal.aborted && context.abortController.signal.reason === 'interrupt'
        if (isInterrupt && !interruptBackgroundingStarted) {
          interruptBackgroundingStarted = true
          if (BACKGROUND_TASKS_DISABLED) {
            shellCommand.kill()
          } else {
            await moveToBackground()
          }
        }
        if (userBackgroundAsked && !backgroundAskHandled && !isInterrupt && getBackgroundId() === undefined) {
          backgroundAskHandled = true
          await moveToBackground()
        }
        const currentBgId = getBackgroundId()
        if (currentBgId !== undefined) {
          const afterMs = getTimeoutAutoBackgroundedAfterMs()
          const soFar: OutputSoFar =
            !interruptBackgroundingStarted && !backgroundAskHandled && afterMs !== undefined
              ? await readOutputSoFar()
              : { stdout: '', isTail: false }
          return loopBackgroundedAnswer({
            webNotice,
            interruptBackgroundingStarted,
            backgroundAskHandled,
            fullOutput: getLatest().all,
            soFar,
            backgroundId: currentBgId,
            shellCommand,
            timeoutAutoBackgroundedAfterMs: afterMs,
            backgroundFacts,
          })
        }
        const currentFgId = getForegroundTaskId()
        if (currentFgId !== undefined && shellCommand.status === 'backgrounded') {
          return foregroundBackgroundedAnswer({
            webNotice,
            foregroundTaskId: currentFgId,
            shellCommand,
            backgroundFacts,
          })
        }
        if (
          !backgroundHintShown &&
          !BACKGROUND_TASKS_DISABLED &&
          getBackgroundId() === undefined &&
          shellCommand.status !== 'backgrounded' &&
          setToolJSX !== undefined &&
          Date.now() - progressPhaseStartedAt >= QUIET_WINDOW_MS
        ) {
          backgroundHintShown = true
          ensureForegroundRegistered()
          setToolJSX({
            jsx: <BackgroundHint onBackground={requestUserBackground} />,
            shouldHideComposer: false,
            shouldContinueAnimation: true,
            showSpinner: true,
          })
        }
        const latestNow = getLatest()
        const elapsedMs = Date.now() - launchedAt
        const elapsedTimeSeconds = Math.floor(elapsedMs / 1000)
        let displayOutput = latestNow.recent
        if (elapsedMs >= SOFT_TIMEOUT_MS) {
          const timeoutPart = requestedTimeout ? `, timing out at ${Math.round(effectiveTimeout / 1000)}s` : ''
          displayOutput = `[still running after ${elapsedTimeSeconds}s${timeoutPart}]\n${displayOutput}`
        }
        yield {
          type: 'bash_progress',
          output: displayOutput,
          fullOutput: latestNow.all,
          elapsedTimeSeconds,
          totalLines: latestNow.totalLines,
          ...(latestNow.incomplete ? { totalBytes: latestNow.totalBytes } : {}),
          taskId: getForegroundTaskId(),
          ...(requestedTimeout ? { timeoutMs: effectiveTimeout } : {}),
          budgetMs: effectiveTimeout,
        }
        await withDeadline(waitForWake(), 1_000, clearWakeWaiter, { unref: true })
      }
    } finally {
      TaskOutput.stopPolling(shellCommand.taskOutput.taskId)
    }
  } finally {
    context.abortController.signal.removeEventListener('abort', onAbortWake)
    unregisterRun()
    const fgId = getForegroundTaskId()
    if (fgId !== undefined && getBackgroundId() === undefined && shellCommand.status !== 'backgrounded') {
      unregisterForeground(fgId, setTaskState)
    }
  }
}

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  strict: true,
  maxResultSizeChars: PERSIST_THRESHOLD_CHARS,
  straightQuoteInputs: ['command'],
  searchHint: 'Executes shell commands.',
  userFacingName,
  isEnabled() {
    return bashToolAvailable()
  },
  get inputSchema() {
    return modelInputSchema()
  },
  get inputJSONSchema() {
    return getBashInputJSONSchema()
  },
  shellCommandOf(input) {
    return stringInputField(input, 'command')
  },
  isSearchOrReadCommand(input) {
    const command = stringInputField(input, 'command')
    if (!command) return { isSearch: false, isRead: false, isList: false }
    return classifyCommand(command)
  },
  async prepare(input: BashToolInput) {
    await prepareBashReadOnly(input)
  },
  isReadOnly(input: BashToolInput) {
    return isBashReadOnly(input)
  },
  isConcurrencySafe(input: BashToolInput) {
    return isBashReadOnly(input)
  },
  async checkPermissions(input: BashToolInput, context: ToolUseContext) {
    return bashToolHasPermission(input, context.getAppState().toolPermissionContext)
  },
  preparePermissionMatcher,
  async description(input?: Partial<BashToolInput>) {
    return input?.description ?? 'Run a shell command'
  },
  async prompt(options) {
    await Promise.all([settleShellRecord(), settleLoginFiles()])
    return getSimplePrompt(new Set((options?.tools ?? []).map(tool => tool.name)))
  },
  getToolUseSummary(input?: Partial<BashToolInput>) {
    const command = stringInputField(input, 'command')
    if (!command) return null
    return input?.description ?? truncateForSummary(command)
  },
  getActivityDescription(input?: Partial<BashToolInput>) {
    const command = stringInputField(input, 'command')
    if (!command) return 'Running a shell command'
    const summary = input?.description ?? truncateForSummary(command)
    return `Running ${summary}`
  },
  async validateInput(input: BashToolInput) {
    const cwdRefusal = controlCharacterPathRefusal(input.cwd)
    if (cwdRefusal !== null) {
      return { result: false, message: cwdRefusal, errorCode: 1 }
    }
    if (input.command.trim() === '') {
      return { result: false, message: EMPTY_COMMAND_REFUSAL, errorCode: 1 }
    }
    const budgetRefusal = refuseMaxOutputChars(input.max_output_chars)
    if (budgetRefusal !== undefined) {
      return { result: false, message: budgetRefusal, errorCode: 2 }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  mapToolResultToToolResultBlockParam: mapResultToBlock,
  extractSearchText(output: Out) {
    return output.stderr ? `${output.stdout}\n${output.stderr}` : output.stdout
  },
  isResultTruncated(output: Out) {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr)
  },
  async call(input: BashToolInput, context: ToolUseContext, _canUseTool: CanUseToolFn, parentAssistantMessage: AssistantMessage, onProgress) {
    try {
      if (input._simulatedSedEdit !== undefined) {
        return await runSimulatedSedEdit(input._simulatedSedEdit, input.cwd, context, parentAssistantMessage)
      }
      const generator = runShellCommand(input, context)
      const baseId = context.toolUseId ?? 'bash'
      let counter = 0
      for (;;) {
        const next = await generator.next()
        if (next.done) {
          const out = next.value
          const notice = sessionEnvNoticeForResult({
            scrubbed: out.scrubbedSessionEnv,
            commandText: input.command,
          })
          const data: Out = notice !== '' ? { ...out, sessionEnvNotice: notice } : out
          return { data }
        }
        counter += 1
        onProgress?.({ toolUseID: `${baseId}-${counter}`, data: next.value })
      }
    } finally {
      context.setToolJSX?.(null)
    }
  },
})
