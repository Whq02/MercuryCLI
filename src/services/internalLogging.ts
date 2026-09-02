import { memoize } from 'lodash-es'

import type { ToolPermissionContext } from '../Tool.js'


export const getContainerId = memoize(async (): Promise<string | null> => {
  return null
})

export async function logPermissionContextForAnts(
  context: ToolPermissionContext | null,
  moment: 'summary' | 'initialization',
): Promise<void> {
  void context
  void moment
}
