export function tensorFoldHasNativeEngine(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function tensorFoldMachineSupportKind(
  platform: NodeJS.Platform = process.platform,
): 'macos-metal' | 'windows-adapter' | 'linux-nvidia' | 'unsupported' {
  if (platform === 'darwin') return 'macos-metal'
  if (platform === 'win32') return 'windows-adapter'
  if (platform === 'linux') return 'linux-nvidia'
  return 'unsupported'
}

export function tensorFoldSupportsLanBrowse(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function tensorFoldRuntimeDisplayPath(
  segments: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `~\\${segments.join('\\')}` : `~/${segments.join('/')}`
}
