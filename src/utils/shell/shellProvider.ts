
export const SHELL_TYPES = ['bash', 'powershell'] as const

export type ShellType = (typeof SHELL_TYPES)[number]

const DEFAULT_HOOK_SHELL: ShellType = 'bash'

type BuildExecCommandResult = { commandString: string; cwdFilePath: string; pipelineStatusPath?: string }

export type BuildExecCommandOptions = {
  id: number | string
}

export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean
  buildExecCommand(command: string, options: BuildExecCommandOptions): Promise<BuildExecCommandResult>
  getSpawnArgs(commandString: string): string[]
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
