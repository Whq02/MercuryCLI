


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

const MISSION_FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function themisToolGate(
  toolName: string,
  input: { [k: string]: unknown } | null | undefined,
  actor?: string,
): ThemisGateVerdict {
  try {
    const level = themisLevel()
    if (level === 'off') return { action: 'proceed' }
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
    return { action: 'proceed' }
  }
}
