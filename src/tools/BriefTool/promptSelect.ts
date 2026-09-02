
import { isAugurTool } from '../../utils/model/augur.js'
import { AUGUR_TOOL_PROMPT, BRIEF_TOOL_PROMPT } from './prompt.js'

export function resolveBriefToolPrompt(): string {
  return isAugurTool() ? AUGUR_TOOL_PROMPT : BRIEF_TOOL_PROMPT
}
