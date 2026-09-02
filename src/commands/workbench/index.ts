import type { Command } from '../../commands.js'
import { workbenchEnabled } from '../../services/workbench/contracts.js'

// ============================================================================
// commands/workbench — /workbench, the PROMPTS PANEL: the WORK panel retired
// in place (same route, same slot, same input grammar), its content now the
// three tabs — PROMPTS (every prompt you sent in the focused chat, a receipt
// roll) · CREW TRAFFIC (the lead's messages to each subagent and their
// replies, threaded) · SAVED PROMPTS (prompts written ahead of sending, one
// key hands one to the composer). Read-only records; opens with what is
// already known (no model call, no spend, no network). MERCURY_WORKBENCH
// gated: OFF ⇒ command absent (the projection engine and mercury://workbench
// refuse on their own gate).
// ============================================================================

export const workbenchCommand = {
  type: 'local-jsx',
  name: 'workbench',
  description: 'The prompts panel — the prompts you sent in this chat, the crew traffic, and your saved prompts',
  isEnabled: () => workbenchEnabled(),
  isHidden: false,
  load: () => import('./workbench.js'),
} satisfies Command

export default workbenchCommand
