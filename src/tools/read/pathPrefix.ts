
import { foldPathCase } from '../../platform/host-os/paths.js'

const foldFor = (platform: NodeJS.Platform) => (s: string): string =>
  foldPathCase(s.replace(/\\/g, '/'), platform)

export function isPathInside(filePath: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = foldFor(platform)
  const f = fold(filePath)
  const d = fold(dir)
  return f === d || f.startsWith(`${d}/`)
}
