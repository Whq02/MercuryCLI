// The default catch-all subagent, prompt targeted to Mercury
// identity. Deliberately declares NO model: it falls through to the shared
// default subagent model (the never-lightweight floor's negative invariant
// holds because nothing here pins a lightweight tier).

import { DEFAULT_AGENT_PROMPT } from '../../../constants/prompts.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'Catch-all agent for open-ended research, locating code, and carrying out multi-step work on its own. Prefer it for keyword or file hunts where the first few attempts may miss the right match — hand the search to this agent rather than running it yourself.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => DEFAULT_AGENT_PROMPT,
}
