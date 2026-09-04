import { existsSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IMAGE_PACK_PATH = 'vendor/image-processor'

export function imagePackPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const libc = platform === 'linux' && isMusl() ? 'musl' : ''
  return `${platform}${libc}-${arch}`
}

function isMusl(): boolean {
  try {
    const report = (process as { report?: { getReport?: () => unknown } }).report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined
    return report?.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

export function imagePackPackages(packPlatform: string): string[] {
  const packages = [`@img/sharp-${packPlatform}`]
  if (!packPlatform.startsWith('win32')) packages.push(`@img/sharp-libvips-${packPlatform}`)
  return packages
}

export function vendoredImagePackDir(packPlatform: string = imagePackPlatform()): string {
  return join(dirname(fileURLToPath(import.meta.url)), ...IMAGE_PACK_PATH.split('/'), packPlatform)
}

export function imageBindingResolvable(packPlatform: string = imagePackPlatform()): boolean {
  try {
    createRequire(import.meta.url).resolve(`@img/sharp-${packPlatform}/sharp.node`)
    return true
  } catch {
    return false
  }
}

export type ImagePackArm = { armed: true; packDir: string } | { armed: false; packDir: string; reason: 'binding-resolvable' | 'no-pack' }

let armedDir: string | null = null

export function armImagePack(packPlatform: string = imagePackPlatform()): ImagePackArm {
  const packDir = vendoredImagePackDir(packPlatform)
  if (armedDir === packDir) return { armed: true, packDir }
  if (imageBindingResolvable(packPlatform)) return { armed: false, packDir, reason: 'binding-resolvable' }
  const modules = join(packDir, 'node_modules')
  if (!existsSync(join(modules, '@img'))) return { armed: false, packDir, reason: 'no-pack' }
  const current = process.env.NODE_PATH ?? ''
  if (!current.split(delimiter).includes(modules)) {
    process.env.NODE_PATH = current === '' ? modules : `${modules}${delimiter}${current}`
  }
  const init = (Module as unknown as { _initPaths?: () => void })._initPaths
  if (typeof init === 'function') init.call(Module)
  armedDir = packDir
  return { armed: true, packDir }
}
