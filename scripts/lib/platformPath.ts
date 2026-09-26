import { posix, win32 } from 'node:path'

export type PlatformPath = typeof posix | typeof win32

export function pathModuleFor(platform: string = process.platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

export function slashed(p: string, platform: string = process.platform): string {
  return platform === 'win32' ? p.replaceAll('\\', '/') : p
}

export function relativeSlashed(root: string, file: string, platform: string = process.platform): string {
  const path = pathModuleFor(platform)
  return path.relative(root, file).split(path.sep).join('/')
}

export function isInside(child: string, parent: string, platform: string = process.platform): boolean {
  const path = pathModuleFor(platform)
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
