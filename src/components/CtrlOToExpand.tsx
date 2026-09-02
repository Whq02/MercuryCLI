// The "there is more to see" affordance. Inside a subagent's output it
// renders nothing (a card of nested rows must not repeat the hint on every
// one); inside a virtual list it is a single faint end-of-line chevron;
// otherwise the full parenthesised "<chord> to expand" hint with the
// operator's configured chord.

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
    // The down chevron says "opens below" — the fold marker of a row that
    // can be expanded in place (the right chevron is the navigation cue
    // elsewhere in the chrome). No leading space — the call sites already
    // print one.
    return <Text dimColor>{GLYPH.chevronDown}</Text>
  }
  return <Text dimColor>({chord} to expand)</Text>
}

/** The plain-string form for non-component contexts — always the full
 *  parenthesised hint (the caller dims it). */
export function ctrlOToExpand(): string {
  return `(${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
}

export default CtrlOToExpand
