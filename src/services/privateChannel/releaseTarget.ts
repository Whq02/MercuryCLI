
export const RELEASE_TARGETS = ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64'] as const
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]

export interface BuildPlatform {
  platform: string
  arch: string
}

const PLATFORM_OF: Record<ReleaseTarget, BuildPlatform> = {
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'macos-arm64': { platform: 'darwin', arch: 'arm64' },
  'macos-x64': { platform: 'darwin', arch: 'x64' },
  'windows-x64': { platform: 'win32', arch: 'x64' },
}

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value)
}

export function releaseTargetFor(platform: string, arch: string): ReleaseTarget | null {
  for (const target of RELEASE_TARGETS) {
    const p = PLATFORM_OF[target]
    if (p.platform === platform && p.arch === arch) return target
  }
  return null
}

export function buildPlatformOf(target: ReleaseTarget): BuildPlatform {
  return { ...PLATFORM_OF[target] }
}

export function releaseTargetForUname(sysname: string, machine: string): ReleaseTarget | null {
  const platform = sysname === 'Darwin' ? 'darwin' : sysname === 'Linux' ? 'linux' : null
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'arm64' || machine === 'aarch64' ? 'arm64' : null
  if (platform === null || arch === null) return null
  return releaseTargetFor(platform, arch)
}

export function archiveNameFor(version: string, target: ReleaseTarget): string {
  return `mercury-v${version}-${target}.${target === 'windows-x64' ? 'zip' : 'tar.gz'}`
}

export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`
}

export const PLATFORM_PACKAGES_PATH = 'vendor/platform-packages'

export function ripgrepPackageFor(platform: string, arch: string): string {
  return `@vscode/ripgrep-${platform}-${arch}`
}

export interface BuildTargetRecord {
  platform: string
  arch: string
  release: ReleaseTarget | null
  host: string
}

export function readBuildTargetRecord(manifest: unknown): BuildTargetRecord | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const raw = (manifest as { target?: unknown }).target
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.platform !== 'string' || typeof r.arch !== 'string' || typeof r.host !== 'string') return null
  if (r.release !== null && !(typeof r.release === 'string' && isReleaseTarget(r.release))) return null
  const release = r.release as ReleaseTarget | null
  if (release !== releaseTargetFor(r.platform, r.arch)) return null
  return { platform: r.platform, arch: r.arch, release, host: r.host }
}
