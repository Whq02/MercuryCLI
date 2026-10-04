import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import * as pendingInput from '../../input-core/pending-input.js'
import type { Notification } from '../../context/notifications.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { PastedContent } from '../../utils/config.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { normalizePastedInput } from '../../input-core/composer-document.js'
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { setComposerInsert } from './composerInsert.js'
import { formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parseReferences } from '../../history.js'
import { PASTE_THRESHOLD } from '../../utils/imagePaste.js'
import { describeAttachedImage } from '../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../utils/imageStore.js'
import { hashPastedText, storePastedText } from '../../utils/pasteStore.js'
import { expandTabs, stripControls } from './composerText.js'

export type ComposerAttachmentsInput = {
  input: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  buffer: ReturnType<typeof useInputBuffer>
  messages: Message[]
  rows: number
  inputSelectionRangeRef: React.MutableRefObject<() => { start: number; end: number } | null>
  writeDraft: (text: string) => void
  setCursorOffset: (offset: number) => void
  setMode: (next: PromptInputMode) => void
  setPastedContents: (
    next:
      | Record<number, PastedContent>
      | ((prev: Record<number, PastedContent>) => Record<number, PastedContent>),
  ) => void
  addNotification: (notification: Notification) => void
  deferredSpaceArmedRef: React.MutableRefObject<boolean>
  insertTextRef: React.MutableRefObject<{
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

export function useComposerAttachments({
  input,
  cursorOffset,
  pastedContents,
  buffer,
  messages,
  rows,
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
    onInputChange: (value: string) => {
      writeDraft(value)
    },
    setCursorOffset,
    setPastedContents,
  })

  const nextPasteIdRef = useRef<number | null>(null)
  if (nextPasteIdRef.current === null) {
    let max = 0
    for (const message of messages) {
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') {
        for (const ref of parseReferences(content)) max = Math.max(max, ref.id)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const text = (block as { text?: string }).text
          if (typeof text === 'string') {
            for (const ref of parseReferences(text)) max = Math.max(max, ref.id)
          }
        }
      }
      const ids = (message as { imagePasteIds?: number[] }).imagePasteIds
      if (Array.isArray(ids)) for (const id of ids) max = Math.max(max, id)
    }
    nextPasteIdRef.current = max + 1
  }
  const allocatePasteId = (): number => {
    const taken = new Set<number>(
      Object.keys(pendingInput.pastedContents()).map(Number),
    )
    for (const ref of parseReferences(pendingInput.text())) taken.add(ref.id)
    let id = nextPasteIdRef.current ?? 1
    while (taken.has(id)) id++
    nextPasteIdRef.current = id + 1
    return id
  }

  const insertAtCursor = (text: string, options?: { atomic?: boolean }): void => {
    if (!options?.atomic) buffer.pushToBuffer(input, cursorOffset, pastedContents);
    else buffer.pushAtomic(input, cursorOffset, pastedContents);
    const range = inputSelectionRangeRef.current();
    const start = range ? range.start : Math.max(0, Math.min(cursorOffset, input.length))
    const end = range ? range.end : start
    let payload = text
    if (
      !range &&
      start === input.length &&
      input !== '' &&
      !/\s$/.test(input) &&
      payload !== ''
    ) {
      payload = ` ${payload}`
    }
    const next = input.slice(0, start) + payload + input.slice(end)
    writeDraft(next)
    setCursorOffset(start + payload.length)
  }
  const insertAtomic = (text: string): void => {
    insertAtCursor(text, { atomic: true })
  }

  const handleImagePaste = useCallback(
    (
      base64Image: string,
      mediaType?: string,
      filename?: string,
      dimensions?: ImageDimensions,
      sourcePath?: string,
      byteLength?: number,
    ): void => {
      setMode('prompt')
      const pendingSpace = deferredSpaceArmedRef.current
      const id = allocatePasteId()
      const entry: PastedContent = {
        id,
        type: 'image',
        content: base64Image,
        mediaType: mediaType ?? 'image/png',
        filename: filename ?? `image-${id}.png`,
        ...(dimensions ? { dimensions } : {}),
        ...(sourcePath ? { sourcePath } : {}),
      } as PastedContent
      cacheImagePath(entry)
      void storeImage(entry).catch(() => {})
      setPastedContents(prev => ({ ...prev, [id]: entry }))
      insertAtCursor(`${pendingSpace ? ' ' : ''}${formatImageRef(id)}`, { atomic: true })
      deferredSpaceArmedRef.current = true
      const bytes = byteLength ?? Math.floor((base64Image.length * 3) / 4)
      addNotification({
        key: `image-attached-${id}`,
        text: `${formatImageRef(id)} attached — ${describeAttachedImage(dimensions, bytes)}`,
        priority: 'low',
        timeoutMs: 4000,
      })
    },
    [insertAtCursor, setMode, setPastedContents, addNotification],
  )

  const handleImageError = useCallback(
    (message: string): void => {
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
    (raw: string): void => {
      deferredSpaceArmedRef.current = false
      const text = stripControls(normalizePastedInput(raw))
      const lineCount = (text.match(/\n/g) ?? []).length + 1
      if (
        input === '' &&
        lineCount === 1 &&
        text.length <= PASTE_THRESHOLD &&
        getModeFromInput(text) === 'bash'
      ) {
        setMode('bash')
        const remainder = expandTabs(getValueFromInput(text))
        buffer.pushAtomic(input, cursorOffset, pastedContents)
        writeDraft(remainder)
        setCursorOffset(remainder.length)
        return
      }
      const lineCap = Math.max(1, Math.min(rows - 10, 2))
      if (text.length > PASTE_THRESHOLD || lineCount > lineCap) {
        const id = allocatePasteId()
        const numLines = getPastedTextRefNumLines(text)
        const contentHash = hashPastedText(text)
        const entry: PastedContent = {
          id,
          type: 'text',
          content: text,
          contentHash,
        } as PastedContent
        void storePastedText(contentHash, text).catch(() => {})
        setPastedContents(prev => ({ ...prev, [id]: entry }))
        insertAtCursor(formatPastedTextRef(id, numLines), { atomic: true })
        return
      }
      insertAtCursor(expandTabs(text), { atomic: true })
    },
    [input, rows, cursorOffset, pastedContents, buffer, insertAtCursor, setMode, setCursorOffset, setPastedContents],
  )

  const cursorRef = useRef(cursorOffset)
  cursorRef.current = cursorOffset
  insertTextRef.current = {
    get cursorOffset() {
      return cursorRef.current
    },
    insert: insertAtomic,
    setInputWithCursor: (value: string, cursor: number) => {
      writeDraft(value)
      setCursorOffset(Math.max(0, Math.min(cursor, value.length)))
    },
  }
  setComposerInsert(insertAtomic)
  useEffect(() => {
    return () => {
      insertTextRef.current = null
      setComposerInsert(null)
      void pendingInput.flushDrafts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only flush
  }, [])


  return { insertAtCursor, insertAtomic, handleImagePaste, handleImageError, handleTextPaste, cursorRef }
}
