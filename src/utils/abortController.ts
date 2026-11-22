import { setMaxListeners } from 'node:events'
import { notBuilt } from '../pi/holes.js'

export function createAbortController(maxListeners?: number): AbortController {
  return notBuilt('src/utils/abortController.ts:6')
}

export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  return notBuilt('src/utils/abortController.ts:12')
}
