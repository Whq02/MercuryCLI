
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import {
  addToTurnHookDuration,
  getIsNonInteractiveSession,
  getMainThreadAgentType,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
} from '../../bootstrap/state.js'
import type {
  AsyncHookJSONOutput,
  HookEvent,
} from 'src/entrypoints/agentSdkTypes.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { pathExists } from '../file.js'
import { registerPendingAsyncHook } from '../hooks/AsyncHookRegistry.js'
import { boundHookContext } from './contextBound.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { wrapInSystemReminder } from '../messages.js'
import { getPlatform } from '../platform.js'
import { getExtensionDataDir } from '../../extensions/paths.js'
import { loadOptionValues, optionEnv, substituteOptionsInCommand, type OptionValues } from '../../extensions/options.js'
import { optionSchemaFor } from '../../extensions/load/optionSchema.js'
import { recordHookFailure } from '../../extensions/health.js'
import {
  getHookEnvFilePath,
} from '../sessionEnvironment.js'
import { getTranscriptPathForSession } from '../sessionStorage.js'
import type { ShellCommand } from '../ShellCommand.js'
import { wrapSpawn } from '../ShellCommand.js'
import { buildPowerShellArgs } from '../shell/powershellProvider.js'
import { getCachedPowerShellPath } from '../shell/powershellDetection.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { TaskOutput } from '../task/TaskOutput.js'
import { hookBashShell } from '../shell/windowsShellRoad.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { firstLineOf } from '../stringUtils.js'
import type { HookCommand } from '../settings/types.js'
import {
  promptRequestSchema,
  type PromptRequest,
  type PromptResponse,
} from '../../types/hooks.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  emitHookResponse,
  startHookProgressInterval,
} from './hookEvents.js'
import { isAsyncHookJSONOutput } from '../../types/hooks.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'

export const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

export const HOOK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024

const HOOK_STREAM_SETTLE_GRACE_MS = 2_000
const TRUNCATION_NOTE = '\n[hook output truncated at 10MB]'

