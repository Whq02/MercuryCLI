import { getPlatform, type Platform } from '../environment/platform.js'

export function loginRunGetsOwnProcessGroup(login: boolean, platform: Platform = getPlatform()): boolean {
  return login && platform !== 'windows'
}

export function loginRunUsesProcessTreeCleanup(login: boolean, platform: Platform = getPlatform()): boolean {
  return login && platform === 'windows'
}

export function snapshotPathNeedsShellProbe(platform: string = getPlatform()): boolean {
  return platform === 'windows'
}

export function argv0EnvAssignmentBody(
  argv0Name: string,
  quotedBinary: string,
  prepend: string,
  platform: Platform = getPlatform(),
): string | undefined {
  return platform === 'windows' ? `  ARGV0=${argv0Name} ${quotedBinary} ${prepend}"$@"` : undefined
}

export function loginGroupMarkLine(mark: string, platform: Platform = getPlatform()): string | undefined {
  return platform === 'windows' ? `echo "${mark}=$$"` : undefined
}

export function snapshotAliasPipelineFilter(platform: Platform = getPlatform()): string {
  return platform === 'windows' ? ' | grep -v winpty' : ''
}

export function isHostPosixBash(origin: string, platform: Platform = getPlatform()): boolean {
  return origin !== 'engine' && platform !== 'windows'
}

export function loginRunScriptFilePath(
  snapshotFilePath: string,
  origin: string,
  platform: Platform = getPlatform(),
): string | undefined {
  return platform === 'windows' && origin !== 'engine' ? `${snapshotFilePath}.login-run` : undefined
}

export function carriesBashLoginExports(
  session: boolean,
  hasZsh: boolean,
  origin: string,
  platform: Platform = getPlatform(),
): boolean {
  return session && !hasZsh && !(origin === 'engine' && platform === 'windows')
}

export function remembersFailedLoginRun(session: boolean, platform: Platform = getPlatform()): boolean {
  return session && platform === 'windows'
}
