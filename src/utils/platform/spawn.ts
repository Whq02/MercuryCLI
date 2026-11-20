import { getPlatform, type Platform } from '../platform.js'

export type DirectOrCmdSpec = {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export type HostShellHint = 'powershell' | 'cmd' | 'posix-sh' | 'unknown'

export function commandShellOption(platform: NodeJS.Platform = process.platform): true | '/bin/sh' {
  return platform === 'win32' ? true : '/bin/sh'
}

export function shellCommandSpec(
  argv: readonly string[],
  comSpec?: string,
  platform: NodeJS.Platform = process.platform,
): DirectOrCmdSpec {
  if (platform === 'win32') {
    return {
      file: comSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${argv.join(' ')}"`],
      windowsVerbatimArguments: true,
    }
  }
  const [file, ...args] = argv
  return { file: file ?? '', args, windowsVerbatimArguments: false }
}

export function shellBinarySpec(
  command: string,
  args: readonly string[],
  comSpec?: string,
  platform: NodeJS.Platform = process.platform,
): DirectOrCmdSpec {
  if (platform === 'win32') {
    const tail = args.length > 0 ? ` ${args.join(' ')}` : ''
    return {
      file: comSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `""${command}"${tail}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { file: command, args: [...args], windowsVerbatimArguments: false }
}

export function hostShellHint(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): HostShellHint {
  if (platform === 'win32') {
    if (typeof env.PSModulePath === 'string' && env.PSModulePath.length > 0) return 'powershell'
    if (typeof env.ComSpec === 'string') return 'cmd'
    return 'unknown'
  }
  if (typeof env.SHELL === 'string' && env.SHELL.length > 0) return 'posix-sh'
  return 'unknown'
}

export function hookPathForShell(
  path: string,
  shell: 'bash' | 'powershell',
  toPosix: (path: string) => string,
  platform: Platform = getPlatform(),
): string {
  return platform === 'windows' && shell !== 'powershell' ? toPosix(path) : path
}

export function hookCommandForShell(
  command: string,
  shell: 'bash' | 'powershell',
  prefix: string | undefined,
  adapt: {
    windowsSh: (command: string) => string
    posixStartLine: (command: string) => string
    formatPrefix: (prefix: string, command: string) => string
  },
  platform: Platform = getPlatform(),
): string {
  if (shell === 'powershell') return command
  const adapted = platform === 'windows' ? adapt.windowsSh(command) : command
  if (!prefix) return adapted
  return adapt.formatPrefix(prefix, platform === 'windows' ? adapted : adapt.posixStartLine(adapted))
}

export async function hookBashSpawnSpec(
  command: string,
  env: NodeJS.ProcessEnv,
  windows: {
    shell: (command: string) => Promise<string | boolean>
    env: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  },
  platform: Platform = getPlatform(),
): Promise<{ shell: string | boolean; env: NodeJS.ProcessEnv }> {
  if (platform === 'windows') {
    const shell = await windows.shell(command)
    return { shell, env: windows.env(env) }
  }
  return { shell: true, env }
}
