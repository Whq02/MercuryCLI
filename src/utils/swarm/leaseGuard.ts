/**
 * Lease-guard — the PreToolUse enforcement that makes the file-lease store BITE.
 *
 * When an agent runs Edit / Write / NotebookEdit on a path that ANOTHER agent
 * has leased (see leaseGlob.ts), this DENIES it. Wired into executePreToolHooks
 * (src/utils/hooks.ts) so it runs ahead of the user-hook early-return — it works
 * even with no user hooks configured.
 *
 * DEFAULT-SAFE: this is a complete no-op unless ALL of these hold —
 *   1. the session is part of a team (getTeamName()), AND
 *   2. the tool is a file-mutating tool (Edit / Write / NotebookEdit), AND
 *   3. the path resolves to a concrete file, AND
 *   4. some OTHER agent holds a non-expired lease whose glob covers it.
 * With no leases held (empty store), getLeaseConflict returns null ⇒ allow ⇒
 * zero behavior change. Only a real cross-agent overlap denies.
 *
 * Current-agent id: resolveCoordAgentId() — the teammate's name within the team
 * (or TEAM_LEAD_NAME for the leader). This is the SAME canonical id the lease
 * CLAIM side (the coordination server's mcp__mercury__lease_* verbs) uses, so the leader claims and is guarded
 * under one id and never self-conflicts; a worker that leased a path still blocks
 * the leader's edit of it.
 */

import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { logForDebugging } from '../debug.js'
import { normalizeLegacyToolName } from '../permissions/permissionRuleParser.js'
import { getTeamName, resolveCoordAgentId } from '../teammate.js'
import { getLeaseConflict } from './leaseGlob.js'

/** Tools whose target file the guard protects. */
const GUARDED_TOOLS = new Set<string>([
  FILE_EDIT_TOOL_NAME, // 'Edit'
  FILE_WRITE_TOOL_NAME, // 'Write'
  NOTEBOOK_EDIT_TOOL_NAME, // 'NotebookEdit'
])

/**
 * Extract the target file path from a guarded tool's input. Edit/Write use
 * `file_path`; NotebookEdit uses `notebook_path`. Returns null when absent
 * (the guard then no-ops — fail safe).
 */
function extractFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const fp = input.file_path ?? input.notebook_path
  return typeof fp === 'string' && fp.length > 0 ? fp : null
}

/** The stable id of the current agent for lease ownership (see module doc).
 *  Delegates to the canonical resolveCoordAgentId() so the guard id matches the
 *  lease-claim id exactly (no leader self-conflict). */
export function getCurrentLeaseAgentId(): string {
  return resolveCoordAgentId()
}

/**
 * Check whether the current agent's call to `toolName` on `input` collides with
 * another agent's lease. Returns a deny message when it does, or null to allow.
 *
 * Pure no-op (returns null) outside a team, for non-guarded tools, for inputs
 * without a file path, and when no cross-agent lease covers the path.
 */
export async function checkLeaseGuard(
  toolName: string,
  input: Record<string, unknown>,
  // The LEADER's team identity (appState.teamContext). getTeamName()'s no-arg form
  // only sees the worker/tmux AsyncLocalStorage + dynamicTeamContext, so the
  // interactive leader that SPAWNED the team resolved to undefined here and its own
  // edits FAIL-OPEN past every teammate's lease. Threading the leader context closes
  // that hole; workers/tmux still win via their in-process context (unchanged).
  leaderTeamContext?: { teamName?: string },
): Promise<string | null> {
  const normalized = normalizeLegacyToolName(toolName)
  if (!GUARDED_TOOLS.has(normalized)) return null

  const team = getTeamName(
    leaderTeamContext as { teamName: string } | undefined,
  )
  if (!team) return null // no team ⇒ no coordination ⇒ no-op

  if (!input || typeof input !== 'object') return null
  const filePath = extractFilePath(normalized, input)
  if (!filePath) return null

  const agentId = getCurrentLeaseAgentId()

  let conflict
  try {
    conflict = await getLeaseConflict(team, agentId, filePath)
  } catch (e) {
    // Store unreadable / unexpected error: fail OPEN (allow). The lease guard
    // must never brick a legitimate edit because of an IO hiccup — this is a
    // deliberate availability-over-strictness choice (leases are advisory, with the
    // TTL as the real backstop).: log at WARN (not debug) so a silently
    // degraded coordination state is at least discoverable to an operator looking.
    logForDebugging(`[leaseGuard] getLeaseConflict failed, allowing edit (lease coordination degraded): ${e}`, { level: 'warn' })
    return null
  }
  if (!conflict) return null

  return (
    `File lease conflict: ${filePath} is covered by a lease held by agent ` +
    `"${conflict.agentId}" (glob "${conflict.glob}"). Another agent is ` +
    `coordinating edits to this path. Pick a different file, or ask ` +
    `"${conflict.agentId}" to release its lease before editing here.`
  )
}
