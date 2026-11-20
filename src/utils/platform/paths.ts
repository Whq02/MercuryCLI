export function foldPathCase(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? filePath.toLowerCase() : filePath
}

export function samePathCase(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldPathCase(left, platform) === foldPathCase(right, platform)
}
