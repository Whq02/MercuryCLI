import { join } from 'node:path'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

export function mnemeEnabled(): boolean {
  return isAutoMemoryEnabled()
}

export function mnemeLibraryDir(): string {
  return join(getAutoMemPath(), 'library')
}
