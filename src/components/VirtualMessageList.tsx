import React, {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useLayoutPublish, useMeasure } from '../hooks/effects.js'
import { Box } from '../ink.js'
import type { DOMElement } from '../ink/dom.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { MatchPosition } from '../ink/render-to-screen.js'
import type { SearchPositionsState } from '../ink/hooks/use-search-highlight.js'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import { InteractiveDisclosure } from './mercury-ui/InteractiveDisclosure.js'
import { useHoverOwned } from './mercury-ui/useHoverOwned.js'
import { claimHover, releaseHover } from '../utils/cockpit/hoverOwner.js'
import type { RenderableMessage } from '../types/message.js'
import { hasNoticeFold } from '../utils/messages/noticeRows.js'
import {
  renderableSearchText,
  type TranscriptFacets,
} from '../utils/transcriptSearch.js'
import { TextHoverColorContext } from './design-system/ThemedText.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import { reconcileItemKeys, type ItemKeyState } from './virtualListKeys.js'
import {
  isNavigableMessage,
  toolCallOf,
  type MessageActionsNav,
  type MessageActionsState,
} from './messageActions.js'
import { JUMP_HEADROOM_ROWS, newEngineState, type JumpHandle, type SearchEngineState } from './virtualMessageList/engine.js'
import { cursorNavHandleOf, jumpHandleOf } from './virtualMessageList/handles.js'
import { advanceOf, settleOnMessageOf } from './virtualMessageList/search.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type { JumpHandle } from './virtualMessageList/engine.js'

type VirtualMessageListProps = Unbuilt

let instanceCounter = 0
const ALIGN_WHEN_MOUNTED_RENDERS = 4


function VirtualItem({
  hoverId,
  expanded,
  clickable,
  measureRef,
  onClick,
  children,
}: {
  hoverId: string
  expanded: boolean
  clickable: boolean
  measureRef: (el: DOMElement | null) => void
  onClick: ((event: ClickEvent) => void) | undefined
  children: React.ReactNode
}): React.ReactNode {
  const hovered = useHoverOwned(hoverId) && clickable
  return (
    <InteractiveDisclosure
      rowRef={measureRef}
      expanded={expanded}
      clickable={clickable}
      onToggle={onClick}
      onHoverIn={() => {
        claimHover(hoverId)
      }}
      onHoverOut={() => {
        releaseHover(hoverId)
      }}
    >
      <TextHoverColorContext.Provider
        value={hovered && !expanded ? 'text' : undefined}
      >
        {children}
      </TextHoverColorContext.Provider>
    </InteractiveDisclosure>
  )
}


export function VirtualMessageList(arg0: VirtualMessageListProps): React.ReactNode {
  return notBuilt('src/components/VirtualMessageList.tsx:106')
}

export default VirtualMessageList
