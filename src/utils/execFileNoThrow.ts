import { execa, type Options as ExecaOptions } from 'execa'

import { getCwd } from './cwd.js'
import { logError } from './log.js'
import { subprocessEnv } from './subprocessEnv.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'


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

export async function execFileNoThrow(
  file: string,
  args: string[],
  options: OuterOptions = {
    timeout: DEFAULT_TIMEOUT_MS,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<ExecOutcome> {
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
      env: { ...subprocessEnv(), ...(options.env ?? {}) },
      extendEnv: false,
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
