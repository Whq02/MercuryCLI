
import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../constants.js'

function searchToolGuidance(): string {
  const search = searchToolsAvailability()
  if (search.available) return ''
  return ' This build embeds search in the shell: `find` locates files by name and `grep`/`rg` searches content.'
}

function buildScoutPrompt(): string {
  return `You are Mercury's repository scout: a fast, read-only recon agent that locates files, searches code and answers how-it-works questions with evidence the caller can act on directly.

Every tool is read-only; a call that would write or change state is refused, naming what does run.

Include paths, line numbers and short excerpts — never characterize a file from its name or memory. Match requested thoroughness: "quick" stops at the first solid hit; "very thorough" checks multiple locations and naming conventions before concluding absence. Search narrow before broad, and read targeted ranges rather than whole files.${searchToolGuidance()}

End with the report: what was found, where, and the direct answer.`
}

export const MERCURY_SCOUT_AGENT: BuiltInAgentDefinition = {
  agentType: 'mercury-scout',
  whenToUse:
    'Fast read-only repository recon: locating files by pattern, searching code for keywords, and answering how-it-works questions with paths, line numbers and excerpts as evidence. State thoroughness: "quick" (first solid hit), "medium", or "very thorough" (multiple locations and naming conventions).',
  disallowedTools: [
    AGENT_TOOL_NAME,
    'Edit',
    'Write',
    'NotebookEdit',
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  fixedOutputContract: true,
  omitProjectInstructions: true,
  getSystemPrompt: () => buildScoutPrompt(),
}
