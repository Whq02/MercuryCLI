import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

/**
 * The Grep tool's name constant and model-facing text. The same string is
 * used verbatim for both the description and the prompt, so the two are
 * always identical — including the capability-gated steering line.
 */

/** Contract data: the model-visible tool name. */
export const GREP_TOOL_NAME = 'Grep'

/** The steering trailer; empty when the owner is off or fails to load. */
function steeringSuffix(): string {
  try {
    const { searchSteeringLine } =
      require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
    const line = searchSteeringLine()
    return line ? `\n${line}` : ''
  } catch {
    return ''
  }
}

export function getDescription(): string {
  return `Content search across the tree, powered by ripgrep

Usage:
- Search happens HERE, always — shelling out to \`grep\`/\`rg\` through ${BASH_TOOL_NAME} loses the permission and access handling this tool carries.
- Full regex syntax lands (\`log.*Error\`, \`function\\s+\\w+\`)
- Narrow by file with \`glob\` (\`*.js\`, \`**/*.tsx\`) or by language with \`type\` (\`js\`, \`py\`, \`rust\`)
- Three output modes: "files_with_matches" lists only the paths that hit (the default), "content" prints the matching lines, "count" tallies matches
- For open-ended hunts that will take several rounds of searching, reach for the ${AGENT_TOOL_NAME} tool instead
- Pattern dialect: ripgrep's, not grep's — literal braces need escaping (\`interface\\{\\}\` reaches \`interface{}\` in Go code)
- Multiline: patterns stay within one line unless asked otherwise. A cross-line pattern (say \`struct \\{[\\s\\S]*?field\`) wants \`multiline: true\`${steeringSuffix()}`
}
