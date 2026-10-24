import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { scrubSessionEnvStamps } from '../../substrate/envStamps.js'
import { hostSpawnWorld, spawnPlanOf } from '../../utils/spawnPlan.js'
import { throwIfDapAborted } from './dapCancellation.js'

export type DapTerminalRequest = {
  args: string[]
  cwd: string
  env?: Record<string, string | null>
}

export type DapTerminalRunner = (
  request: DapTerminalRequest,
  signal: AbortSignal,
  adopt: (child: ChildProcess) => void,
  output: (chunk: string) => void,
) => Promise<number>

const quote = (word: string): string => /^[a-zA-Z0-9_./:@=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

function dapTerminalCommand(request: DapTerminalRequest): string {
  const changes = Object.entries(request.env ?? {})
  const env = changes.length ? ['env', ...changes.filter(([, value]) => value === null).flatMap(([key]) => ['-u', key]), ...changes.filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}`)] : []
  return `(cd ${quote(request.cwd)} && ${[...env, ...request.args].map(quote).join(' ')})`
}

export function createDapTerminalRunner(
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
  assistantMessage?: AssistantMessage,
): DapTerminalRunner {
  return async (request, signal, adopt, output) => {
    throwIfDapAborted(signal)
    if (!canUseTool || !assistantMessage) throw new Error('runInTerminal requires the session’s Bash permission context')
    const { BashTool } = await import('../../tools/BashTool/BashTool.js')
    const { runToolUse } = await import('../tools/toolExecution.js')
    const command = dapTerminalCommand(request)
    const abortController = new AbortController()
    const abort = (): void => abortController.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let processId: number | undefined
    let refusal = 'runInTerminal was not authorised'
    const terminalBash: Tool = {
      ...BashTool,
      async call(approved) {
        throwIfDapAborted(signal)
        if (approved.command !== command || approved._simulatedSedEdit !== undefined) {
          throw new Error('runInTerminal command was changed during approval; the adapter command was not authorised')
        }
        const env = scrubSessionEnvStamps(subprocessEnv()).env
        for (const [key, value] of Object.entries(request.env ?? {})) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        const argv = [...request.args]
        if (argv[0]!.includes('/') || argv[0]!.includes('\\')) argv[0] = resolve(request.cwd, argv[0]!)
        const world = hostSpawnWorld()
        world.path = (env.PATH ?? '').split(delimiter).map(part => resolve(request.cwd, part || '.')).join(delimiter)
        const plan = spawnPlanOf(argv, world)
        if ('refused' in plan) throw new Error(plan.refused)
        throwIfDapAborted(signal)
        const child = spawn(plan.file, plan.args, {
          cwd: request.cwd,
          env,
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        adopt(child)
        child.stdout.setEncoding('utf8').on('data', output)
        child.stderr.setEncoding('utf8').on('data', output)
        child.stdin.end()
        await new Promise<void>((resolveSpawn, reject) => {
          child.once('spawn', resolveSpawn)
          child.once('error', reject)
        })
        throwIfDapAborted(signal)
        processId = child.pid
        if (processId === undefined) throw new Error('runInTerminal started no process')
        return { data: { stdout: `Debuggee started (processId ${processId}); output is captured by Debug.`, stderr: '', interrupted: false } }
      },
    }
    const id = `debug-terminal-${crypto.randomUUID()}`
    try {
      const options = { ...context.options, tools: context.options.tools.map(tool => tool.name === BashTool.name ? terminalBash : tool) }
      for await (const update of runToolUse(
        { type: 'tool_use', id, name: BashTool.name, input: { command, description: 'Start the debugger-requested process' } },
        assistantMessage, canUseTool, { ...context, options, abortController },
      )) {
        const message = update.message
        if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
        for (const block of message.message.content) {
          if (block.type === 'tool_result' && block.is_error && typeof block.content === 'string') refusal = block.content
        }
      }
      throwIfDapAborted(signal)
      if (processId === undefined) throw new Error(refusal)
      return processId
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
