import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'

const registry = (): string => join(getMercuryHome(), 'local-setup', 'gguf-servers.json')
export function ggufServerRoots(): string[] {
  try {
    const roots: unknown = JSON.parse(readFileSync(registry(), 'utf8'))
    return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(root) && Number(new URL(root).port) > 0) : []
  } catch { return [] }
}
export function rememberGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify([...new Set([...ggufServerRoots(), root])]) + '\n', { mode: 0o600 })
}
export function forgetGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify(ggufServerRoots().filter(row => row !== root)) + '\n', { mode: 0o600 })
}
