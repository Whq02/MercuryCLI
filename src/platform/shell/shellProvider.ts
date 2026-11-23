import type { ShellOrigin } from './shellRecord.js'

export const SHELL_TYPES = ['bash', 'powershell'] as const

export type ShellType = (typeof SHELL_TYPES)[number]

export type FrameHandOver = { args: string[]; file?: { path: string; text: string }; startIn?: string }

export type BuildExecCommandOptions = {
  id: number | string
}

export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean
  origin?: ShellOrigin
  buildExecCommand: (
    command: string,
    opts: BuildExecCommandOptions,
  ) => Promise<{
    commandString: string
    cwdFilePath: string
    pipelineStatusPath?: string
    jobsPath?: string
    handOver?: (env: NodeJS.ProcessEnv, cwd?: string) => FrameHandOver
  }>
  getSpawnArgs: (commandString: string) => string[]
  getEnvironmentOverrides: (command: string) => Promise<Record<string, string>>
}
