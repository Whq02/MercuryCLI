import { z } from 'zod/v4'
import { buildTool, stringInputField, type ToolUseContext, type ToolResult, type ToolPermissionContext } from '../../Tool.js'
import { bashToolAvailable } from '../../utils/shell/windowsShellRoad.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { exec } from '../../utils/Shell.js'
import { HARD_CAP_MULTIPLIER } from '../../utils/ShellCommand.js'
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
import { ShellError, isAbortError } from '../../utils/errors.js'
import { EndTruncatingAccumulator } from '../../utils/stringUtils.js'
import { formatDuration } from '../../utils/format.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { recordBashAudit } from '../../utils/spawnLedger.js'
import { trackGitOperations } from '../../tools/shared/gitOperationTracking.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
  getDisplayPath,
} from '../../utils/file.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { persistToolResult, buildLargeToolResultMessage, generatePreview, PREVIEW_SIZE_CHARS } from '../../utils/toolResultStorage.js'
import { interpretCommandResult } from './commandSemantics.js'
import { getDefaultTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from './prompt.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import { firstCommandWord } from '../../utils/shell/shellToolUtils.js'
import { isSedInPlaceEdit, parseSedEditCommand, applySedSubstitution } from './sedEditParser.js'
import { checkReadOnlyConstraints } from './readOnlyValidation.js'
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
  buildImageToolResult,
  resizeShellImageOutput,
  resetCwdIfOutsideProject,
  stdErrAppendShellResetMessage,
} from './utils.js'
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
import { readFileSync, existsSync } from 'node:fs'
import { copyFile, link, stat, truncate } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'

export type { BashProgress }


const ASSISTANT_BLOCKING_BUDGET_MS = 15_000
const QUIET_WINDOW_MS = 2_000
const SOFT_TIMEOUT_MS = 30_000
const PERSIST_THRESHOLD_CHARS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const BACKGROUND_TASKS_DISABLED = false

const NEVER_AUTO_BACKGROUND = new Set(['sleep'])


function bashDescriptionGuide(): string {
  return [
    'Describe what the command does, in active voice. Do not use the words "complex" or "risk".',
    'For an everyday single-tool command, a brief phrase of roughly five to ten words is enough:',
    '  ls -la → "List files in the current directory"',
    '  git status → "Show the working-tree status"',
    'For a command that is harder to read at a glance — a pipeline, an unusual flag — add enough',
    'context to make the intent clear:',
    '  find . -name "*.tmp" -delete → "Find and delete every .tmp file recursively"',
    '  curl -s url | jq ".data[]" → "Fetch JSON and extract each element of its data array"',
  ].join('\n')
}

function buildModelSchema() {
  return z.strictObject({
    command: z.string().describe('The command to execute'),
    timeout: semanticNumber(z.number().optional()).describe(
      `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`,
    ),
    description: z.string().optional().describe(bashDescriptionGuide()),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(
      'Set to true to run the command in the background and read its output later with the file-reading tool.',
    ),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe(
      'An explicit, dangerous override that runs the command without sandboxing.',
    ),
  })
}

const modelInputSchema = lazySchema(buildModelSchema)
type ModelInput = z.infer<ReturnType<typeof buildModelSchema>>

export type BashToolInput = ModelInput & {
  _simulatedSedEdit?: { filePath: string; newContent: string }
}


export type Out = {
  stdout: string
  stderr: string
  interrupted: boolean
  isImage?: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  assistantAutoBackgrounded?: boolean
  timeoutAutoBackgroundedAfterMs?: number
  dangerouslyDisableSandbox?: boolean
  returnCodeInterpretation?: string
  noOutputExpected?: boolean
  persistedOutputPath?: string
  persistedOutputSize?: number
  structuredContent?: ToolResultBlockParam['content']
  rawOutputPath?: string
}


const NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])
const SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'])
const LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const REDIRECT_OPERATORS = new Set(['>', '>>', '>&'])
const CONTROL_OPERATORS = new Set(['||', '&&', '|', ';'])
const SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait'])

