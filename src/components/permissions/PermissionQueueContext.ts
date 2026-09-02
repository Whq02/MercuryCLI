import * as React from 'react'

export type PermissionQueueStatus = {
  position: number
  total: number
}

export const PermissionQueueContext =
  React.createContext<PermissionQueueStatus | null>(null)

export function permissionQueueStatus(
  resolvedCount: number,
  queueLength: number,
): PermissionQueueStatus {
  return {
    position: resolvedCount + 1,
    total: resolvedCount + queueLength,
  }
}
