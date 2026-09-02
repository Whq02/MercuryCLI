import { execa, type Options as ExecaOptions } from 'execa'

import { getCwd } from './cwd.js'
import { logError } from './log.js'
import { subprocessEnv } from './subprocessEnv.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

/**
 * Never-throwing subprocess execution. The promise ALWAYS resolves with
 * `{stdout, stderr, code, error?}` — never rejects.
 *
 * Uses a cross-platform exec library so Windows `.bat`/`.cmd` resolution and
 * argument escaping come for free.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const ONE_MEGABYTE = 1024 * 1024

type ExecOutcome = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

type StdinOption = 'pipe' | 'ignore' | 'inherit'

type OuterOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: StdinOption
  input?: string | Buffer
}

type InnerOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: StdinOption
  input?: string | Buffer
  maxBuffer?: number
  shell?: boolean | string
}

/**
 * DEFAULTING TRAP — deliberate, reproduce exactly. The defaults here are a
 * WHOLE-OBJECT parameter default: calling with no options object gets the
 * ten-minute timeout, preserved output and the resolved working directory;
 * calling with ANY options object — even `{}` — leaves `useCwd` undefined,
 * so no working directory is passed and the child inherits the process's.
 * (The `useCwd` boolean exists so early-initialisation callers can avoid a
 * circular dependency through the shell and event logging.)
 */
export async function execFileNoThrow(
  file: string,
  args: string[],
  options: OuterOptions = {
    timeout: DEFAULT_TIMEOUT_MS,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<ExecOutcome> {
  // The outer entry point ALWAYS hands the inner one an options object with
  // maxBuffer never set, so a call through here never receives the inner
  // one-megabyte whole-object default.
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

/**
 * The inner entry point: an explicit `cwd` in place of `useCwd`, plus
 * `maxBuffer` and `shell`. Timeout and output preservation default
 * per-property; the one-megabyte buffer default is whole-object-only and is
 * reached only by calling this function with no options at all.
 */
export async function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  options: InnerOptions = { maxBuffer: ONE_MEGABYTE },
): Promise<ExecOutcome> {
  const { timeout = DEFAULT_TIMEOUT_MS, preserveOutputOnError = true } = options
  try {
    const execaOptions = {
      timeout,
      cancelSignal: options.abortSignal,
      cwd: options.cwd,
      // execa's default extendEnv merges {...process.env, ...env} — which
      // would resurface the raw parent env (session token included) under
      // every call. The merge shape is reproduced here on the SCRUBBED
      // base instead, and extendEnv is pinned off.
      env: { ...subprocessEnv(), ...(options.env ?? {}) },
      extendEnv: false,
      // Explicit even though it is execa's own default: on win32 every
      // console child spawned without it paints a transient conhost window
      // (one flash per spawn), and a library major bump must not be able to
      // change our spawn discipline underneath us.
      windowsHide: true,
      maxBuffer: options.maxBuffer,
      shell: options.shell,
      input: options.input,
      stdin: options.stdin,
    } as ExecaOptions
    try {
      const result = await execa(file, args, execaOptions)
      return {
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        code: 0,
      }
    } catch (err) {
      const failure = err as {
        stdout?: unknown
        stderr?: unknown
        exitCode?: number
        signal?: string
        shortMessage?: string
      }
      const code = typeof failure.exitCode === 'number' ? failure.exitCode : 1
      if (preserveOutputOnError) {
        // The library's short message is preferred because it already names
        // a killing signal when there was one.
        const error =
          failure.shortMessage ??
          failure.signal ??
          String(code)
        return {
          stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
          stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
          code,
          error,
        }
      }
      return { stdout: '', stderr: '', code }
    }
  } catch (err) {
    logError(err)
    return { stdout: '', stderr: '', code: 1 }
  }
}
