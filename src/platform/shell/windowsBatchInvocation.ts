import { closeSync, openSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { spawnOwnedShell } from './parentGuard.js'
import { parseForSecurity } from './bash/ast.js'
import { resolveExecutable, type LookupWorld } from '../processes/which.js'
import { getFsImplementation } from '../files/fsOperations.js'
import { generateTaskId } from '../../engine/tasks/taskBase.js'
import { scrubSessionEnvStamps } from '../substrate/envStamps.js'
import { subprocessEnv, toolShellEnv } from '../processes/subprocessEnv.js'
import { getTaskOutputDir } from '../../engine/task-framework/diskOutput.js'
import { TaskOutput } from '../../engine/task-framework/taskOutput.js'
import { wrapSpawn, createFailedCommand, type ShellCommand } from './shellProcess.js'
import { windowsBatchTail } from './windowsBatchLine.js'
import { passedOver } from '../errors/passedOver.js'
import { hostEnv } from '../environment/hostEnv.js'
import { startImmediate } from '../async/timers.js'

export { windowsBatchTail }

const BATCH_EXTENSIONS = /\.(cmd|bat)$/i

export type WindowsBatchWorld = LookupWorld & { comSpec?: string }

export type WindowsBatchInvocation =
  | { kind: 'batch'; comSpec: string; commandLine: string; batchPath: string }
  | { kind: 'ordinary' }

function isBatchFile(candidate: string): boolean {
  try {
    return BATCH_EXTENSIONS.test(candidate) && statSync(candidate).isFile()
  } catch (error) {
    passedOver(error)
    return false
  }
}

function hasDirectoryPart(word: string): boolean {
  return word.includes('/') || word.includes('\\')
}

function resolveBatchProgram(word: string, world: WindowsBatchWorld, cwd: string): string | null {
  if (word.startsWith('/') || word.startsWith('~')) return null
  if (hasDirectoryPart(word)) {
    const candidate = isAbsolute(word) ? word : resolvePath(cwd, word)
    return isBatchFile(candidate) ? candidate : null
  }
  if (BATCH_EXTENSIONS.test(word)) {
    const candidate = resolvePath(cwd, word)
    if (isBatchFile(candidate)) return candidate
  }
  const resolved = resolveExecutable(word, world)
  return resolved !== null && BATCH_EXTENSIONS.test(resolved) ? resolved : null
}

export async function planWindowsBatchInvocation(
  command: string,
  options: { world?: WindowsBatchWorld; cwd?: string } = {},
): Promise<WindowsBatchInvocation> {
  const world: WindowsBatchWorld = options.world ?? {
    platform: process.platform,
    path: hostEnv().PATH ?? '',
    comSpec: hostEnv().ComSpec,
  }
  if (world.platform !== 'win32') return { kind: 'ordinary' }
  if (/^\s*!/.test(command)) return { kind: 'ordinary' }

  const parsed = await parseForSecurity(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return { kind: 'ordinary' }
  const simple = parsed.commands[0]!
  if (simple.envVars.length > 0 || simple.redirects.length > 0 || simple.globOperand === true) return { kind: 'ordinary' }

  const words = simple.argv
  const program = words[0]
  if (program === undefined || program === '') return { kind: 'ordinary' }
  const batchPath = resolveBatchProgram(program, world, options.cwd ?? process.cwd())
  if (batchPath === null) return { kind: 'ordinary' }

  const commandLine = windowsBatchTail([batchPath, ...words.slice(1)])
  if (commandLine === null) return { kind: 'ordinary' }
  return { kind: 'batch', comSpec: world.comSpec ?? 'cmd.exe', commandLine, batchPath }
}

export type WindowsBatchRunOptions = {
  timeout: number
  cwd: string
  shouldAutoBackground: boolean
  inheritSessionEnv: boolean
  onProgress?: (recentLines: string, allLines: string, lineCount: number, byteCount: number, isIncomplete: boolean) => void
  onStdout?: (chunk: string) => void
}

export async function runWindowsBatchCommand(
  invocation: Extract<WindowsBatchInvocation, { kind: 'batch' }>,
  abortSignal: AbortSignal,
  options: WindowsBatchRunOptions,
): Promise<ShellCommand> {
  const taskId = generateTaskId('local_bash')
  const pipeMode = options.onStdout !== undefined
  const taskOutput = new TaskOutput(taskId, options.onProgress ?? null, !pipeMode)
  await getFsImplementation().mkdir(getTaskOutputDir())

  const base = options.inheritSessionEnv
    ? { env: subprocessEnv(), scrubbed: [] as string[] }
    : scrubSessionEnvStamps(subprocessEnv())
  const childEnv = toolShellEnv(base.env, { SHELL: invocation.comSpec })

  let outputFd: number | undefined
  let stdio: ('pipe' | 'ignore' | number)[]
  if (pipeMode) {
    stdio = ['pipe', 'pipe', 'pipe']
  } else {
    outputFd = openSync(taskOutput.path, 'w')
    stdio = ['pipe', outputFd, outputFd]
  }

  let shellCommand: ShellCommand
  try {
    const child = await spawnOwnedShell(invocation.comSpec, ['/d', '/s', '/v:off', '/c', invocation.commandLine], {
      cwd: options.cwd,
      env: childEnv,
      stdio,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    try {
      child.stdin?.end()
    } catch (error) {
      passedOver(error)
    }
    shellCommand = wrapSpawn(child, abortSignal, options.timeout, taskOutput, options.shouldAutoBackground)
    shellCommand.scrubbedSessionEnv = base.scrubbed
    if (outputFd !== undefined) {
      await new Promise<void>(resolveTick => startImmediate(resolveTick))
      try {
        closeSync(outputFd)
      } catch (error) {
        passedOver(error)
      }
      outputFd = undefined
    }
    if (pipeMode) {
      const onStdout = options.onStdout as (chunk: string) => void
      child.stdout?.on('data', (chunk: string | Buffer) => {
        onStdout(typeof chunk === 'string' ? chunk : chunk.toString())
      })
    }
  } catch (spawnError) {
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd)
      } catch (error) {
        passedOver(error)
      }
    }
    taskOutput.clear()
    return createFailedCommand(spawnError instanceof Error ? spawnError.message : String(spawnError))
  }
  return shellCommand
}
