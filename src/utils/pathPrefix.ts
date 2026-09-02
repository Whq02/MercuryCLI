
const foldFor = (platform: NodeJS.Platform) => (s: string): string => {
  const normalised = s.replace(/\\/g, '/')
  return platform === 'win32' ? normalised.toLowerCase() : normalised
}

export function isPathInside(filePath: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = foldFor(platform)
  const f = fold(filePath)
  const d = fold(dir)
  return f === d || f.startsWith(`${d}/`)
}