export function isSearchOrReadBashCommand(command: string): { isSearch: boolean; isRead: boolean; isList: boolean } {
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

function commandChangesDirectory(command: string): boolean {
  return pinnedCommandAnalysis.splitCommand(command).some(sub => /^\s*(?:cd|pushd|popd)\b/.test(sub))
}

function isBashReadOnly(input: BashToolInput): boolean {
  const hasCd = commandChangesDirectory(input.command)
  return checkReadOnlyConstraints({ command: input.command }, hasCd).behavior === 'allow'
}


async function preparePermissionMatcher(input: BashToolInput): Promise<(pattern: string) => boolean> {
  const parsed = await parseForSecurity(input.command)
  if (parsed.kind !== 'simple') {
    return () => true
  }
  const argvTexts = parsed.commands.map(command => command.argv.join(' '))
  return (pattern: string): boolean => {
    const rule = pinnedCommandAnalysis
    void rule
    const prefix = extractLegacyPrefix(pattern)
    return argvTexts.some(argv =>
      prefix !== null
        ? argv === prefix || argv.startsWith(prefix + ' ')
        : matchGlob(pattern, argv),
    )
  }
}

function extractLegacyPrefix(pattern: string): string | null {
  return pattern.endsWith(':*') && pattern.length > 2 ? pattern.slice(0, -2) : null
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
  const sed = input._simulatedSedEdit as { filePath: string; newContent: string }
  const filePath = expandToAbsolute(sed.filePath)
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
  const original = readFileSync(filePath, encoding)
  writeTextContent(filePath, sed.newContent, encoding, endings)
  notifyVscodeFileUpdated(filePath, original, sed.newContent)
  context.readFileState.set(filePath, {
    content: sed.newContent,
    timestamp: getFileModificationTime(filePath),
    offset: undefined,
    limit: undefined,
  })
  return { stdout: '', stderr: '', interrupted: false }
}

function expandToAbsolute(path: string): string {
  if (path.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return home + path.slice(1)
  }
  return isAbsolute(path) ? path : join(getCwd(), path)
}


async function* runBash(
  input: BashToolInput,
  context: ToolUseContext,
  agentId: string | undefined,
): AsyncGenerator<{ toolUseID: string; data: BashProgress }, Out, void> {
  const abortController = context.abortController
  const isMainThread = agentId === undefined
  const setToolJSX = context.setToolJSX

  const requestedTimeout = input.timeout
  const effectiveTimeout = Math.min(requestedTimeout || getDefaultTimeoutMs(), getMaxTimeoutMs())
  const useSandbox = shouldUseSandbox(input)
  const firstSubcommand = pinnedCommandAnalysis.splitCommand(input.command)[0]?.trim() ?? input.command.trim()
  const shouldAutoBackground = !BACKGROUND_TASKS_DISABLED && !NEVER_AUTO_BACKGROUND.has(firstCommandWord(firstSubcommand))

  let progressResolve: (() => void) | null = null
  let latest: { recent: string; all: string; lines: number; bytes: number; incomplete: boolean } = {
    recent: '',
    all: '',
    lines: 0,
    bytes: 0,
    incomplete: false,
  }
  const shellCommand = await exec(input.command, abortController.signal, 'bash', {
    timeout: effectiveTimeout,
    preventCwdChanges: !isMainThread,
    shouldUseSandbox: useSandbox,
    shouldAutoBackground,
    backgroundIntent: input.run_in_background === true && !BACKGROUND_TASKS_DISABLED,
    onProgress: (recent, all, lines, bytes, incomplete) => {
      latest = { recent, all, lines, bytes: incomplete ? bytes : 0, incomplete }
      progressResolve?.()
    },
  })

  let assistantAutoBackgrounded = false
  let timeoutAutoBackgroundedAfterMs: number | undefined
  let foregroundTaskId: string | null = null
  let backgroundId: string | undefined

  const startBackgrounding = async (fromTrigger?: (id: string) => void): Promise<void> => {
    if (foregroundTaskId !== null) {
      const converted = backgroundExistingForegroundTask(
        foregroundTaskId,
        shellCommand,
        input.description ?? input.command,
        context.setAppState,
        context.toolUseId,
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
        agentId: agentId as never,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('spawn must not read app state')
        },
        setAppState: context.setAppState,
      },
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
      {
        command: input.command,
        description: input.description ?? input.command,
        shellCommand,
        toolUseId: context.toolUseId,
        agentId: agentId as never,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('spawn must not read app state')
        },
        setAppState: context.setAppState,
      },
    )
    return { stdout: '', stderr: '', interrupted: false, backgroundTaskId: handle.taskId }
  }

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
    return {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: backgroundId,
      assistantAutoBackgrounded,
      timeoutAutoBackgroundedAfterMs,
    }
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
        markTaskNotified(settled.backgroundTaskId, context.setAppState)
        const reconstructed = reconstructLargeOutput(settled, shellCommand)
        shellCommand.cleanup()
        return await postProcess({ ...reconstructed, backgroundTaskId: undefined })
      }

      if (settled) {
        if (foregroundTaskId !== null) unregisterForeground(foregroundTaskId, context.setAppState)
        shellCommand.cleanup()
        return await postProcess(settled)
      }

      if (!interruptBackgroundingStarted && abortController.signal.reason === 'interrupt') {
        interruptBackgroundingStarted = true
        if (BACKGROUND_TASKS_DISABLED) {
          shellCommand.kill()
        } else {
          await startBackgrounding()
        }
      }

      if (backgroundId !== undefined) {
        const fullOutput = latest.all
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: backgroundId,
          assistantAutoBackgrounded,
          timeoutAutoBackgroundedAfterMs,
        }
      }

      if (foregroundTaskId !== null && shellCommand.status === 'backgrounded') {
        return {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: foregroundTaskId,
          backgroundedByUser: true,
        }
      }

      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      if (!BACKGROUND_TASKS_DISABLED && backgroundId === undefined && Date.now() - startedAt >= QUIET_WINDOW_MS && setToolJSX) {
        if (foregroundTaskId === null) {
          foregroundTaskId = registerForeground(
            { command: input.command, description: input.description ?? input.command, shellCommand, toolUseId: context.toolUseId },
            context.setAppState,
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


  async function postProcess(result: ExecResult): Promise<Out> {
    if (result.backgroundTaskId === undefined) {
      trackGitOperations(input.command, result.code, result.stdout)
    }

    const accumulator = new EndTruncatingAccumulator()
    accumulator.append(result.stdout.trimEnd() + '\n')
    if (result.stderr.trim() !== '') accumulator.append(result.stderr.trimEnd() + '\n')
    const interpretation = interpretCommandResult(input.command, result.code, result.stdout, '')
    const returnCodeInterpretation = interpretation.message
    const noOutputExpected = isSilentCommand(input.command)
    const interruptedByUser = result.interrupted && abortController.signal.reason === 'interrupt'
    if (interpretation.isError && !interruptedByUser && result.code !== 0) {
      accumulator.append(`\nExited with code ${result.code}`)
    }

    let stderr = ''
    if (isMainThread) {
      const appContext = context.getAppState().toolPermissionContext as ToolPermissionContext
      if (resetCwdIfOutsideProject(appContext)) {
        stderr = stdErrAppendShellResetMessage(stderr)
      }
    }

    let out = accumulator.toString()
    out = SandboxManager.annotateStderrWithSandboxFailures(input.command, out)

    if (result.preSpawnError) {
      throw new ShellError('', result.preSpawnError, result.code, result.interrupted)
    }
    if (interpretation.isError && !interruptedByUser) {
      throw new ShellError('', out, result.code, result.interrupted)
    }

    let persistedOutputPath: string | undefined
    let persistedOutputSize: number | undefined
    if (result.outputFilePath && result.outputTaskId) {
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
      } catch {
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

    const formatted = formatOutput(out, { preExcerpted: result.outputFilePath !== undefined })
    return {
      stdout: formatted.truncatedContent,
      stderr,
      interrupted: result.interrupted,
      isImage,
      returnCodeInterpretation,
      noOutputExpected,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      ...(persistedOutputPath ? { persistedOutputPath, persistedOutputSize } : {}),
    }
  }
}

function reconstructLargeOutput(result: ExecResult, shellCommand: { taskOutput: { outputFileRedundant: boolean } }): ExecResult {
  if (result.outputFilePath && !shellCommand.taskOutput.outputFileRedundant) {
    return { ...result }
  }
  return result
}


function mapResultToBlock(output: Out, toolUseID: string): ToolResultBlockParam {
  if (output.structuredContent) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: output.structuredContent }
  }
  if (output.isImage) {
    const image = buildImageToolResult(output.stdout, toolUseID)
    if (image) return image
  }
  let stdout = output.stdout.replace(/^\s*\n/g, '').trimEnd()
  if (output.persistedOutputPath) {
    const { preview, hasMore } = generatePreview(stdout, PREVIEW_SIZE_CHARS)
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
    const sep = output.stderr !== '' ? '\n' : '\n'
    errorText += `${sep}<error>The command was aborted before completion.</error>`
  }
  const backgroundNotice = output.backgroundTaskId ? backgroundNoticeFor(output) : ''
  const content = [stdout, errorText, backgroundNotice].filter(part => part !== '').join('\n')
  return { tool_use_id: toolUseID, type: 'tool_result', content, is_error: output.interrupted }
}

function backgroundNoticeFor(output: Out): string {
  const id = output.backgroundTaskId as string
  const outputPath = getTaskOutputPath(id)
  if (output.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${id}. It is still running — you will be notified when it completes. Output: ${outputPath}. Delegate long-running work to a sub-agent, or pass run_in_background, to keep the conversation responsive.`
  }
  if (output.backgroundedByUser) {
    return `You moved this command to the background (ID: ${id}). Output: ${outputPath}.`
  }
  if (output.timeoutAutoBackgroundedAfterMs) {
    return `Command timed out after ${formatDuration(output.timeoutAutoBackgroundedAfterMs)} and was moved to the background with ID: ${id}. It is still running under an absolute deadline of ${HARD_CAP_MULTIPLIER}× the timeout, after which it will be killed. Output: ${outputPath}. Pass a larger timeout for work that legitimately needs it, or run_in_background for service-style commands.`
  }
  return `Running in the background (ID: ${id}). Output: ${outputPath}.`
}


export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  searchHint: 'Executes shell commands.',
  get inputSchema() {
    return modelInputSchema()
  },
  get inputJSONSchema() {
    const schema = z.toJSONSchema(modelInputSchema()) as { properties?: Record<string, unknown>; required?: string[] }
    if (BACKGROUND_TASKS_DISABLED && schema.properties) {
      delete schema.properties.run_in_background
    }
    return schema as never
  },
  maxResultSizeChars: PERSIST_THRESHOLD_CHARS,
  strict: true,
  isEnabled: () => bashToolAvailable(),
  async description(input: BashToolInput): Promise<string> {
    return input?.description ?? 'Run a shell command'
  },
  async prompt(): Promise<string> {
    return getSimplePrompt()
  },
  userFacingName,
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
  toAutoClassifierInput(input: BashToolInput): string {
    return input.command
  },
  getToolUseSummary(input: Partial<BashToolInput> | undefined): string | null {
    if (!input?.command) return null
    return input.description ?? truncateForSummary(input.command)
  },
  getActivityDescription(input: Partial<BashToolInput> | undefined): string | null {
    if (!input?.command) return 'Running a shell command'
    return `Running ${input.description ?? truncateForSummary(input.command)}`
  },
  async validateInput() {
    return { result: true as const }
  },
  async checkPermissions(input: BashToolInput, context: ToolUseContext) {
    return bashToolHasPermission(input, context.getAppState().toolPermissionContext as ToolPermissionContext)
  },
  preparePermissionMatcher,
  async call(
    input: BashToolInput,
    context: ToolUseContext,
    _canUseTool?: unknown,
    parentMessage?: { uuid?: string },
    onProgress?: (progress: { toolUseID: string; data: BashProgress }) => void,
  ): Promise<ToolResult<Out>> {
    const agentId = context.agentId as string | undefined
    const parentMessageId = parentMessage?.uuid
    try {
      if (input._simulatedSedEdit) {
        return { data: await runSimulatedSedEdit(input, context, parentMessageId) }
      }
      const generator = runBash(input, context, agentId)
      let counter = 0
      let step = await generator.next()
      while (!step.done) {
        counter++
        onProgress?.({ toolUseID: `${context.toolUseId ?? 'bash'}-${counter}`, data: step.value.data })
        step = await generator.next()
      }
      return { data: step.value }
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

const TOOL_USE_SUMMARY_LIMIT = 100
function truncateForSummary(command: string): string {
  return command.length > TOOL_USE_SUMMARY_LIMIT ? command.slice(0, TOOL_USE_SUMMARY_LIMIT) : command
}
