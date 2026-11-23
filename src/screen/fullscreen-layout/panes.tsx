import React, { useCallback, useRef } from 'react'
import { Box, Text } from '../themedRenderer.js'
import ScrollBox, { type ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import CursorDeclarationContext from '../renderer/elements/CursorDeclarationContext.js'
import { useCursorFollow } from '../widgets/useCursorFollow.js'
import { useLayoutClaim, useLayoutPublish } from '../effects/effects.js'
import { usePromptOverlay, usePromptOverlayDialog } from '../overlays/promptOverlay.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { PromptInputFooterSuggestions } from '../composer/ComposerFooterSuggestions.js'

export type UnseenDivider = { firstUnseenUuid: string; count: number }

export function PromptOverlayStrip(): React.ReactNode {
  const data = usePromptOverlay()
  const dialog = usePromptOverlayDialog()
  if (dialog) return <Box flexDirection="column">{dialog}</Box>
  if (!data) return null
  return (
    <PromptInputFooterSuggestions
      suggestions={data.suggestions}
      overlay
      onPick={data.onPick}
      onHover={data.onHover}
      maxColumnWidth={data.maxColumnWidth}
      maxRows={data.maxRows}
    />
  )
}

export function JumpPill({
  divider,
  scrollRef,
  dividerYRef,
  onClick,
}: {
  divider: UnseenDivider | undefined
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  dividerYRef: React.MutableRefObject<number | null>
  onClick: () => void
}): React.ReactNode {
  const visible = React.useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const handle = scrollRef.current
        if (!handle) return () => {}
        const offScroll = handle.subscribe(listener)
        const offLayout = handle.subscribeLayout(listener)
        return () => {
          offScroll()
          offLayout()
        }
      },
      [scrollRef],
    ),
    () => {
      const handle = scrollRef.current
      if (!handle || dividerYRef.current === null || handle.isSticky()) return false
      return (
        handle.getScrollTop() +
          handle.getPendingDelta() +
          handle.getFreshViewportHeight() <
        handle.getFreshScrollHeight()
      )
    },
    () => false,
  )
  if (!visible) return null
  const count = divider?.count ?? 0
  const label =
    count === 0
      ? '[ back to the bottom · alt+↓ ]'
      : `[ ${count} new ${count === 1 ? 'message' : 'messages'} · alt+↓ ]`
  return (
    <>
      <Box height={1} flexShrink={0} />
      <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
        <InteractiveRow
          id="transcript:jump-to-new"
          directActivate
          onActivate={onClick}
          height={1}
        >
          {(hover: boolean) => (
            <Text backgroundColor={hover ? 'infoShimmer' : 'info'} bold>
              {label}
            </Text>
          )}
        </InteractiveRow>
      </Box>
    </>
  )
}

export function ModalPaneBody({ rows, columns, scrollRef, children }: { rows: number; columns: number; scrollRef: React.RefObject<ScrollBoxHandle | null> | null; children: React.ReactNode }): React.ReactNode {
  const paneRef = useRef<ScrollBoxHandle | null>(null)
  const follow = useCursorFollow(paneRef, { rows, width: columns })
  useLayoutPublish(() => {
    if (scrollRef && scrollRef.current === null) scrollRef.current = paneRef.current
  })
  useLayoutClaim(() => () => {
    if (scrollRef && scrollRef.current === paneRef.current) scrollRef.current = null
  }, [scrollRef])
  return (
    <CursorDeclarationContext.Provider value={follow}>
      <ScrollBox ref={paneRef} flexShrink={1} minHeight={0} flexDirection="column">
        {children}
      </ScrollBox>
    </CursorDeclarationContext.Provider>
  )
}
