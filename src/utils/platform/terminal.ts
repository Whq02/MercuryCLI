export function terminalSupportsJobControl(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function terminalTitleTransport(
  platform: NodeJS.Platform = process.platform,
): 'process-title' | 'osc' {
  return platform === 'win32' ? 'process-title' : 'osc'
}

export function isModernWindowsTerminalHost(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (env.WT_SESSION) return true
  if (env.TERM_PROGRAM === 'vscode' && env.TERM_PROGRAM_VERSION) return true
  if (env.TERM_PROGRAM === 'mintty' || env.MSYSTEM) return true
  return false
}

export function isLegacyWindowsConsole(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): boolean {
  return platform === 'win32' && !isModernWindowsTerminalHost(env, platform)
}

export function isWindowsTerminalHost(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' || Boolean(env.WT_SESSION)
}

export function consoleSizeNeedsPolling(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

export function consoleNeedsUtf8Codepage(platform: string = process.platform): boolean {
  return platform === 'win32'
}
