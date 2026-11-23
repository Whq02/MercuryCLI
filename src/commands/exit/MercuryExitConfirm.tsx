import * as React from 'react'
import { Box, Text, useInput } from '../../screen/themedRenderer.js'
import { SessionMark } from '../../screen/widgets/assets.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { useOpenEventGate } from '../../screen/widgets/useOpenEventGate.js'
import { takeTesterDoor } from '../feedback/testerDoor.js'

export function MercuryExitConfirm({
  liveWords,
  hasRunning = true,
  onQuit,
  onStay,
}: {
  liveWords: string
  hasRunning?: boolean
  onQuit: () => void
  onStay: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const [testerDoor] = React.useState(() => takeTesterDoor())
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} marginTop={1}>
      <Text>
        {}
        <SessionMark />{' '}
        <Text bold color={t.textPrimary}>
          Leave Mercury?
        </Text>{' '}
        <Text color={t.textSecondary}>
          {liveWords} still running
        </Text>
      </Text>
      <Text color={t.textMuted}>
        {hasRunning
          ? 'quitting stops them · see them with /runs · the session itself stays resumable'
          : 'the session itself stays resumable'}
      </Text>
      {testerDoor !== null ? <Text color={t.textMuted}>{testerDoor}</Text> : null}
      <Text>
        {}
        <Text color={t.failure}>[y]</Text> <Text color={t.textSecondary}>quit</Text>
        <Text color={t.textMuted}> · ↵ quit</Text>
        {'   '}
        <Text color={t.success}>[n]</Text> <Text color={t.textSecondary}>stay</Text>
        <Text color={t.textMuted}> · esc stay</Text>
      </Text>
    </Box>
  )
}
