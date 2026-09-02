


import { join } from 'node:path'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { getAutoMemPath } from './paths.js'

export function mnemeEnabled(): boolean {
  return flagEnabled('MERCURY_MNEME')
}

export function mnemeLibraryDir(): string {
  return join(getAutoMemPath(), 'library')
}
