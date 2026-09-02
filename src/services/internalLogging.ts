import { memoize } from 'lodash-es'

import type { ToolPermissionContext } from '../Tool.js'

/**
 * Vendor-internal environment probes and permission-context logging, folded
 * to inert constants in this build. The exports survive because they are
 * still imported and called; nothing may be read from the filesystem and
 * nothing may be emitted.
 */

/** Always "none"; memoised because callers await it repeatedly. */
export const getContainerId = memoize(async (): Promise<string | null> => {
  return null
})

/** Always a no-op; its one caller does not await it. */
export async function logPermissionContextForAnts(
  context: ToolPermissionContext | null,
  moment: 'summary' | 'initialization',
): Promise<void> {
  void context
  void moment
}
