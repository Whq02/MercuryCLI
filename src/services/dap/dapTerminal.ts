import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import type { CanUseToolFn, Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { scrubSessionEnvStamps } from '../../substrate/envStamps.js'
import { hostSpawnWorld, spawnPlanOf } from '../../utils/spawnPlan.js'
import { childGetsOwnProcessGroup } from '../../utils/platform/processes.js'
import { throwIfDapAborted } from './dapCancellation.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/dap/dapTerminal.ts:32')
}
