export function terminalSupportsJobControl(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function terminalTitleTransport(
  platform: NodeJS.Platform = process.platform,
): 'process-title' | 'osc' {
  return platform === 'win32' ? 'process-title' : 'osc'
}
