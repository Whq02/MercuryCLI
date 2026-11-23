import { realpathSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

type DirectoryIdentity = { canonical: string; key: string; exists: boolean }

export function directoryIdentityKey(canonical: string, file: { dev: bigint; ino: bigint } | null, platform: string = process.platform): string {
  if (file !== null && file.ino !== 0n) return `file:${file.dev}:${file.ino}`
  let path = canonical.normalize('NFC')
  if (platform === 'win32') {
    path = path.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    path = win32.normalize(path).toLowerCase()
    if (path !== win32.parse(path).root) path = path.replace(/\\+$/, '')
  }
  return `path:${path}`
}

export function directoryIdentity(dir: string): DirectoryIdentity {
  try {
    const canonical = realpathSync.native(dir).normalize('NFC')
    const file = statSync(canonical, { bigint: true })
    if (file.isDirectory()) return { canonical, key: directoryIdentityKey(canonical, file), exists: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  }
  const canonical = dir.normalize('NFC')
  return { canonical, key: directoryIdentityKey(canonical, null), exists: false }
}
