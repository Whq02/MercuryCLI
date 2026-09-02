
import React, { createContext, useContext } from 'react'
import { Text } from '../ink.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { InVirtualListContext } from './messageActions.js'

const SubAgentContext = createContext(false)

export function SubAgentProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <SubAgentContext.Provider value={true}>{children}</SubAgentContext.Provider>
  )
}

export function CtrlOToExpand(): React.ReactNode {
  const inSubAgent = useContext(SubAgentContext)
  const inVirtualList = useContext(InVirtualListContext)
  const chord = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  if (inSubAgent) return null
  if (inVirtualList) {
    return <Text dimColor>{GLYPH.chevronDown}</Text>
  }
  return <Text dimColor>({chord} to expand)</Text>
}

export function ctrlOToExpand(): string {
  return `(${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
}

export default CtrlOToExpand
