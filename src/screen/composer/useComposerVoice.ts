import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useClaim, usePublish } from '../effects/effects.js'
import type { Notification } from '../notifications/notifications.js'
import * as pendingInput from './input-core/pending-input.js'
import type { Key } from '../renderer/events/input-event.js'
import { holdToTalkKey, setHoldToTalkEditor } from '../../integrations/voice/holdToTalk.js'
import { subscribeVoice, voiceSnapshot } from '../../integrations/voice/voiceSession.js'
import type { ComposerAttachments } from './useComposerAttachments.js'

export function useComposerVoiceReceipt(addNotification: (notification: Notification) => void) {
  const voice = useSyncExternalStore(subscribeVoice, voiceSnapshot, voiceSnapshot)
  const voiceReceiptSeqRef = useRef(0)
  usePublish(() => {
    const receipt = voice.receipt
    if (receipt === null || receipt.seq === voiceReceiptSeqRef.current) return
    voiceReceiptSeqRef.current = receipt.seq
    addNotification({
      key: 'voice-receipt',
      text: receipt.text,
      priority: 'immediate',
      ...(receipt.tone === 'error' ? { color: 'error' as const } : {}),
      timeoutMs: 8000,
    })
  }, [voice.receipt, addNotification])
  return voice
}

export function useComposerHoldToTalk({
  cursorRef,
  writeDraft,
  setCursorOffset,
}: {
  cursorRef: ComposerAttachments['cursorRef']
  writeDraft: (text: string) => void
  setCursorOffset: (offset: number) => void
}) {
  const voiceInputFilter = useCallback((rawInput: string, key: Key): string => holdToTalkKey(rawInput, key), [])
  useClaim(() => {
    setHoldToTalkEditor({
      text: () => pendingInput.text(),
      cursor: () => cursorRef.current,
      splice: (deleteBefore, insert) => {
        const text = pendingInput.text()
        const at = Math.max(0, Math.min(cursorRef.current, text.length))
        const from = Math.max(0, at - deleteBefore)
        const next = text.slice(0, from) + insert + text.slice(at)
        writeDraft(next)
        setCursorOffset(from + insert.length)
      },
    })
    return () => setHoldToTalkEditor(null)
  }, [setCursorOffset])
  return voiceInputFilter
}