const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
export function getSessionEndHookTimeoutMs(): number {
  return SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

export function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  extensionId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  extensionId?: string
}): boolean {
  if (asyncRewake) {
    void shellCommand.result.then(async result => {
      await new Promise(resolve => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${boundHookContext(stderr || stdout, `${hookName}-stop-block`).text}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  if (!shellCommand.background(processId)) {
    return false
  }

  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    extensionId,
  })

  return true
}

export function winShHookCommand(command: string): string {
  const trimmed = command.trim()
  const firstToken = /^("[^"]*\.sh"|'[^']*\.sh'|\S+\.sh)(?:\s|$)/.exec(trimmed)
  if (!firstToken || trimmed.startsWith('bash ')) return command
  const rawFirst = firstToken[1]!
  const unquoted = rawFirst.replace(/^["']|["']$/g, '')
  if (!unquoted.includes('\\')) return `bash ${command}`
  const forward = unquoted.replace(/\\/g, '/')
  const quoted = forward.includes("'") ? `"${forward}"` : `'${forward}'`
  const rest = trimmed.slice(rawFirst.length).trim()
  return rest ? `bash ${quoted} ${rest}` : `bash ${quoted}`
}

export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}

export async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  extensionRoot?: string,
  extensionId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>,
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}> {
  const shouldEmitDiag =
    hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  const toHookPath =
    isWindows && !isPowerShell
      ? (p: string) => windowsPathToPosixPath(p)
      : (p: string) => p

  const projectDir = getProjectRoot()

  let command = hook.command
  let extensionOptions: OptionValues | undefined
  if (extensionRoot) {
    if (!(await pathExists(extensionRoot))) {
      throw new Error(
        `Extension folder does not exist: ${extensionRoot}` +
          (extensionId ? ` (${extensionId} — /extensions shows its state)` : ''),
      )
    }
    const rootPath = toHookPath(extensionRoot)
    command = command.replace(/\$\{MERCURY_EXTENSION_ROOT\}/g, () => rootPath)
    if (extensionId) {
      const dataPath = toHookPath(getExtensionDataDir(extensionId))
      command = command.replace(/\$\{MERCURY_EXTENSION_DATA\}/g, () => dataPath)
      extensionOptions = loadOptionValues(extensionId, optionSchemaFor(extensionId))
      command = substituteOptionsInCommand(command, extensionOptions)
    }
  }

  if (isWindows && !isPowerShell) {
    command = winShHookCommand(command)
  }

  const hookShellPrefix = process.env.MERCURY_SHELL_PREFIX
  const finalCommand =
    !isPowerShell && hookShellPrefix
      ? formatShellPrefixCommand(hookShellPrefix, command)
      : command

  const hookTimeoutMs = hook.timeout
    ? hook.timeout * 1000
    : TOOL_HOOK_EXECUTION_TIMEOUT_MS

  const hookProjectDir = toHookPath(projectDir)
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    MERCURY_PROJECT_DIR: hookProjectDir,
  }

  if (extensionRoot) {
    const rootPath = toHookPath(extensionRoot)
    envVars['MERCURY_EXTENSION_ROOT'] = rootPath
    if (extensionId) {
      const dataPath = toHookPath(getExtensionDataDir(extensionId))
      envVars['MERCURY_EXTENSION_DATA'] = dataPath
    }
  }
  if (extensionOptions) {
    Object.assign(envVars, optionEnv(extensionOptions))
  }
  if (skillRoot) {
    const skillPath = toHookPath(skillRoot)
    envVars['MERCURY_EXTENSION_ROOT'] = skillPath
  }

  if (
    !isPowerShell &&
    (hookEvent === 'SessionStart' ||
      hookEvent === 'Setup' ||
      hookEvent === 'CwdChanged' ||
      hookEvent === 'FileChanged') &&
    hookIndex !== undefined
  ) {
    envVars.MERCURY_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
  }

  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(
      `Hooks: cwd ${hookCwd} not found, falling back to original cwd`,
      { level: 'warn' },
    )
  }

  let child: ChildProcessWithoutNullStreams
  if (shellType === 'powershell') {
    const pwshPath = await getCachedPowerShellPath()
    if (!pwshPath) {
      throw new Error(
        `Hook "${hook.command}" has shell: 'powershell' but no PowerShell ` +
          `executable (pwsh or powershell) was found on PATH. Install ` +
          `PowerShell, or remove "shell": "powershell" to use bash.`,
      )
    }
    child = spawn(pwshPath, buildPowerShellArgs(finalCommand), {
      env: envVars,
      cwd: safeCwd,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  } else {
    const shell = isWindows ? hookBashShell(hook.command) : true
    child = spawn(finalCommand, [], {
      env: envVars,
      cwd: safeCwd,
      shell,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  }

  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  let shellCommandTransferred = false
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(
      `Hooks: Config-based async hook, backgrounding process ${processId}`,
    )

    child.stdin.write(jsonInput + '\n', 'utf8')
    child.stdin.end()
    stdinWritten = true

    const backgrounded = executeInBackground({
      processId,
      hookId,
      shellCommand,
      asyncResponse: { async: true, asyncTimeout: hookTimeoutMs },
      hookEvent,
      hookName,
      command: hook.command,
      asyncRewake: hook.asyncRewake,
      extensionId,
    })
    if (backgrounded) {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: 0,
        backgrounded: true,
      }
    }
  }

  let stdout = ''
  let stderr = ''
  let output = ''

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let initialResponseChecked = false

  let asyncResolve:
    | ((result: {
        stdout: string
        stderr: string
        output: string
        status: number
      }) => void)
    | null = null
  const childIsAsyncPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    asyncResolve = resolve
  })

  const processedPromptLines = new Set<string>()
  let promptChain = Promise.resolve()
  let lineBuffer = ''

  child.stdout.on('data', data => {
    if (stdout.length < HOOK_OUTPUT_MAX_BYTES) {
      stdout += data
      output += data
      if (stdout.length >= HOOK_OUTPUT_MAX_BYTES) {
        stdout = stdout.slice(0, HOOK_OUTPUT_MAX_BYTES) + TRUNCATION_NOTE
        output = output.slice(0, HOOK_OUTPUT_MAX_BYTES) + TRUNCATION_NOTE
      }
    }

    if (requestPrompt) {
      lineBuffer += data
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = jsonParse(trimmed)
          const validation = promptRequestSchema().safeParse(parsed)
          if (validation.success) {
            processedPromptLines.add(trimmed)
            logForDebugging(
              `Hooks: Detected prompt request from hook: ${trimmed}`,
            )
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(jsonStringify(response) + '\n', 'utf8')
              } catch (err) {
                logForDebugging(`Hooks: Prompt request handling failed: ${err}`)
                child.stdin.destroy()
              }
            })
            continue
          }
        } catch {
        }
      }
    }

    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      if (!firstLine.includes('}')) return
      initialResponseChecked = true
      logForDebugging(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        logForDebugging(
          `Hooks: Parsed initial response: ${jsonStringify(parsed)}`,
        )
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          logForDebugging(
            `Hooks: Detected async hook, backgrounding process ${processId}`,
          )

          const backgrounded = executeInBackground({
            processId,
            hookId,
            shellCommand,
            asyncResponse: parsed,
            hookEvent,
            hookName,
            command: hook.command,
            extensionId,
          })
          if (backgrounded) {
            shellCommandTransferred = true
            asyncResolve?.({
              stdout,
              stderr,
              output,
              status: 0,
            })
          }
        } else if (isAsyncHookJSONOutput(parsed) && forceSyncExecution) {
          logForDebugging(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          logForDebugging(
            `Hooks: Initial response is not async, continuing normal processing`,
          )
        }
      } catch (e) {
        logForDebugging(`Hooks: Failed to parse initial response as JSON: ${e}`)
      }
    }
  })

  child.stderr.on('data', data => {
    if (stderr.length < HOOK_OUTPUT_MAX_BYTES) {
      stderr += data
      output += data
      if (stderr.length >= HOOK_OUTPUT_MAX_BYTES) {
        stderr = stderr.slice(0, HOOK_OUTPUT_MAX_BYTES) + TRUNCATION_NOTE
      }
    }
  })

  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => ({ stdout, stderr, output }),
  })

  const stdoutEndPromise = new Promise<void>(resolve => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>(resolve => {
    child.stderr.on('end', () => resolve())
  })

  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', err => {
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(
              `Hooks: stdin error during prompt flow (likely process exited): ${err}`,
            )
          }
        })
        child.stdin.write(jsonInput + '\n', 'utf8')
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  const childClosePromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    let exitCode: number | null = null

    child.on('close', code => {
      exitCode = code ?? 1

      void Promise.all([stdoutEndPromise, stderrEndPromise]).then(() => {
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter(line => !processedPromptLines.has(line.trim()))
                .join('\n')

        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: exitCode!,
          aborted: signal.aborted,
        })
      })
    })
  })

  const childExitBoundedPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    child.on('exit', code => {
      const timer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter(line => !processedPromptLines.has(line.trim()))
                .join('\n')
        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: code ?? 1,
          aborted: signal.aborted,
        })
      }, HOOK_STREAM_SETTLE_GRACE_MS)
      timer.unref?.()
    })
  })

  try {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_started', {
        hook_event_name: hookEvent,
        index: hookIndex,
      })
    }
    await Promise.race([stdinWritePromise, childErrorPromise])

    const result = await Promise.race([
      childIsAsyncPromise,
      childClosePromise,
      childErrorPromise,
      childExitBoundedPromise,
    ])
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    const code = getErrnoCode(error)
    diagExitCode = 1

    if (code === 'EPIPE') {
      logForDebugging(
        'EPIPE error while writing to hook stdin (hook command likely closed early)',
      )
      const errMsg =
        'Hook command closed stdin before hook input was fully written (EPIPE)'
      return {
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        status: 1,
      }
    } else if (code === 'ABORT_ERR') {
      diagAborted = true
      return {
        stdout: '',
        stderr: 'Hook cancelled',
        output: 'Hook cancelled',
        status: 1,
        aborted: true,
      }
    } else {
      const errorMsg = errorMessage(error)
      const errOutput = `Error occurred while executing hook command: ${errorMsg}`
      return {
        stdout: '',
        stderr: errOutput,
        output: errOutput,
        status: 1,
      }
    }
  } finally {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_completed', {
        hook_event_name: hookEvent,
        index: hookIndex,
        duration_ms: Date.now() - diagStartMs,
        exit_code: diagExitCode,
        aborted: diagAborted,
      })
    }
    stopProgressInterval()
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
  }
}
