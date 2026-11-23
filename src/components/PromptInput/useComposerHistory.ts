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
}): {
  history: ReturnType<typeof useArrowKeyHistory>
  recallQueuedSend: () => boolean
  helpers: PromptInputHelpers
} {
  const inputWidth = isCompact ? (compactBudget?.inputColumns ?? columns) : columns - 3
  const maxOneRowWidth = Math.max(1, inputWidth - 1)
  const recallFitsOneRow = useCallback(
    (value: string): boolean => !value.includes('\n') && stringWidth(value) <= maxOneRowWidth,
    [maxOneRowWidth],
  )

  const onSetInput = useCallback(
    (
      value: string,
      nextMode: PromptInputMode,
      nextPastedContents: Record<number, PastedContent>,
    ) => {
      onChange(value)
      setMode(nextMode)
      pendingInput.setPastedContents(nextPastedContents)
    },
    [onChange, setMode],
  )

  const history = useArrowKeyHistory(
    onSetInput,
    input,
    pastedContents,
    setCursorOffset,
    mode,
    recallFitsOneRow,
  )

  historyRecallActiveRef.current = history.historyIndex !== 0

  const recallQueuedSend = useCallback((): boolean => {
    const connector = getFocusedSessionConnector()
    const recallable = connector.recallableSend()
    if (recallable === null) return false
    void connector.withdrawSend(recallable.clientMessageId).then(receipt => {
      if (receipt.withdrawn) {
        const current = pendingInput.text()
        const next = current.length > 0 ? receipt.text + current : receipt.text
        onChange(next)
        setMode(receipt.mode)
        pendingInput.setPastedContents(receipt.pastedContents)
        setCursorOffset(next.length)
      } else {
        addNotification({
          key: 'recall-send',
          text: receipt.detail,
          priority: 'immediate',
          timeoutMs: receipt.retired ? LOST_LINE_NOTICE_MS : 4000,
        })
      }
    })
    return true
  }, [onChange, setMode, setCursorOffset, addNotification])

  const { clearBuffer } = buffer
  const { resetHistory } = history
  const helpers = useMemo<PromptInputHelpers>(
    () => ({
      setCursorOffset,
      clearBuffer,
      resetHistory,
    }),
    [setCursorOffset, clearBuffer, resetHistory],
  )

  return { history, recallQueuedSend, helpers }
}
