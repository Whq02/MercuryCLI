import { execa, type Options as ExecaOptions } from 'execa'

import { getCwd } from './cwd.js'
import { logError } from './log.js'
import { subprocessEnv } from './subprocessEnv.js'
import { gitArgsAsync, isGitExecutable } from './git/spawnArgs.js'
import { isRecord } from './isRecord.js'

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
  env?: NodeJS.ProcessEnv
  input?: string | Uint8Array
  preserveOutputOnError?: boolean
  stdin?: StdinOption
  timeout?: number
  useCwd?: boolean
}

type InnerOptions = Omit<OuterOptions, 'useCwd'> & {
  cwd?: string
  maxBuffer?: number
  shell?: boolean | string
}

export async function execFileNoThrow(
  file: string,
  args: string[],
  options: OuterOptions = {},
): Promise<ExecOutcome> {
  try {
    return execFileNoThrowWithCwd(file, args, {
      abortSignal: options.abortSignal,
      env: options.env,
      input: options.input,
      stdin: options.stdin,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      preserveOutputOnError: options.preserveOutputOnError ?? true,
      cwd: options.useCwd === false ? undefined : getCwd(),
    })
  } catch (error) {
    logError(error)
    return { stdout: '', stderr: '', code: 1 }
  }
}

export async function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  options: InnerOptions = { maxBuffer: ONE_MEGABYTE },
): Promise<ExecOutcome> {
  try {
    const { cwd, preserveOutputOnError = true } = options
    const runOptions: ExecaOptions = {
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      cancelSignal: options.abortSignal,
      cwd,
      env: { ...subprocessEnv(), ...options.env },
      extendEnv: false,
      windowsHide: true,
      maxBuffer: options.maxBuffer,
      shell: options.shell,
      input: options.input,
      stdin: options.stdin,
    }
    try {
      const argv = isGitExecutable(file) ? await gitArgsAsync(args, cwd) : args
      const { stdout, stderr } = await execa(file, argv, runOptions)
      return { stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '', code: 0 }
    } catch (error) {
      const failure = isRecord(error) ? error : {}
      const code = typeof failure.exitCode === 'number' ? failure.exitCode : 1
      if (!preserveOutputOnError) return { stdout: '', stderr: '', code }
      return {
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
        code,
        error: typeof failure.shortMessage === 'string' ? failure.shortMessage : typeof failure.signal === 'string' ? failure.signal : String(code),
      }
    }
  } catch (error) {
    logError(error)
    return { stdout: '', stderr: '', code: 1 }
  }
}
