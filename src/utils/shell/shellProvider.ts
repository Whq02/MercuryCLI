/**
 * The shell-provider type contract and the shell-type enumeration.
 */

/** The two shell types, in this order (contract data). */
export const SHELL_TYPES = ['bash', 'powershell'] as const

/** The union of the shell-type strings. */
export type ShellType = (typeof SHELL_TYPES)[number]

/** The shell used for hooks that do not declare one. */
export const DEFAULT_HOOK_SHELL: ShellType = 'bash'

/** The command-assembly result: the command string and the cwd-tracking file. */
export type BuildExecCommandResult = { commandString: string; cwdFilePath: string }

/** Options handed to command assembly. */
export type BuildExecCommandOptions = {
  id: number | string
  sandboxTmpDir?: string
  useSandbox: boolean
}

/**
 * The shell-provider contract: one execution engine drives either a POSIX
 * shell or PowerShell through this interface.
 */
export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean
  buildExecCommand(command: string, options: BuildExecCommandOptions): Promise<BuildExecCommandResult>
  getSpawnArgs(commandString: string): string[]
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
