import { hostEnv } from '../environment/hostEnv.js'

export function wardPathFoldsCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export function wardNormalizedSlashedPath(text: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? text.replace(/\\/g, '/').toLowerCase() : text.replace(/\\/g, '/')
}

export function wardEnvHomePath(env: NodeJS.ProcessEnv = hostEnv(), platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE
}

export function wardWindowsHomeEnv(env: NodeJS.ProcessEnv = hostEnv(), platform: NodeJS.Platform = process.platform): string | undefined {
  return env.USERPROFILE || (platform === 'win32' ? env.HOME : undefined) || undefined
}

export function wardPosixWorldCwd(cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32' ? undefined : cwd
}

export function wardUsesWindowsDeletePatterns(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

export function wardWordIsWindowsShaped(word: string, anywhere: boolean, platform: NodeJS.Platform = process.platform): boolean {
  if (/^(?:[A-Za-z]:|%[A-Za-z_()0-9]+%|\$\{?env:|\\\\)/.test(word)) return anywhere || platform === 'win32'
  if (platform !== 'win32') return false
  return /^(?:\/(?:mnt\/)?[A-Za-z](?:\/|$)|\/\/[^/]|~(?:$|[/\\])|\$\{?[A-Za-z_])/i.test(word)
}

export function wardExpandMsysDrivePrefix(text: string, platform: NodeJS.Platform = process.platform): string {
  const msys = platform === 'win32' ? /^\/(?:mnt\/)?([A-Za-z])(\/[\s\S]*)?$/i.exec(text) : null
  return msys === null ? text : `${msys[1]}:${msys[2] ?? '/'}`
}

export function wardShareSegmentCountIsRoot(segmentCount: number, platform: NodeJS.Platform = process.platform): boolean {
  return segmentCount === 2 || (segmentCount < 2 && platform === 'win32')
}

export function wardUnresolvedWindowsWordFallsThrough(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

export function wardTracksWindowsStandingFolder(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}
