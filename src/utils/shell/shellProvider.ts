import type { ShellOrigin } from './shellRecord.js'

export const SHELL_TYPES = ['bash', 'powershell'] as const

export type ShellType = (typeof SHELL_TYPES)[number]

type BuildExecCommandResult = { commandString: string; cwdFilePath: string; pipelineStatusPath?: string; frame?: { path: string; text: string } }

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
