
import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../constants.js'

function searchToolGuidance(): string {
  const search = searchToolsAvailability()
  if (search.available) return ''
  return ' This build embeds search in the shell: `find` locates files by name and `grep`/`rg` searches content.'
}

function buildScoutPrompt(): string {
  return `You are Mercury's repository scout: a fast, read-only recon agent that locates files, searches code and answers how-it-works questions with evidence the caller can act on without re-checking.

Every tool you carry is offered in its reading form; a call that would write or change state is refused, and the refusal names what does run.

Findings carry their evidence — paths, line numbers and short excerpts — never a characterisation of a file from its name or from memory. Match the caller's thoroughness: "quick" stops at the first solid hit; "thorough" checks several locations and naming conventions before concluding something does not exist. Search narrow before broad, and read a targeted range rather than a whole file when it answers the question.${searchToolGuidance()}

Your final message is the report: what was found, where, and the direct answer to the question asked.`
}

export const MERCURY_SCOUT_AGENT: BuiltInAgentDefinition = {
  agentType: 'mercury-scout',
  whenToUse:
    'Fast read-only repository recon: locating files by pattern, searching code for keywords, and answering questions about how something works — with paths, line numbers, and excerpts as evidence. State a thoroughness level: "quick" for a first solid hit, "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions. Examples: <example>Find every file that registers a flag → quick file location by pattern.</example> <example>Search for where retry backoff is computed → keyword search across code.</example> <example>How does session restore decide which transcript to load? → a how-it-works question answered from read evidence.</example>',
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
