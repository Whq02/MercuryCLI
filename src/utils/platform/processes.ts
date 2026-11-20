export function childGetsOwnProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}
