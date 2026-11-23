import type React from 'react'
import { useCallback, useRef } from 'react'
import * as pendingInput from '../../input-core/pending-input.js'
import type { Notification } from '../../context/notifications.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { PastedContent } from '../../utils/config.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import type { LiveInputState } from '../../hooks/useTextInput.js'
import { useClaim } from '../../hooks/effects.js'
import { normalizePastedLines } from '../../input-core/composer-document.js'
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { setComposerInsert } from './composerInsert.js'
import { formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parseReferences } from '../../history.js'
import { PASTE_THRESHOLD } from '../../utils/imagePaste.js'
import { describeAttachedImage } from '../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../utils/imageStore.js'
import { hashPastedText, storePastedText } from '../../utils/pasteStore.js'
import { expandTabs, stripControls } from './composerText.js'
import { passedOver } from '../../utils/passedOver.js'

type ComposerAttachmentsInput = {
  input: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  readLiveState: () => LiveInputState
  messages: Message[]
  rows: number
  buffer: ReturnType<typeof useInputBuffer>
  inputSelectionRangeRef: React.MutableRefObject<() => { start: number; end: number } | null>
  writeDraft: (text: string) => void
  setCursorOffset: (offset: number) => void
  setMode: (mode: PromptInputMode) => void
  setPastedContents: (
    next:
      | Record<number, PastedContent>
      | ((previous: Record<number, PastedContent>) => Record<number, PastedContent>),
  ) => void
  addNotification: (notification: Notification) => void
  deferredSpaceArmedRef: React.MutableRefObject<boolean>
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
}

export type ComposerAttachments = {
  insertAtCursor: (text: string, options?: { atomic?: boolean }) => void
  insertAtomic: (text: string) => void
  handleImagePaste: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
    byteLength?: number,
  ) => void
  handleImageError: (message: string) => void
  handleTextPaste: (raw: string) => void
  cursorRef: React.MutableRefObject<number>
}

function highestHistoryReferenceId(messages: Message[]): number {
  let highest = 0
  const scanText = (text: string): void => {
    for (const reference of parseReferences(text)) {
      if (reference.id > highest) highest = reference.id
    }
  }
  for (const message of messages) {
    if (message.type === 'user') {
      for (const id of message.imagePasteIds ?? []) {
        if (id > highest) highest = id
      }
      const content = message.message.content
      if (typeof content === 'string') {
        scanText(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') scanText(block.text)
        }
      }
    } else if (message.type === 'assistant') {
      const content = message.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') scanText(block.text)
        }
      }
    }
  }
  return highest
}

