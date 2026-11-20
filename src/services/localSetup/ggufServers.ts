import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'

const registry = (): string => join(getMercuryHome(), 'local-setup', 'gguf-servers.json')
function readGgufServerRootsStrict(): string[] {
  let raw: string
  try {
    raw = readFileSync(registry(), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  const roots: unknown = JSON.parse(raw)
  if (!Array.isArray(roots)) throw new SyntaxError(`${registry()} is not a JSON array`)
  return roots.filter((root): root is string => typeof root === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(root) && Number(new URL(root).port) > 0)
}
export function ggufServerRoots(): string[] {
  try {
    return readGgufServerRootsStrict()
  } catch (error) {
    logError(new Error(`the remembered GGUF servers ${registry()} could not be read: ${error instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(error)}`))
    return []
  }
}
export function rememberGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify([...new Set([...readGgufServerRootsStrict(), root])]) + '\n', { mode: 0o600 })
}
export function forgetGgufServer(root: string): void {
  publishAtomicSync(registry(), JSON.stringify(readGgufServerRootsStrict().filter(row => row !== root)) + '\n', { mode: 0o600 })
}
