type DirectOrCmdSpec = {
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
