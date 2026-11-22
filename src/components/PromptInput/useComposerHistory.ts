import type React from 'react'
import { useCallback, useMemo } from 'react'
import type { Notification } from '../../context/notifications.js'
import { useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import type { CompactFrameBudget } from '../mercury-ui/geometry.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const LOST_LINE_NOTICE_MS = 8000

export function useComposerHistory(arg0: {
  input: string
  pastedContents: Record<number, PastedContent>
  mode: PromptInputMode
  onChange: (value: string) => void
  setMode: (mode: PromptInputMode) => void
  setCursorOffset: (offset: number) => void
  buffer: ReturnType<typeof useInputBuffer>
  columns: number
  isCompact: boolean
  compactBudget: CompactFrameBudget | null
  historyRecallActiveRef: React.MutableRefObject<boolean>
  addNotification: (notification: Notification) => void
}): Unbuilt {
  return notBuilt('src/components/PromptInput/useComposerHistory.ts:16')
}
