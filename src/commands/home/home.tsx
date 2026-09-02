import * as React from 'react'
import { FAINT } from '../../components/mercuryPalette.js'
import { MercuryHome } from '../../components/MercuryHome.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

function HomePanel({ onClose }: { onClose: () => void }): React.ReactNode {
  useInput((_i, key) => {
    if (key.escape) onClose()
  })
  return (
    <Box flexDirection="column">
      <MercuryHome />
      <Box paddingX={1}>
        <Text color={FAINT}>esc to close</Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <HomePanel onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
