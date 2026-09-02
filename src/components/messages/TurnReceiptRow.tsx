import * as React from 'react'
import { BULLET_OPERATOR } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import type { TurnReceiptMessage } from '../../types/message.js'
import { plural } from '../../utils/stringUtils.js'

// The per-turn work receipt: one dim line at the turn boundary —
//   ∙ 3 scratchpad edits +125 −19 · 2 files read · 5 shell commands
// Counts stay dim; only the line-delta accents carry color (diff semantics).
export function TurnReceiptRow({
  message,
}: {
  message: TurnReceiptMessage
}): React.ReactNode {
  const c = message.counts
  const parts: React.ReactNode[] = []
  const push = (node: React.ReactNode) => {
    if (parts.length > 0) parts.push(<Text key={`sep-${parts.length}`}> · </Text>)
    parts.push(node)
  }
  const delta =
    c.adds > 0 || c.dels > 0 ? (
      <>
        {c.adds > 0 && <Text color="success"> +{c.adds}</Text>}
        {c.dels > 0 && <Text color="error"> −{c.dels}</Text>}
      </>
    ) : null
  if (c.scratchpadEdits > 0) {
    push(
      <Text key="scratch">
        {c.scratchpadEdits} scratchpad {plural(c.scratchpadEdits, 'edit')}
        {c.fileEdits === 0 ? delta : null}
      </Text>,
    )
  }
  if (c.fileEdits > 0) {
    push(
      <Text key="edits">
        {c.fileEdits} file {plural(c.fileEdits, 'edit')}
        {delta}
      </Text>,
    )
  }
  if (c.reads > 0) {
    push(
      <Text key="reads">
        {c.reads} {plural(c.reads, 'file')} read
      </Text>,
    )
  }
  if (c.searches > 0) {
    push(
      <Text key="searches">
        {c.searches} {plural(c.searches, 'search', 'searches')}
      </Text>,
    )
  }
  if (c.commands > 0) {
    push(
      <Text key="cmds">
        {c.commands} shell {plural(c.commands, 'command')}
      </Text>,
    )
  }
  if (parts.length === 0) return null
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {BULLET_OPERATOR} {parts}
      </Text>
    </Box>
  )
}
