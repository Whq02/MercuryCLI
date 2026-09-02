import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { BULLET_OPERATOR, OUTPUT_CONNECTOR } from '../../constants/figures.js'
import { FORK_BOILERPLATE_TAG, FORK_DIRECTIVE_PREFIX } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

// A fork child's first message: `<fork-boilerplate>…worker rules…</fork-boilerplate>`
// followed by `Your directive: <directive>` (buildChildMessage, forkSubagent.ts).
// The transcript view leads with the directive and collapses the rules — the
// boilerplate is spawn plumbing, the directive is the content.
const BOILERPLATE_RE = new RegExp(
  `<${FORK_BOILERPLATE_TAG}>\\n?([\\s\\S]*?)\\n?</${FORK_BOILERPLATE_TAG}>\\s*`,
)

export function UserForkBoilerplateMessage({
  addMargin,
  param: { text },
}: Props): React.ReactNode {
  const m = BOILERPLATE_RE.exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const directive = (
    rest.startsWith(FORK_DIRECTIVE_PREFIX) ? rest.slice(FORK_DIRECTIVE_PREFIX.length) : rest
  ).trim()
  const ruleLines = (m[1] ?? '').split('\n').filter(l => l.trim() !== '').length
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color="suggestion">{BULLET_OPERATOR}</Text>{' '}
        <Text dimColor>fork directive:</Text> {directive}
      </Text>
      <Text dimColor>
        {'  '}
        {OUTPUT_CONNECTOR}boilerplate collapsed ({ruleLines} lines of worker rules)
      </Text>
    </Box>
  )
}
