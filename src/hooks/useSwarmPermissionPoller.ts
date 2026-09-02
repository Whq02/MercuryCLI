// Worker-side permission-response registries + the disk poll. Two
// process-level registries keyed by request id, remove-before-invoke so a
// re-entrant dispatch cannot double-fire; external permission updates are
// schema-validated ELEMENT BY ELEMENT (malformed entries drop with a
// warning — an older peer must not push unchecked data into an approval).
// The 500 ms poll claims its in-flight guard only after the three cheap
// gates, and always releases it.

import { useEffect, useRef } from 'react'
import { permissionUpdateSchema } from '../utils/permissions/PermissionUpdateSchema.js'
import type { ContentBlockParam } from '../types/wire.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'
import {
  isSwarmWorker,
  pollForResponse,
  removeWorkerResponse,
} from '../utils/swarm/permissionSync.js'
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

/** Schema-validate external permission updates element by element;
 *  non-array input yields an empty list, malformed entries drop loudly. */
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
  // Removed BEFORE invocation.
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

export function processSandboxPermissionResponse({
  requestId,
  host,
  allow,
}: {
  requestId: string
  host: string
  allow: boolean
}): boolean {
  void host
  const callback = sandboxCallbacks.get(requestId)
  if (callback === undefined) {
    logForDebugging(`sandbox response for unregistered request ${requestId}`)
    return false
  }
  sandboxCallbacks.delete(requestId)
  callback.resolve(allow)
  return true
}

/** Clears BOTH registries (session clear + test isolation). */
export function clearAllPendingCallbacks(): void {
  permissionCallbacks.clear()
  sandboxCallbacks.clear()
}

export function useSwarmPermissionPoller(): void {
  const inFlightRef = useRef(false)
  useEffect(() => {
    const poll = async (): Promise<void> => {
      // Gate order: worker? → in flight? → any callbacks? — THEN claim.
      if (!isSwarmWorker()) return
      if (inFlightRef.current) return
      if (permissionCallbacks.size === 0 && sandboxCallbacks.size === 0) return
      inFlightRef.current = true
      try {
        const agentName = getAgentName()
        const teamName = getTeamName()
        if (!agentName || !teamName) return
        for (const requestId of [...permissionCallbacks.keys()]) {
          try {
            const response = await pollForResponse(requestId, agentName, teamName)
            if (response === null) continue
            const dispatched = processMailboxPermissionResponse({
              requestId,
              decision: response.decision,
              feedback: response.feedback,
              updatedInput: response.updatedInput,
              permissionUpdates: response.permissionUpdates,
            })
            // Only a successful dispatch removes the response file.
            if (dispatched) {
              await removeWorkerResponse(requestId, agentName, teamName)
            }
          } catch (error) {
            logForDebugging(`permission poll failed for ${requestId}: ${error}`)
          }
        }
      } catch (error) {
        logForDebugging(`swarm permission poll failed: ${error}`)
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
