
export const SHELL_TYPES = ['bash', 'powershell'] as const

export type ShellType = (typeof SHELL_TYPES)[number]

export const DEFAULT_HOOK_SHELL: ShellType = 'bash'

export type BuildExecCommandResult = { commandString: string; cwdFilePath: string }

export type BuildExecCommandOptions = {
  id: number | string
  sandboxTmpDir?: string
  useSandbox: boolean
}

export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean
  buildExecCommand(command: string, options: BuildExecCommandOptions): Promise<BuildExecCommandResult>
  getSpawnArgs(commandString: string): string[]
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
