import { BASH_TOOL_NAME } from '../BashTool/toolName.js'


export const GREP_TOOL_NAME = 'Grep'

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
- For open-ended hunts that will take several rounds of searching, delegate the hunt instead of repeating searches here
- Pattern dialect: ripgrep's, not grep's — literal braces need escaping (\`interface\\{\\}\` reaches \`interface{}\` in Go code)
- Multiline: patterns stay within one line unless asked otherwise. A cross-line pattern (say \`struct \\{[\\s\\S]*?field\`) wants \`multiline: true\`${steeringSuffix()}`
}
