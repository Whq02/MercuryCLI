import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export const API_ERROR_MESSAGE_PREFIX: Unbuilt = unbuilt('src/services/api/errorPrefix.ts:1')

export function startsWithApiErrorPrefix(text: string): boolean {
  return notBuilt('src/services/api/errorPrefix.ts:3')
}
