import type { SystemProtector } from './types.js'
import { createDpapiProtector } from './windowsDpapiProtector.js'

const dpapi = createDpapiProtector()

export function systemProtectorFor(platform: NodeJS.Platform, storeFlag: string | undefined): SystemProtector | null {
  if (storeFlag === 'file') return null
  return platform === 'win32' ? dpapi : null
}

export function sealsUnder(storeFlag: string | undefined): boolean {
  return storeFlag !== 'unseal'
}
