import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_PACKAGES_PATH, platformKey, ripgrepPackageFor } from '../../src/services/privateChannel/releaseTarget.ts'
import { imagePackPackages, imagePackPlatform } from '../../src/tools/FileReadTool/imagePackArm.ts'

export function platformPackagesFor(platform: string, arch: string): string[] {
  return [ripgrepPackageFor(platform, arch), ...imagePackPackages(imagePackPlatform(platform, arch))]
}

export function platformPackagesCacheDir(root: string, platform: string, arch: string): string {
  return join(root, ...PLATFORM_PACKAGES_PATH.split('/'), platformKey(platform, arch))
}

export type PlatformPackageSource = 'node_modules' | 'vendor-cache'

export function resolvePlatformPackage(root: string, platform: string, arch: string, name: string): { dir: string; source: PlatformPackageSource } | null {
  const segments = name.split('/')
  const fromModules = join(root, 'node_modules', ...segments)
  if (existsSync(join(fromModules, 'package.json'))) return { dir: fromModules, source: 'node_modules' }
  const fromCache = join(platformPackagesCacheDir(root, platform, arch), 'node_modules', ...segments)
  if (existsSync(join(fromCache, 'package.json'))) return { dir: fromCache, source: 'vendor-cache' }
  return null
}

export interface LockedPackage {
  name: string
  version: string
  integrity: string
}

export function lockedPackage(lockText: string, name: string): LockedPackage | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const row = new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"]+)", "[^"]*", \\{[^\\n]*\\}, "(sha512-[A-Za-z0-9+/=]+)"\\],?\\s*$`, 'm')
  const m = row.exec(lockText)
  if (!m) return null
  return { name, version: m[1]!, integrity: m[2]! }
}

export function registryTarballUrl(pkg: LockedPackage): string {
  const stem = pkg.name.includes('/') ? pkg.name.slice(pkg.name.indexOf('/') + 1) : pkg.name
  return `https://registry.npmjs.org/${pkg.name}/-/${stem}-${pkg.version}.tgz`
}

export function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}
