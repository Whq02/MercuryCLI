// Hook execution plumbing — timeouts, background dispatch (async +
// asyncRewake with the in-memory capture caveat), the trust gate, base hook
// input, and execCommandHook (the bash/PowerShell spawner with
// extension/skill variable substitution, env-file capture, and Windows path
// handling). Owned Mercury module.

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
import { findGitBashPath, windowsPathToPosixPath } from '../windowsPaths.js'
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

/**
 * The output bound: a hook that floods stdout/stderr is truncated at this
 * many bytes per stream — the run completes, the tail is marked, and the
 * session never buffers an unbounded child. (The hooks kernel rule:
 * output is bounded.)
 */
export const HOOK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024

/** After the child EXITS, how long the settle waits for still-open stdio
 *  streams to end before destroying them and settling with what was read —
 *  the pipe-holding-orphan wedge (field w4-f08-01): a hook's forked child
 *  can inherit and hold the pipes past the parent's death, and 'close'
 *  (which waits on the streams) then never fires at all. */
const HOOK_STREAM_SETTLE_GRACE_MS = 2_000
const TRUNCATION_NOTE = '\n[hook output truncated at 10MB]'

/**
 * The shutdown leash. SessionEnd hooks fire while the process is leaving
 * (quit, /clear) — the ten-minute tool-hook budget would hold the exit
 * hostage, so they get 1.5s. One number serves as both the per-hook
 * default and the whole batch's abort cap: the batch is parallel, so its
 * wall clock IS its slowest hook. No env override exists.
 */
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
    // The rewake lane skips the async-hook registry: the process runs to
    // completion on its own, and only a blocking exit (code 2) comes back —
    // enqueued as a task-notification that wakes an idle model or rides a
    // queued_command attachment into a busy one.
    //
    // shellCommand.background() is deliberately NOT called on this lane: it
    // spills TaskOutput to disk, and disk mode returns '' from getStderr(),
    // which would erase the very feedback the rewake exists to deliver. The
    // stream wrappers stay attached and keep filling the in-memory buffers.
    // Abort semantics come from the wrapper: an 'interrupt' (new prompt) is
    // ignored so the hook survives it, a hard cancel (Escape) kills it.
    void shellCommand.result.then(async result => {
      // 'exit' can beat the final stdio 'data' events; one setImmediate
      // lets the stream handlers drain into TaskOutput before it is read.
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
        // The rewake lane's in-memory buffers are uncapped by design (see
        // above) — the seam bound here is what keeps a flooding Stop hook
        // from wedging the session it wakes.
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

  // Registry lane: backgrounding hands capture to the ShellCommand's own
  // TaskOutput — no listeners of ours required.
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

/**
 * The win32 `.sh` accommodation (exported for proofs). Prepend `bash` only
 * when the command's FIRST token is a .sh script — bare or quoted (a
 * Windows path with spaces is quoted): a match-anywhere test once turned
 * `npm run format && ./fix.sh` into `bash npm run format && …` (TASK-017
 * S2, hook-sh-prepend-clobbers-compound). And the WINDOWS ABSOLUTE
 * spelling must survive the hand-off (FC-084): prepended unquoted, every
 * backslash is a bash escape — the operator's `C:\hooks\probe.sh` was
 * looked up as `C:hooksprobe.sh` and never ran, with the mangled spelling
 * reaching only the debug log. A backslash-carrying first token is
 * re-spelled with forward slashes (the one spelling git-bash and Windows
 * both read) and quoted so spaces survive too.
 */
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

/**
 * The workspace-trust gate: true means skip the hook.
 *
 * Hooks are commands a settings file placed in the workspace's config homes
 * asked Mercury to run — a workspace the operator has not trusted must not
 * get to run anything, ever. The gate is blanket by design: the hooks
 * config snapshot is captured BEFORE the trust dialog resolves, so rather
 * than reasoning about which code paths could fire a hook pre-trust (two
 * such leaks shipped historically — SessionEnd on a declined dialog,
 * SubagentStop on a fast subagent), every hook execution asks this one
 * question first.
 *
 * Non-interactive (SDK) sessions have no trust dialog; trust is implicit
 * in having been embedded, so the gate stays open there.
 */
export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * The fields every hook input starts from: session identity, the
 * transcript's on-disk path, and the working directory, plus permission
 * mode and agent identity when the caller carries them.
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // The two-field shape (never ToolUseContext itself) keeps Tool.ts off
  // this module's import graph while still accepting a toolUseContext
  // structurally.
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
  // agent_type resolution: a caller-carried subagent type outranks the
  // session's --agent flag value. A hook script can then tell "subagent
  // under an --agent session" from "the --agent main thread itself" by
  // whether agent_id accompanies it.
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

/**
 * The command-hook spawner. Each hook names its shell (`shell` field,
 * bash when silent); the bash lane carries the historical behavior while
 * the PowerShell lane runs pwsh with a clean argv and OPTS OUT of every
 * bash-ism — path-dialect conversion, the .sh interpreter prepend, the
 * POSIX-quoted MERCURY_SHELL_PREFIX wrapper. The two-lane contract is
 * a deliberate two-lane split.
 */
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
  // Diag markers only for the once-per-session events, keeping diag_log
  // volume bounded; started/completed pair inside try/finally so a
  // setup-path throw cannot orphan a started marker (an orphan reads as a
  // hang in the diagnostics).
  const shouldEmitDiag =
    hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  //
  // Which lane? The hook's own `shell` field wins; DEFAULT_HOOK_SHELL
  // fills silence. (A settings.defaultShell middle layer is the design's
  // phase 2 — deliberately unwired here.) Choosing powershell opts the
  // hook out of every Windows bash accommodation below, not just the
  // spawn shape.
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  //
  // Path dialect per shell. Windows bash hooks run under Git Bash, which
  // reads only POSIX spellings (/c/Users/foo) — so every path handed to the
  // command string or the env goes through windowsPathToPosixPath (pure-JS,
  // no cygpath shell-out; UNC preserved; LRU-memoized). PowerShell wants
  // the platform's native spelling on every OS, so its converter is
  // identity.
  const toHookPath =
    isWindows && !isPowerShell
      ? (p: string) => windowsPathToPosixPath(p)
      : (p: string) => p

  // Set MERCURY_PROJECT_DIR to the stable project root (not the worktree
  // path). getProjectRoot() is never updated when entering a worktree, so
  // hooks referencing $MERCURY_PROJECT_DIR resolve at the real repo root.
  const projectDir = getProjectRoot()

  // Substitute ${MERCURY_EXTENSION_ROOT}, ${MERCURY_EXTENSION_DATA} and
  // ${option.KEY} in the command string, root and data FIRST so an option
  // value containing the literal text ${MERCURY_EXTENSION_ROOT} is treated as
  // opaque — never re-interpreted as a template. Every other ${…} stays
  // literal.
  let command = hook.command
  let extensionOptions: OptionValues | undefined
  if (extensionRoot) {
    // A vanished extension root (a concurrent session's uninstall) must
    // throw HERE, pre-spawn, becoming a non-blocking error upstream. Let it
    // run instead and the failure wears the protocol's own clothes: an
    // interpreter given a missing script exits 2 — the BLOCK code — and once
    // spawned, nothing can tell that apart from a hook genuinely blocking;
    // UserPromptSubmit/Stop then stay bricked until restart.
    if (!(await pathExists(extensionRoot))) {
      throw new Error(
        `Extension folder does not exist: ${extensionRoot}` +
          (extensionId ? ` (${extensionId} — /extensions shows its state)` : ''),
      )
    }
    // ROOT and DATA substitute through the function form of .replace(), so
    // the replacement is opaque text: a path with $ in it (a
    // \\server\c$\share, say) cannot be reinterpreted as a pattern. Paths
    // ride toHookPath so the shell dialect holds (PowerShell keeps C:\…).
    const rootPath = toHookPath(extensionRoot)
    command = command.replace(/\$\{MERCURY_EXTENSION_ROOT\}/g, () => rootPath)
    if (extensionId) {
      const dataPath = toHookPath(getExtensionDataDir(extensionId))
      command = command.replace(/\$\{MERCURY_EXTENSION_DATA\}/g, () => dataPath)
      extensionOptions = loadOptionValues(extensionId, optionSchemaFor(extensionId))
      command = substituteOptionsInCommand(command, extensionOptions)
    }
  }

  // A bare `.sh` on Windows opens in the file-type handler instead of
  // executing; the bash lane prepends the interpreter. PowerShell runs its
  // own scripts natively and needs nothing.
  if (isWindows && !isPowerShell) {
    command = winShHookCommand(command)
  }

  // MERCURY_SHELL_PREFIX wraps the command under POSIX quoting rules
  // (shell-quote inside formatShellPrefixCommand) — quoting PowerShell
  // cannot read, so the PS lane ignores the prefix entirely for now
  // (a shell-aware prefix is named follow-up work).
  const hookShellPrefix = process.env.MERCURY_SHELL_PREFIX
  const finalCommand =
    !isPowerShell && hookShellPrefix
      ? formatShellPrefixCommand(hookShellPrefix, command)
      : command

  const hookTimeoutMs = hook.timeout
    ? hook.timeout * 1000
    : TOOL_HOOK_EXECUTION_TIMEOUT_MS

  // The hook's environment: subprocess baseline plus the MERCURY_* hook
  // vocabulary — the ONE extension-env spelling Mercury emits. Every path
  // rides through toHookPath so the shell dialect above holds for env too.
  const hookProjectDir = toHookPath(projectDir)
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    MERCURY_PROJECT_DIR: hookProjectDir,
  }

  // Skills reuse the MERCURY_EXTENSION_ROOT name on purpose: a skill
  // promoted to an extension keeps its hook scripts unchanged.
  if (extensionRoot) {
    const rootPath = toHookPath(extensionRoot)
    envVars['MERCURY_EXTENSION_ROOT'] = rootPath
    if (extensionId) {
      const dataPath = toHookPath(getExtensionDataDir(extensionId))
      envVars['MERCURY_EXTENSION_DATA'] = dataPath
    }
  }
  // Options also land as env vars (MERCURY_EXTENSION_OPTION_<KEY>), so a hook
  // script can read them without templating ${option.KEY} into its command
  // line. Sensitive values ride along: a hook already runs as the operator,
  // the same trust boundary that could read the keychain itself.
  if (extensionOptions) {
    Object.assign(envVars, optionEnv(extensionOptions))
  }
  if (skillRoot) {
    const skillPath = toHookPath(skillRoot)
    envVars['MERCURY_EXTENSION_ROOT'] = skillPath
  }

  // MERCURY_ENV_FILE hands the hook a .sh file to write exports into;
  // the session-environment script concatenates those files and the bash
  // provider feeds them to future bash commands. That whole channel
  // speaks bash — a PS hook would write $env:FOO = 'bar' into it and
  // poison the concatenation — so the PS lane opts out here exactly as it
  // does for the prepend and prefix above.
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

  // A removed agent worktree can leave getCwd() pointing at a deleted
  // directory (AsyncLocalStorage keeps serving the stale value), and
  // spawn() reports a missing cwd as an async 'error' event, not a throw —
  // so the existence check runs here, before the spawn.
  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(
      `Hooks: cwd ${hookCwd} not found, falling back to original cwd`,
      { level: 'warn' },
    )
  }

  //
  // The two spawn shapes never mix. The bash lane hands Node the whole
  // command string with the `shell` option (Git Bash's path on Windows,
  // `true` → /bin/sh elsewhere) and lets that shell do the parsing. The
  // PS lane builds an explicit argv around pwsh — no shell option at all
  // — where -NoProfile keeps profile scripts out (fast, deterministic)
  // and -NonInteractive turns would-be prompts into fast failures.
  //
  // Windows-without-Git-Bash remains a boot-time exit: findGitBashPath()
  // hard-exits only on the bash lane, which an all-PowerShell hook config
  // never touches — but startup's setShellIfWindows() still exits first
  // either way. Lifting that boot requirement is the design's own phase 1,
  // deliberately not smuggled in here.
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
      // No console window flash on Windows; inert elsewhere.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  } else {
    // The bash lane names its shell only on Windows (Git Bash — cmd.exe
    // cannot parse bash syntax); elsewhere `shell: true` means /bin/sh.
    const shell = isWindows ? findGitBashPath() : true
    child = spawn(finalCommand, [], {
      env: envVars,
      cwd: safeCwd,
      shell,
      // No console window flash on Windows; inert elsewhere.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  }

  // Piped stdio, always: the first stdout line must be readable in-process
  // to recognize the async protocol's {"async": true} opening.
  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  // Ownership flag: once the async registry owns shellCommand, this scope
  // must not clean it up in the finally.
  let shellCommandTransferred = false
  // One stdin write per process — a second write after end() is an error.
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(
      `Hooks: Config-based async hook, backgrounding process ${processId}`,
    )

    // The input goes down before backgrounding, newline-terminated like the
    // sync lane writes it: without the newline, bash `read -r line` hits
    // EOF-before-delimiter and exits 1 — the variable fills but the
    // `if read -r line` branch never runs (gh-30509 / compat-161).
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

  // utf8 on both streams: chunk boundaries must never split a multi-byte
  // character into mojibake.
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

  // Prompt-request lines are stripped from the final stdout by CONTENT
  // (this set), never by index — content matching cannot drift when the
  // stream chunks differently.
  const processedPromptLines = new Set<string>()
  // Responses go back to the hook in request order; the chain serializes.
  let promptChain = Promise.resolve()
  // Carries the trailing partial line between 'data' chunks.
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

    // With a prompt channel open, stdout is scanned line-by-line for
    // requestPrompt JSON.
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
                // A cancelled or failed prompt must not leave the hook
                // blocked on stdin forever — the closed pipe is its answer.
                child.stdin.destroy()
              }
            })
            continue
          }
        } catch {
          // Ordinary output line, not a request.
        }
      }
    }

    // The async protocol opens with {"async":true,…} on the FIRST line,
    // followed by normal output. Only that first line is parsed: a fast
    // process may have written more before this 'data' event fired, and
    // parsing the accumulated blob would fail — silently turning an async
    // hook into a full-duration blocking one.
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

  // 'close' can fire while 'data' events are still queued; completion waits
  // for both streams to 'end' so no output is lost to the race.
  const stdoutEndPromise = new Promise<void>(resolve => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>(resolve => {
    child.stderr.on('end', () => resolve())
  })

  // The stdin write, EPIPE-aware: a hook may exit before reading its input.
  // (Bun and Node surface EPIPE differently, which is why this stays
  // listener-based rather than await-based.) Already-written stdin — the
  // config-async lane above — resolves immediately.
  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', err => {
          // With a prompt channel open, stdin outlives the first write, and
          // an EPIPE from a late response (process already gone) is
          // expected traffic — log, don't fail the hook.
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(
              `Hooks: stdin error during prompt flow (likely process exited): ${err}`,
            )
          }
        })
        child.stdin.write(jsonInput + '\n', 'utf8')
        // The prompt channel keeps stdin open for responses; otherwise the
        // input is complete and the pipe closes here.
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  // Resolves on 'close' — but only after both streams ended, so the
  // resolved value carries every byte the process wrote.
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
        // parseHookOutput must see only the hook's real result: every line
        // that was consumed as a prompt request is filtered out by content
        // match against the processed set — fail-closed regardless of where
        // in the stream those lines landed.
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

  // THE WEDGE-BREAKER (field w4-f08-01): 'close' fires only after BOTH
  // stdio streams end, and a killed or exited hook's forked child can
  // inherit and HOLD the pipes (the MSYS fork on win32; a `child &` on any
  // POSIX shell) — the process is gone, the streams never end, and the
  // settle race below out-waits every timeout that already fired. 'exit' is
  // the process's own end: after it a bounded grace lets the last buffered
  // bytes flush, then the streams are destroyed and the run settles with
  // everything read so far. On the normal path 'close' wins the race first
  // and this timer resolves an unused promise; the timer is unref'd so it
  // never holds the process either.
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

  // The run itself: stdin first (or its failure), then whichever settles
  // first of async-detection, close, process error, or the bounded
  // post-exit stream settle.
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
    // Every queued prompt response must have gone down before this run is
    // declared settled.
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    // Failures from the stdin write or the process itself, classified by
    // errno: EPIPE and aborts have specific stories, the rest are generic.
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
    // Stream teardown belongs to whoever owns the command now — this scope,
    // unless the async registry took it.
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
  }
}
