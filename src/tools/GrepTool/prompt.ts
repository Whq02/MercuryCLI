

export const GREP_TOOL_NAME = 'Grep'

function steeringSuffix(offered: ReadonlySet<string> | null): string {
  try {
    const { searchSteeringLine } =
      require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
    const line = searchSteeringLine(offered)
    return line ? `\n${line}` : ''
  } catch {
    return ''
  }
}

export function getDescription(offered: ReadonlySet<string> | null = null): string {
  return `Content search across the tree, powered by ripgrep

Usage:
- Pattern dialect: ripgrep's, not grep's — literal braces need escaping (\`interface\\{\\}\` reaches \`interface{}\` in Go code); lookaround and backreferences fall back to PCRE2
- \`literal: true\` matches the pattern as exact text (rg -F): \`foo(bar[0])\`, \`$VAR\` or \`a.b\` need no escaping${steeringSuffix(offered)}`
}