export function useComposerAttachments({
  input,
  cursorOffset,
  pastedContents,
  readLiveState,
  messages,
  rows,
  buffer,
  inputSelectionRangeRef,
  writeDraft,
  setCursorOffset,
  setMode,
  setPastedContents,
  addNotification,
  deferredSpaceArmedRef,
  insertTextRef,
}: ComposerAttachmentsInput): ComposerAttachments {
  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: writeDraft,
    setCursorOffset,
    setPastedContents,
  })

  const nextPasteIdRef = useRef<number | null>(null)
  if (nextPasteIdRef.current === null) {
    nextPasteIdRef.current = highestHistoryReferenceId(messages) + 1
  }

  const allocatePasteId = useCallback((): number => {
    const used = new Set<number>()
    for (const reference of parseReferences(pendingInput.text())) {
      used.add(reference.id)
    }
    for (const key of Object.keys(pendingInput.pastedContents())) {
      const id = Number(key)
      if (Number.isFinite(id)) used.add(id)
    }
    let candidate = nextPasteIdRef.current ?? 1
    while (used.has(candidate)) {
      candidate += 1
    }
    nextPasteIdRef.current = candidate + 1
    return candidate
  }, [])

  const insertAtCursor = useCallback(
    (text: string, options?: { atomic?: boolean }) => {
      const live = readLiveState()
      const currentText = live.value
      const currentOffset = live.offset
      const currentPastes = pendingInput.pastedContents()
      if (options?.atomic) {
        buffer.pushAtomic(currentText, currentOffset, currentPastes)
      } else {
        buffer.pushToBuffer(currentText, currentOffset, currentPastes)
      }
      const range = inputSelectionRangeRef.current()
      let head: string
      let tail: string
      let hasSelection = false
      if (range !== null) {
        hasSelection = true
        const start = Math.max(0, Math.min(range.start, currentText.length))
        const end = Math.max(start, Math.min(range.end, currentText.length))
        head = currentText.slice(0, start)
        tail = currentText.slice(end)
      } else {
        const clamped = Math.max(0, Math.min(currentOffset, currentText.length))
        head = currentText.slice(0, clamped)
        tail = currentText.slice(clamped)
      }
      const needsSpace =
        !hasSelection &&
        tail.length === 0 &&
        head.length > 0 &&
        !/\s$/.test(head) &&
        text.length > 0 &&
        !/^\s/.test(text)
      const payload = needsSpace ? ` ${text}` : text
      writeDraft(head + payload + tail)
      setCursorOffset(pendingInput.sanitizeComposerText(head + payload).length)
    },
    [readLiveState, buffer, inputSelectionRangeRef, writeDraft, setCursorOffset],
  )

  const insertAtomic = useCallback(
    (text: string) => {
      insertAtCursor(text, { atomic: true })
    },
    [insertAtCursor],
  )

  const cursorRef = useRef(cursorOffset)
  cursorRef.current = cursorOffset

  const insertAtomicRef = useRef(insertAtomic)
  insertAtomicRef.current = insertAtomic
  const writeDraftRef = useRef(writeDraft)
  writeDraftRef.current = writeDraft
  const setCursorOffsetRef = useRef(setCursorOffset)
  setCursorOffsetRef.current = setCursorOffset
  const readLiveStateRef = useRef(readLiveState)
  readLiveStateRef.current = readLiveState

  useClaim(() => {
    const handle = {
      insert: (text: string) => {
        insertAtomicRef.current(text)
      },
      setInputWithCursor: (value: string, cursor: number) => {
        writeDraftRef.current(value)
        const actualLength = pendingInput.text().length
        setCursorOffsetRef.current(Math.max(0, Math.min(cursor, actualLength)))
      },
      get cursorOffset(): number {
        return readLiveStateRef.current().offset
      },
    }
    if (insertTextRef) {
      insertTextRef.current = handle
    }
    setComposerInsert(text => {
      insertAtomicRef.current(text)
    })
    return () => {
      if (insertTextRef) {
        insertTextRef.current = null
      }
      setComposerInsert(null)
      void pendingInput.flushDrafts()
    }
  }, [insertTextRef])

  const handleImagePaste = useCallback(
    (
      base64Image: string,
      mediaType?: string,
      filename?: string,
      dimensions?: ImageDimensions,
      sourcePath?: string,
      byteLength?: number,
    ) => {
      setMode('prompt')
      const id = allocatePasteId()
      const hadDeferredSpace = deferredSpaceArmedRef.current
      const record: PastedContent = {
        id,
        type: 'image',
        content: base64Image,
        mediaType: mediaType ?? 'image/png',
        filename: filename ?? `image-${id}.png`,
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(sourcePath !== undefined ? { sourcePath } : {}),
      }
      cacheImagePath(record)
      void storeImage(record).catch(passedOver)
      setPastedContents(prev => ({ ...prev, [id]: record }))
      const live = readLiveState()
      const clampedOffset = Math.max(0, Math.min(live.offset, live.value.length))
      const headBefore = live.value.slice(0, clampedOffset)
      const imageRef = formatImageRef(id)
      const spacedRef =
        hadDeferredSpace && headBefore.length > 0 && !/\s$/.test(headBefore)
          ? ` ${imageRef}`
          : imageRef
      insertAtomic(spacedRef)
      deferredSpaceArmedRef.current = true
      const bytes = byteLength ?? Math.floor((base64Image.length * 3) / 4)
      addNotification({
        key: `image-attached-${id}`,
        text: `${imageRef} attached — ${describeAttachedImage(dimensions, bytes)}`,
        priority: 'low',
        timeoutMs: 4000,
      })
    },
    [
      setMode,
      allocatePasteId,
      deferredSpaceArmedRef,
      setPastedContents,
      readLiveState,
      insertAtomic,
      addNotification,
    ],
  )

  const handleImageError = useCallback(
    (message: string) => {
      addNotification({
        key: 'image-attach-failed',
        text: message,
        color: 'warning',
        priority: 'high',
        timeoutMs: 10000,
      })
    },
    [addNotification],
  )

  const handleTextPaste = useCallback(
    (raw: string) => {
      deferredSpaceArmedRef.current = false
      const live = readLiveState()
      const stored = stripControls(normalizePastedLines(raw))
      const display = expandTabs(stored)
      const lineCount = getPastedTextRefNumLines(display)

      if (
        live.value === '' &&
        lineCount === 0 &&
        display.length <= PASTE_THRESHOLD &&
        getModeFromInput(display) === 'bash'
      ) {
        buffer.pushAtomic(live.value, live.offset, pendingInput.pastedContents())
        setMode('bash')
        const remainder = getValueFromInput(display)
        writeDraft(remainder)
        setCursorOffset(pendingInput.sanitizeComposerText(remainder).length)
        return
      }

      const maxLines = Math.min(2, Math.max(1, rows - 10))
      if (display.length > PASTE_THRESHOLD || lineCount > maxLines) {
        const id = allocatePasteId()
        const contentHash = hashPastedText(stored)
        const record: PastedContent = {
          id,
          type: 'text',
          content: stored,
          contentHash,
        }
        void storePastedText(contentHash, stored).catch(passedOver)
        setPastedContents(prev => ({ ...prev, [id]: record }))
        insertAtomic(formatPastedTextRef(id, lineCount))
        return
      }

      insertAtomic(display)
    },
    [
      deferredSpaceArmedRef,
      readLiveState,
      buffer,
      setMode,
      writeDraft,
      setCursorOffset,
      rows,
      allocatePasteId,
      setPastedContents,
      insertAtomic,
    ],
  )

  return {
    insertAtCursor,
    insertAtomic,
    handleImagePaste,
    handleImageError,
    handleTextPaste,
    cursorRef,
  }
}
