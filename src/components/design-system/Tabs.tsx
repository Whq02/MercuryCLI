import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useClaim } from '../../hooks/effects.js'
import { Box, Text } from '../../ink.js'
import ScrollBox from '../../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type TabProps = {
  title: string
  id?: string
  children?: React.ReactNode
}

export function Tab({ children }: TabProps): React.ReactNode {
  return <>{children}</>
}

type TabsProps = Unbuilt

type TabEntry = { id: string; title: string; children: React.ReactNode }

function tabEntries(children: React.ReactNode): TabEntry[] {
  const entries: TabEntry[] = []
  React.Children.forEach(children, child => {
    if (!React.isValidElement<TabProps>(child)) return
    const props = child.props
    entries.push({
      id: props.id ?? props.title,
      title: props.title,
      children: props.children,
    })
  })
  return entries
}

export function Tabs(arg0: TabsProps): React.ReactNode {
  return notBuilt('src/components/design-system/Tabs.tsx:70')
}

export function useTabHeaderFocus(): {
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
} {
  return notBuilt('src/components/design-system/Tabs.tsx:235')
}

export default Tabs
