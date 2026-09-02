import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { SessionMark } from './mercury-ui/assets.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

export function MercuryExitConfirm({
  liveCount,
  onQuit,
  onStay,
}: {
  liveCount: number
  onQuit: () => void
  onStay: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const pastBuffer = useOpenEventGate()
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onStay()
      return
    }
    if (!pastBuffer()) return
    if (key.return || input === 'y' || input === 'Y') {
      onQuit()
    }
  })
  const noun = liveCount === 1 ? 'agent is' : 'agents are'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} marginTop={1}>
      <Text>
        {
}
        <SessionMark />{' '}
        <Text bold color={t.textPrimary}>
          Leave Mercury?
        </Text>{' '}
        <Text color={t.textSecondary}>
          {liveCount} {noun} still running
        </Text>
      </Text>
      <Text color={t.textMuted}>quitting stops them · the session itself stays resumable</Text>
      <Text>
        {
}
        <Text color={t.failure}>[y]</Text> <Text color={t.textSecondary}>quit</Text>
        <Text color={t.textMuted}> · ↵ quit</Text>
        {'   '}
        <Text color={t.success}>[n]</Text> <Text color={t.textSecondary}>stay</Text>
        <Text color={t.textMuted}> · esc stay</Text>
      </Text>
    </Box>
  )
}
