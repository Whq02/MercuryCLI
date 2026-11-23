import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../platform/substrate/fileStore.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'

const registry = (): string => join(getMercuryHome(), 'local-setup', 'gguf-servers.json')
function readGgufServerRootsForWrite(): string[] {
  let raw: string
  try {
    raw = readFileSync(registry(), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  try {
    const roots: unknown = JSON.parse(raw)
    if (!Array.isArray(roots)) {
      logError(new Error(`the remembered GGUF servers ${registry()} could not be read: it is not a JSON array`))
      return []
    }
    return roots.filter((root): root is string => typeof root === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(root) && Number(new URL(root).port) > 0)
  } catch (error) {
    logError(new Error(`the remembered GGUF servers ${registry()} could not be read: ${error instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(error)}`))
    return []
  }
}
export function ggufServerRoots(): string[] {
  try {
    return readGgufServerRootsForWrite()
  } catch (error) {
    logError(new Error(`the remembered GGUF servers ${registry()} could not be read: ${errorMessage(error)}`))
    return []
  }
}
export function rememberGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify([...new Set([...readGgufServerRootsForWrite(), root])]) + '\n', { mode: 0o600 })
}
export function forgetGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify(readGgufServerRootsForWrite().filter(row => row !== root)) + '\n', { mode: 0o600 })
}
