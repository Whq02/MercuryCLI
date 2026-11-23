import * as React from 'react'
import { Box, Text, useInput, wrapText } from '../themedRenderer.js'
import { loadSwarm } from '../../crew/board/seam.js'
import type { BoardModule, BoardViewSnapshot } from '../../crew/board/contracts.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { CommandCenter } from '../widgets/components.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'

export function CrewChatPanel({ snapshot, traffic, onClose, onSection }: { snapshot: BoardViewSnapshot; traffic: Parameters<BoardModule['view']>[0]['traffic']; onClose: () => void; onSection: (id: 'prompts' | 'saved') => void }): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  useInput((input, key) => {
    if (key.tab) onSection(key.shift ? 'prompts' : 'saved')
    if (input === '1') onSection('prompts')
    if (input === '3') onSection('saved')
  })
  const View = loadSwarm().view
  return <CommandCenter elevated view="workbench" onClose={onClose} captureInput={false} footer="" closeKeys="none">
    <Text><Text dimColor>PROMPTS</Text>{' · '}<Text bold>Crew chat</Text>{' · '}<Text dimColor>SAVED PROMPTS</Text></Text>
    <View React={React} Text={Text} Box={Box} tokens={tokens} useInput={useInput} wrapText={wrapText} snapshot={snapshot} traffic={traffic} onBack={onClose} width={Math.max(1, columns - 6)} height={Math.max(3, rows - 8)} />
  </CommandCenter>
}
