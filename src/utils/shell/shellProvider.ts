import type { ShellOrigin } from './shellRecord.js'

export const SHELL_TYPES = ['bash', 'powershell'] as const

export type ShellType = (typeof SHELL_TYPES)[number]

export type FrameHandOver = { args: string[]; file?: { path: string; text: string }; startIn?: string }

type BuildExecCommandResult = { commandString: string; cwdFilePath: string; pipelineStatusPath?: string; jobsPath?: string; handOver?: (env: NodeJS.ProcessEnv, cwd?: string) => FrameHandOver }

export type BuildExecCommandOptions = {
  id: number | string
}

export type ShellProvider = {
  type: ShellType
  shellPath: string
  origin?: ShellOrigin
  detached: boolean
  buildExecCommand(command: string, options: BuildExecCommandOptions): Promise<BuildExecCommandResult>
  getSpawnArgs(commandString: string): string[]
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
