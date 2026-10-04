import { join } from 'node:path'
import { getMnemeHome, isMnemeEnabled } from './paths.js'

export function mnemeEnabled(): boolean {
  return isMnemeEnabled()
}

export function mnemeLibraryDir(): string {
  return join(getMnemeHome(), 'library')
}
