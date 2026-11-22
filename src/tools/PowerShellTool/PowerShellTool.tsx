import { z } from 'zod/v4'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { buildTool, stringInputField, type ToolUseContext, type ToolResult } from '../../Tool.js'
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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const SLEEP_THRESHOLD_SECONDS = 2

function detectBlockedSleepPattern(command: string): string | null {
  const trimmed = command.trim()
  const firstStatement = (trimmed.split(/[;|&\r\n]/)[0] ?? '').trim()
  const match = firstStatement.match(/^(?:start-sleep|sleep)(?:\s+(?:-s(?:econds)?)?\s*)?(\d+(?:\.\d+)?)\s*$/i)
  if (!match) return null
  const seconds = parseFloat(match[1] as string)
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

function backgroundNoticeFor(output: Out): string {
  const id = output.backgroundTaskId as string
  const outputPath = getTaskOutputPath(id)
  if (output.backgroundedByUser) return `You moved this command to the background (ID: ${id}). Output: ${outputPath}.`
  return `Running in the background (ID: ${id}). Output: ${outputPath}.`
}


export const PowerShellTool: Unbuilt = unbuilt('src/tools/PowerShellTool/PowerShellTool.tsx:438')

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
