// Tab header + content with the header-focus model. A tab's identity is its
// explicit id, falling back to its title. Only the selected tab's children
// render — a non-selected tab's content subtree is UNMOUNTED, so hooks,
// transient state and key handlers inside a tab exist only while that tab
// is selected (consumers rely on the per-tab remount/reload).
//
// Navigate-from-content and the down-arrow header blur are opt-in: they act
// only when at least one descendant has registered the opt-in — which the
// header-focus hook does on mount. Calling that hook above an early return
// that renders static content strands the user with no way back to the
// header.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, Text } from '../../ink.js'
import ScrollBox from '../../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'

export type TabProps = {
  title: string
  id?: string
  children?: React.ReactNode
}

export function Tab({ children }: TabProps): React.ReactNode {
  return <>{children}</>
}

type TabsContextValue = {
  contentWidth: number | undefined
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
  /** Register the navigate-from-content opt-in; returns the unregister. */
  registerNavOptIn: () => () => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

export type TabsProps = {
  children: React.ReactNode
  title?: string
  color?: string
  defaultTab?: string
  hidden?: boolean
  useFullWidth?: boolean
  /** Controlled mode: the selected tab id; changes report through
   *  onTabChange. */
  selectedTab?: string
  onTabChange?: (id: string) => void
  /** Rendered between the header and the content. */
  banner?: React.ReactNode
  disableNavigation?: boolean
  initialHeaderFocused?: boolean
  /** Fixed content height outside a modal, clipping overflow so switching
   *  tabs cannot shift layout. */
  contentHeight?: number
  navFromContent?: boolean
}

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
  children,
  title,
  color = 'permission',
  defaultTab,
  hidden = false,
  useFullWidth = false,
  selectedTab,
  onTabChange,
  banner,
  disableNavigation = false,
  initialHeaderFocused = true,
  contentHeight,
}: TabsProps): React.ReactNode {
  const tabs = tabEntries(children)
  if (tabs.length === 0) {
    throw new Error('Tabs requires at least one Tab child')
  }
  const { columns } = useTerminalSize()
  const isInsideModal = useIsInsideModal()

  // Controlled when a selected id is supplied; unknown ids fall back to the
  // first tab in both modes.
  const [internalIndex, setInternalIndex] = useState(() => {
    if (defaultTab === undefined) return 0
    const at = tabs.findIndex(tab => tab.id === defaultTab)
    return at === -1 ? 0 : at
  })
  const isControlled = selectedTab !== undefined
  let selectedIndex: number
  if (isControlled) {
    const at = tabs.findIndex(tab => tab.id === selectedTab)
    selectedIndex = at === -1 ? 0 : at
  } else {
    selectedIndex = Math.min(internalIndex, tabs.length - 1)
  }

  const [headerFocused, setHeaderFocused] = useState(initialHeaderFocused)
  const [navOptInCount, setNavOptInCount] = useState(0)
  const hasNavOptIn = navOptInCount > 0

  const focusHeader = useCallback(() => {
    setHeaderFocused(true)
  }, [])
  const blurHeader = useCallback(() => {
    setHeaderFocused(false)
  }, [])
  const registerNavOptIn = useCallback(() => {
    setNavOptInCount(count => count + 1)
    return () => {
      setNavOptInCount(count => count - 1)
    }
  }, [])

  const changeTab = (nextIndex: number): void => {
    const target = tabs[nextIndex]
    if (!target) return
    if (isControlled) onTabChange?.(target.id)
    else {
      setInternalIndex(nextIndex)
      onTabChange?.(target.id)
    }
    // Changing tabs always returns focus to the header.
    setHeaderFocused(true)
  }

  const visible = !hidden
  const cycle = (delta: number): void => {
    changeTab((selectedIndex + delta + tabs.length) % tabs.length)
  }
  useKeybindings(
    {
      'tabs:next': () => {
        cycle(1)
      },
      'tabs:previous': () => {
        cycle(-1)
      },
    },
    {
      context: 'Tabs',
      isActive:
        visible && !disableNavigation && (headerFocused || hasNavOptIn),
    },
  )

  // The content width is fixed only in full-width mode (the header pads to
  // the terminal with its trailing spacer); otherwise the tabs impose no
  // width and useTabsWidth reports nothing. The per-cell ` title ` padding
  // keeps the width arithmetic (title +1, each tab +3 with the gap).
  const contentWidth = useFullWidth ? columns : undefined

  const contextValue = useMemo<TabsContextValue>(
    () => ({
      contentWidth,
      headerFocused,
      focusHeader,
      blurHeader,
      registerNavOptIn,
    }),
    [contentWidth, headerFocused, focusHeader, blurHeader, registerNavOptIn],
  )

  const selected = tabs[selectedIndex]
  const tabContent = (
    <Box
      key={selected?.id}
      width={contentWidth}
      flexShrink={isInsideModal ? 0 : 1}
      flexDirection="column"
    >
      {selected?.children}
    </Box>
  )

  return (
    <TabsContext.Provider value={contextValue}>
      <Box
        flexDirection="column"
        tabIndex={-1}
        autoFocus
        onKeyDown={(event: KeyboardEvent) => {
          // Down-arrow blurs the header, only with a registered opt-in.
          if (event.key === 'down' && visible && hasNavOptIn && headerFocused) {
            setHeaderFocused(false)
          }
        }}
      >
        {visible ? (
          <Box gap={1} width={useFullWidth ? columns : undefined}>
            {title !== undefined && title !== '' ? (
              <Text bold color={color}>
                {title}
              </Text>
            ) : null}
            {tabs.map((tab, index) => {
              const isSelected = index === selectedIndex
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
            {useFullWidth ? <Box flexGrow={1} /> : null}
          </Box>
        ) : null}
        {banner}
        <Box marginTop={visible ? 1 : 0} flexDirection="column">
          {isInsideModal ? (
            <ScrollBox key={selected?.id}>{tabContent}</ScrollBox>
          ) : contentHeight !== undefined ? (
            <Box
              height={contentHeight}
              overflowY="hidden"
              flexDirection="column"
            >
              {tabContent}
            </Box>
          ) : (
            tabContent
          )}
        </Box>
      </Box>
    </TabsContext.Provider>
  )
}

/** The current content width; undefined outside a Tabs. */
export function useTabsWidth(): number | undefined {
  return useContext(TabsContext)?.contentWidth
}

/** Header focus state plus focus/blur callbacks. Outside a Tabs the hook
 *  reports "header not focused" and its callbacks are inert. Mounting it
 *  registers the navigate-from-content opt-in. */
export function useTabHeaderFocus(): {
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
} {
  const context = useContext(TabsContext)
  const register = context?.registerNavOptIn
  const registeredRef = useRef(false)
  useEffect(() => {
    if (!register || registeredRef.current) return
    registeredRef.current = true
    const unregister = register()
    return () => {
      registeredRef.current = false
      unregister()
    }
  }, [register])
  if (!context) {
    return {
      headerFocused: false,
      focusHeader: () => {},
      blurHeader: () => {},
    }
  }
  return {
    headerFocused: context.headerFocused,
    focusHeader: context.focusHeader,
    blurHeader: context.blurHeader,
  }
}

export default Tabs
