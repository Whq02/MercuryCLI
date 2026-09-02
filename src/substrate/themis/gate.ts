/* ============================================================================
   THEMIS tool gate — the level-aware decision toolExecution consults.

   One function, called at the universal execution gate
   (services/tools/toolExecution.ts checkPermissionsAndCallTool, directly
   after the capability kill-switch): reads the level LIVE, runs the pure
   blocklist, writes the audit row, and returns a typed verdict. The caller
   only maps 'deny' onto the established refusal shape — all policy lives
   here, which keeps the off-distribution toolExecution diff minimal and
   makes the decision runtime-provable in isolation (scripts/themis/).

   FAIL POSTURE (capabilityGate's): this function never throws; any internal
   failure degrades to 'proceed' — THEMIS can only ever ADD a documented
   refusal, never break tool execution.

     off     ⇒ 'proceed' with zero work (no regex, no fs, no dir) — the
               explicit opt-out (MERCURY_THEMIS=off|0).
     warn    ⇒ hit is AUDITED ('blocklist-hit') and the call proceeds — the
               de-escalation posture; the model-visible stream is unchanged.
     enforce ⇒ hit is AUDITED ('blocklist-deny') and the caller refuses the
               call pre-invocation — THE DEFAULT.
   ============================================================================ */

import { relative, isAbsolute } from 'node:path'
import { appendAuditRow } from './auditChain.js'
import { checkBlocklist, type BlocklistHit } from './blocklist.js'
import { themisLevel } from './level.js'
import { missionDriftConsult } from './mission.js'

export type ThemisGateVerdict =
  | { action: 'proceed'; hit?: undefined }
  | { action: 'warn'; hit: BlocklistHit }
  | { action: 'deny'; hit: BlocklistHit }
  | { action: 'deny-mission'; missionMessage: string; hit?: undefined }

/** File-mutating tools whose target path a mission contract governs. */
const MISSION_FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function themisToolGate(
  toolName: string,
  input: { [k: string]: unknown } | null | undefined,
  actor?: string,
): ThemisGateVerdict {
  try {
    const level = themisLevel()
    if (level === 'off') return { action: 'proceed' }
    // Tracked change mission: an unexpected-path file mutation
    // under an ACTIVE mission warns ONCE per path (warn = recorded, never
    // interrupts) and refuses under enforce with amendment directions.
    // No mission ⇒ zero added restriction. Failure ⇒ proceed (the THEMIS
    // fail-open posture).
    if (MISSION_FILE_TOOLS.has(toolName)) {
      const fp = input && typeof input.file_path === 'string' ? input.file_path : null
      if (fp) {
        const cwd = process.cwd()
        const rel = isAbsolute(fp) ? relative(cwd, fp) : fp
        if (rel && !rel.startsWith('..')) {
          const consult = missionDriftConsult(toolName, rel, cwd)
          if (consult.drift && consult.deny) {
            return {
              action: 'deny-mission',
              missionMessage: `${rel} is outside the active mission "${consult.mission.title}" (${consult.mission.id}). If this edit belongs to the mission: /mission add ${rel} — then retry. To review first: /mission (or /mission inspected ${rel}). Ordinary work outside a mission is unaffected by this rule.`,
            }
          }
          // warn level: the consult recorded the drift row (once per path);
          // the stream stays untouched — the mission surface + doctor show it.
        }
      }
    }
    const hit = checkBlocklist(toolName, input)
    if (!hit) return { action: 'proceed' }
    const details = `${hit.id} (${hit.category}) tool=${toolName} match=${hit.match}`
    if (level === 'warn') {
      void appendAuditRow({ actor: actor ?? 'main', action: 'blocklist-hit', details })
      return { action: 'warn', hit }
    }
    void appendAuditRow({ actor: actor ?? 'main', action: 'blocklist-deny', details })
    return { action: 'deny', hit }
  } catch {
    // No added denial on internal failure — the permission ladder still runs.
    return { action: 'proceed' }
  }
}
