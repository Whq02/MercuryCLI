
import React, { createContext, useContext } from 'react'
import { Text } from '../themedRenderer.js'
import { GLYPH } from '../theme/glyphs.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { InVirtualListContext } from './messageActions.js'

const NestedRowsContext = createContext(false)

export function NestedRowsProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <NestedRowsContext.Provider value={true}>{children}</NestedRowsContext.Provider>
  )
}

export function CtrlOToExpand(): React.ReactNode {
  const inNestedRows = useContext(NestedRowsContext)
  const inVirtualList = useContext(InVirtualListContext)
  const chord = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  if (inNestedRows) return null
  if (inVirtualList) {
    return <Text dimColor>{GLYPH.chevronDown}</Text>
  }
  return <Text dimColor>({chord} to expand)</Text>
}

export default CtrlOToExpand
