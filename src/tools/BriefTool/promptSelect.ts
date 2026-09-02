// =============================================================================
// tools/BriefTool/promptSelect.ts
// -----------------------------------------------------------------------------
// Picks which description the Brief (SendUserMessage) tool carries this
// session: the tighter Augur variant while that family's TOOL arm is
// active, the standard prose otherwise.
//
// Kept as a leaf module on purpose — its only imports are the prompt strings
// and the model gate. That keeps BriefTool's prompt() free of an import
// cycle, and lets the selection be tested without dragging in the BriefTool
// UI or its attachments graph.
//
// Three ways the arm turns on — MERCURY_AUGUR_TOOL=1 for this arm alone,
// MERCURY_AUGUR=1 for the whole family, or the client-data tool-arm flag —
// and a MERCURY_AUGUR_MODEL pin constrains all three. Until one fires, callers get BRIEF_TOOL_PROMPT
// unchanged.
// =============================================================================

import { isAugurTool } from '../../utils/model/augur.js'
import { AUGUR_TOOL_PROMPT, BRIEF_TOOL_PROMPT } from './prompt.js'

/** Which SendUserMessage description this session should carry. */
export function resolveBriefToolPrompt(): string {
  return isAugurTool() ? AUGUR_TOOL_PROMPT : BRIEF_TOOL_PROMPT
}
