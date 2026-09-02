import type { PermissionMode } from '../types/permissions.js'

/**
 * The single choke point through which session-state, external-metadata and
 * permission-mode changes leave the process. (The remote-session bridge that
 * would wire the state and metadata listeners is not in this tree; the
 * permission-mode listener is live — the headless runner wires it.)
 */

export type SessionState = 'idle' | 'running' | 'requires_action'

/** Snake_case is the wire shape (webhook payload + queryable metadata JSON). */
export type RequiresActionDetails = {
  tool_name: string
  action_description: string
  tool_use_id: string
  request_id: string
  input?: unknown
}

/**
 * The queryable remote-session metadata keys. `post_turn_summary` stays
 * opaque here: these types are re-exported into the generated SDK
 * declaration file, and importing the producing module would drag its path
 * into it.
 */
export type SessionExternalMetadata = {
  permission_mode?: string | null
  is_ultraplan_mode?: boolean | null
  model?: string | null
  pending_action?: RequiresActionDetails | null
  post_turn_summary?: unknown | null
  task_summary?: string | null
}

let currentState: SessionState = 'idle'
let pendingActionOutstanding = false
let permissionModeListener: ((mode: PermissionMode) => void) | null = null

export function getSessionState(): SessionState {
  return currentState
}

export function setPermissionModeChangedListener(listener: ((mode: PermissionMode) => void) | null): void {
  permissionModeListener = listener
}

/**
 * Metadata patches are partial, an explicit null being the merge-patch
 * clear. With no bridge listener in this tree the patch has no consumer;
 * the choke point stays so every producer already routes through it.
 */
export function notifySessionMetadataChanged(_metadata: SessionExternalMetadata): void {
  // The bridge listener wire-point (not built — no setter exists in this tree).
}

/**
 * Records the state, mirrors into external metadata (pending-action set on
 * entering the blocked state with details; cleared with an explicit null on
 * any other transition while one was outstanding; entering idle additionally
 * clears the task summary as its OWN single-key patch), and mirrors to the
 * SDK stream when opted in.
 */
export function notifySessionStateChanged(state: SessionState, details?: RequiresActionDetails): void {
  currentState = state
  if (state === 'requires_action' && details) {
    pendingActionOutstanding = true
    notifySessionMetadataChanged({ pending_action: details })
  } else if (pendingActionOutstanding) {
    pendingActionOutstanding = false
    notifySessionMetadataChanged({ pending_action: null })
  }
  if (state === 'idle') {
    // A mid-turn progress line left in place would still be showing on the
    // remote surface at the start of the next turn.
    notifySessionMetadataChanged({ task_summary: null })
  }
  // (session_state_changed events are never emitted — no opt-in exists: remote
  // front ends that infer busyness from the most recent stream message read
  // an idle event after the result as new activity, sticking their busy
  // indicator.)
}

/** Every permission-mode mutation path (chord, dialog, slash command, bridge) funnels through here. */
export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}
