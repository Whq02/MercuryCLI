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

const LOST_LINE_NOTICE_MS = 8000

export function useComposerHistory({
  input,
  pastedContents,
  mode,
  onChange,
  setMode,
  setCursorOffset,
  buffer,
  columns,
  isCompact,
  compactBudget,
  historyRecallActiveRef,
  addNotification,
}: {
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
}) {
  const recallFitsOneRow = useCallback(
    (value: string): boolean => {
      if (value.includes('\n')) return false
      return stringWidth(value) <= Math.max(1, (isCompact ? compactBudget?.inputColumns ?? columns : columns - 3) - 1)
    },
    [columns, isCompact, compactBudget?.inputColumns],
  )
  const applyRecalledEntry = useCallback(
    (value: string, recalledMode: PromptInputMode, recalledPastes: Record<number, PastedContent>): void => {
      onChange(value)
      setMode(recalledMode)
      pendingInput.setPastedContents(recalledPastes)
    },
    [onChange, setMode],
  )
  const history = useArrowKeyHistory(
    applyRecalledEntry,
    input,
    pastedContents,
    setCursorOffset,
    mode,
    recallFitsOneRow,
  )
  historyRecallActiveRef.current = history.historyIndex !== 0
  const recallQueuedSend = useCallback((): boolean => {
    const focused = getFocusedSessionConnector()
    const queued = focused.recallableSend()
    if (queued === null) return false
    void focused.withdrawSend(queued.clientMessageId).then(receipt => {
      if (receipt.withdrawn) {
        const meanwhile = pendingInput.text()
        const value = meanwhile === '' ? receipt.text : `${receipt.text}${meanwhile}`
        applyRecalledEntry(value, receipt.mode, receipt.pastedContents)
        setCursorOffset(value.length)
        return
      }
      addNotification({ key: 'recall-send', text: receipt.detail, priority: 'immediate', timeoutMs: receipt.retired === true ? LOST_LINE_NOTICE_MS : 4000 })
    })
    return true
  }, [applyRecalledEntry, setCursorOffset, addNotification])

  const helpers: PromptInputHelpers = useMemo(
    () => ({
      setCursorOffset,
      clearBuffer: buffer.clearBuffer,
      resetHistory: history.resetHistory,
    }),
    [setCursorOffset, buffer.clearBuffer, history.resetHistory],
  )
  return { history, recallQueuedSend, helpers }
}
