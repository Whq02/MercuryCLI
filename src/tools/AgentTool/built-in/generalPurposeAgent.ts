
import { DEFAULT_AGENT_PROMPT } from '../../../constants/prompts.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'mercury-general',
  whenToUse:
    'Catch-all agent for open-ended research, locating code, and carrying out multi-step work on its own. Prefer it for keyword or file hunts where the first few attempts may miss the right match — hand the search to this agent rather than running it yourself.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => DEFAULT_AGENT_PROMPT,
}
