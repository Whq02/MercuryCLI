import { dirname, posix, win32 } from 'node:path'

export type PlatformPath = typeof posix | typeof win32

export function arenaPath(nodeBin: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === 'win32' ? (env.PATH ?? env.Path ?? '') : `/usr/bin:/bin:${dirname(nodeBin)}`
}

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

export function ruleRoot(absolute: string): string {
  const forward = absolute.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(forward)
  if (drive) return `//${drive[1]!.toUpperCase()}/${drive[2]!.replace(/\/+$/, '')}`
  return forward.startsWith('/') ? `/${forward}` : forward
}

export function isInside(child: string, parent: string, platform: string = process.platform): boolean {
  const path = pathModuleFor(platform)
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
