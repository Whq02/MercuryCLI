
import { useEffect, useRef } from 'react'
import { permissionUpdateSchema } from '../utils/permissions/PermissionUpdateSchema.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { getAgentName, getCrewName } from '../utils/crewmate.js'
import {
  isCrewmateWorker,
  pollForResponse,
  removeWorkerResponse,
} from '../utils/crew/permissionSync.js'
import { logForDebugging } from '../utils/debug.js'

const POLL_MS = 500

export type PermissionResponseCallback = {
  requestId: string
  toolUseId: string
  onAllow: (
    updatedInput: Record<string, unknown> | undefined,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ) => void
  onReject: (feedback?: string, contentBlocks?: ContentBlockParam[]) => void
}

export type SandboxPermissionResponseCallback = {
  requestId: string
  host: string
  resolve: (allow: boolean) => void
}

const permissionCallbacks = new Map<string, PermissionResponseCallback>()
const sandboxCallbacks = new Map<string, SandboxPermissionResponseCallback>()

export function registerPermissionCallback(
  callback: PermissionResponseCallback,
): void {
  permissionCallbacks.set(callback.requestId, callback)
}

export function unregisterPermissionCallback(requestId: string): void {
  permissionCallbacks.delete(requestId)
}

export function hasPermissionCallback(requestId: string): boolean {
  return permissionCallbacks.has(requestId)
}

export function validateExternalPermissionUpdates(
  input: unknown,
): PermissionUpdate[] {
  if (!Array.isArray(input)) return []
  const schema = permissionUpdateSchema()
  const out: PermissionUpdate[] = []
  for (const entry of input) {
    const parsed = schema.safeParse(entry)
    if (parsed.success) out.push(parsed.data as PermissionUpdate)
    else logForDebugging(`dropped malformed permission update: ${JSON.stringify(entry).slice(0, 200)}`)
  }
  return out
}

export function processMailboxPermissionResponse({
  requestId,
  decision,
  feedback,
  updatedInput,
  permissionUpdates,
}: {
  requestId: string
  decision: string
  feedback?: string
  updatedInput?: unknown
  permissionUpdates?: unknown
}): boolean {
  const callback = permissionCallbacks.get(requestId)
  if (callback === undefined) {
    logForDebugging(`permission response for unregistered request ${requestId}`)
    return false
  }
  permissionCallbacks.delete(requestId)
  if (decision === 'approved' || decision === 'allow') {
    callback.onAllow(
      updatedInput as Record<string, unknown> | undefined,
      validateExternalPermissionUpdates(permissionUpdates),
      feedback,
    )
  } else {
    callback.onReject(feedback)
  }
  return true
}

export function registerSandboxPermissionCallback(
  callback: SandboxPermissionResponseCallback,
): void {
  sandboxCallbacks.set(callback.requestId, callback)
}

export function hasSandboxPermissionCallback(requestId: string): boolean {
  return sandboxCallbacks.has(requestId)
}

export function clearAllPendingCallbacks(): void {
  permissionCallbacks.clear()
  sandboxCallbacks.clear()
}

export function useCrewPermissionPoller(): void {
  const inFlightRef = useRef(false)
  useEffect(() => {
    const poll = async (): Promise<void> => {
      if (!isCrewmateWorker()) return
      if (inFlightRef.current) return
      if (permissionCallbacks.size === 0 && sandboxCallbacks.size === 0) return
      inFlightRef.current = true
      try {
        const agentName = getAgentName()
        const crewName = getCrewName()
        if (!agentName || !crewName) return
        for (const requestId of [...permissionCallbacks.keys()]) {
          try {
            const response = await pollForResponse(requestId, agentName, crewName)
            if (response === null) continue
            const dispatched = processMailboxPermissionResponse({
              requestId,
              decision: response.decision,
              feedback: response.feedback,
              updatedInput: response.updatedInput,
              permissionUpdates: response.permissionUpdates,
            })
            if (dispatched) {
              await removeWorkerResponse(requestId, agentName, crewName)
            }
          } catch (error) {
            logForDebugging(`permission poll failed for ${requestId}: ${error}`)
          }
        }
      } catch (error) {
        logForDebugging(`crew permission poll failed: ${error}`)
      } finally {
        inFlightRef.current = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])
}
