
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { isAutopilotEnabled } from './autopilotGates.js'

const AUTOPILOT_APPENDIX = `# Autopilot tier control

This session runs in AUTOPILOT: permissions are bypassed (the operator consented at launch), and you hold the tier controls — the SetTier tool retunes your own model and reasoning effort mid-flight, under mechanical rails (operator allowlist, 3-turn cooldown, 8-switch session cap; every switch is surfaced to the operator).

When to move (and when not to):
- Upshift (opus, @high/@xhigh) for deep debugging, architecture and design decisions, security-sensitive diffs, and final verification of consequential work.
- Downshift (sonnet, @medium/@high) for long mechanical sweeps: bulk edits, migrations, formatting, fixture churn — work where the next action is obvious from local context.
- Effort-only moves on the same model are cheaper than model moves; prefer them when the work character shifts inside one family.
- Never switch mid-investigation on a hunch — finish the diagnostic thread on the tier that holds its context.
- Default to scope:'turn' (it reverts itself); use scope:'session' only when the work character has durably changed.

Economics: a model switch invalidates the prompt cache — the next call re-reads the conversation uncached, then re-warms. Batch switches with natural phase boundaries (plan approved → implement; implementation done → verify). Near autocompact, prefer staying put.

State the reason in one line; it is shown to the operator verbatim. A refused switch names its rail — adapt, do not retry the same request.`

export function getAutopilotModeSections(
  permissionMode: PermissionMode | undefined,
): string[] {
  
  if (!isAutopilotEnabled()) return []
  if (permissionMode !== 'autopilot') return []
  return [AUTOPILOT_APPENDIX]
}
