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

type TabProps = {
  title: string
  id?: string
  children?: React.ReactNode
}

export function Tab({ children }: TabProps): React.ReactNode {
  return <>{children}</>
}

type TabsProps = {
  title?: React.ReactNode
  color?: string
  defaultTab?: string
  selectedTab?: string
  onTabChange?: (tabId: string) => void
  children?: React.ReactNode
  hidden?: boolean
  disableNavigation?: boolean
  initialHeaderFocused?: boolean
  banner?: React.ReactNode
  contentHeight?: number
  fullWidth?: boolean
  useFullWidth?: boolean
  navFromContent?: boolean
}

type TabsContextValue = {
  selectedTab: string
  width: number | undefined
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
  registerNavOptIn: () => () => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

const NOOP = (): void => {}

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

export function Tabs({
  title,
  color,
  defaultTab,
  selectedTab,
  onTabChange,
  children,
  hidden = false,
  disableNavigation = false,
  initialHeaderFocused = true,
  banner,
  contentHeight,
  fullWidth,
  useFullWidth,
  navFromContent,
}: TabsProps): React.ReactNode {
  const tabs = tabEntries(children)
  if (tabs.length === 0) {
    throw new Error('Tabs requires at least one Tab child')
  }

  const isControlled = selectedTab !== undefined
  const [uncontrolledIndex, setUncontrolledIndex] = useState<number>(() => {
    if (defaultTab !== undefined) {
      const idx = tabs.findIndex(tab => tab.id === defaultTab)
      if (idx >= 0) return idx
    }
    return 0
  })

  const selectedIndex = isControlled
    ? Math.max(
        0,
        tabs.findIndex(tab => tab.id === selectedTab),
      )
    : Math.min(uncontrolledIndex, tabs.length - 1)
  const activeTab = tabs[selectedIndex]!

  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused)
  const [navOptInCount, setNavOptInCount] = useState(0)
  const hasNavOptIn = navOptInCount > 0

  const focusHeader = useCallback(() => setHeaderFocused(true), [])
  const blurHeader = useCallback(() => setHeaderFocused(false), [])
  const registerNavOptIn = useCallback(() => {
    setNavOptInCount(count => count + 1)
    return () => {
      setNavOptInCount(count => Math.max(0, count - 1))
    }
  }, [])

  const isInsideModal = useIsInsideModal()
  const { columns } = useTerminalSize()
  const isFullWidth = Boolean(fullWidth || useFullWidth)
  const contentWidth = isFullWidth ? columns : undefined

  const currentIndexRef = useRef(selectedIndex)
  currentIndexRef.current = selectedIndex

  const selectIndex = useCallback(
    (nextIndex: number) => {
      const wrapped = ((nextIndex % tabs.length) + tabs.length) % tabs.length
      const nextTab = tabs[wrapped]
      if (!nextTab) return
      if (!isControlled) {
        setUncontrolledIndex(wrapped)
      }
      setHeaderFocused(true)
      onTabChange?.(nextTab.id)
    },
    [tabs, isControlled, onTabChange],
  )

  const navActive =
    !hidden &&
    !disableNavigation &&
    (headerFocused || (hasNavOptIn && navFromContent !== false))

  useKeybindings(
    {
      'tabs:next': () => selectIndex(currentIndexRef.current + 1),
      'tabs:previous': () => selectIndex(currentIndexRef.current - 1),
    },
    { context: 'Tabs', isActive: navActive },
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (hidden || !hasNavOptIn || !headerFocused) return
      if (event.key === 'down') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setHeaderFocused(false)
      }
    },
    [hidden, hasNavOptIn, headerFocused],
  )

  const contextValue = useMemo<TabsContextValue>(
    () => ({
      selectedTab: activeTab.id,
      width: contentWidth,
      headerFocused,
      focusHeader,
      blurHeader,
      registerNavOptIn,
    }),
    [activeTab.id, contentWidth, headerFocused, focusHeader, blurHeader, registerNavOptIn],
  )

  const contentMarginTop = hidden ? 0 : 1

  const panel = isInsideModal ? (
    <ScrollBox
      key={activeTab.id}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      width={contentWidth}
      marginTop={contentMarginTop}
    >
      {activeTab.children}
    </ScrollBox>
  ) : contentHeight !== undefined ? (
    <Box
      flexDirection="column"
      height={contentHeight}
      overflowY="hidden"
      width={contentWidth}
      marginTop={contentMarginTop}
    >
      {activeTab.children}
    </Box>
  ) : (
    <Box
      flexDirection="column"
      width={contentWidth}
      marginTop={contentMarginTop}
    >
      {activeTab.children}
    </Box>
  )

  return (
    <TabsContext.Provider value={contextValue}>
      <Box flexDirection="column" width={contentWidth} onKeyDown={handleKeyDown}>
        {!hidden ? (
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {title !== undefined ? (
              <Text bold color={color}>
                {title}
              </Text>
            ) : null}
            {tabs.map((tab, idx) => {
              const isSelected = idx === selectedIndex
              return (
                <Text
                  key={tab.id}
                  bold={isSelected}
                  color={isSelected ? color : undefined}
                  inverse={isSelected && headerFocused}
                  dimColor={!isSelected}
                >
                  {` ${tab.title} `}
                </Text>
              )
            })}
          </Box>
        ) : null}
        {banner !== undefined ? <Box flexShrink={0}>{banner}</Box> : null}
        {panel}
      </Box>
    </TabsContext.Provider>
  )
}

export function useTabHeaderFocus(): {
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
} {
  const ctx = useContext(TabsContext)
  const register = ctx?.registerNavOptIn
  useClaim(() => {
    if (!register) return
    return register()
  }, [register])
  if (!ctx) {
    return { headerFocused: false, focusHeader: NOOP, blurHeader: NOOP }
  }
  return {
    headerFocused: ctx.headerFocused,
    focusHeader: ctx.focusHeader,
    blurHeader: ctx.blurHeader,
  }
}

export default Tabs
