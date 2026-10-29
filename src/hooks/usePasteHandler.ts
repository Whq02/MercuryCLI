
import { useCallback, useEffect, useRef, useState } from 'react'
import { basename } from 'node:path'
import type { Key } from '../ink.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import {
  PASTE_THRESHOLD,
  getImageFromClipboard,
  isImageFilePath,
  asImageFilePath,
  tryReadImageFromPath,
} from '../utils/imagePaste.js'
import { getPlatform } from '../utils/platform.js'

const QUIET_FLUSH_MS = 100
const CLIPBOARD_DEBOUNCE_MS = 50

type ImagePasteHandler = (
  base64Image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
  byteLength?: number,
) => void

type ImageErrorHandler = (message: string) => void

const MACOS_SCREENSHOT_RE = /\/TemporaryItems\/.*screencaptureui/i

export function splitPasteCandidates(text: string): string[] {
  return text
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap(part => part.split(/\r\n|\r|\n/))
    .filter(part => part.trim() !== '')
}

export function usePasteHandler({
  onPaste,
  onInput,
  onImagePaste,
  onImageError,
}: {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: ImagePasteHandler
  onImageError?: ImageErrorHandler
}): {
  wrappedOnInput: (input: string, key: Key, event?: unknown) => void
  pasteState: { chunks: string[]; timeoutId: NodeJS.Timeout | null }
  isPasting: boolean
  pendingNow: () => boolean
} {
  const chunksRef = useRef<string[]>([])
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const [isPasting, setIsPastingState] = useState(false)
  const pastingRef = useRef(false)
  const setIsPasting = (value: boolean): void => {
    pastingRef.current = value
    setIsPastingState(value)
  }
  const pendingNow = useCallback(() => pastingRef.current || timerRef.current !== null || clipboardTimerRef.current !== null, [])
  const mountedRef = useRef(true)
  const clipboardTimerRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(
    () => () => {
      mountedRef.current = false
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (clipboardTimerRef.current !== null) clearTimeout(clipboardTimerRef.current)
    },
    [],
  )

  const onPasteRef = useRef(onPaste)
  onPasteRef.current = onPaste
  const onImagePasteRef = useRef(onImagePaste)
  onImagePasteRef.current = onImagePaste
  const onImageErrorRef = useRef(onImageError)
  onImageErrorRef.current = onImageError

  const checkClipboardImage = useCallback((): void => {
    if (clipboardTimerRef.current !== null) clearTimeout(clipboardTimerRef.current)
    clipboardTimerRef.current = setTimeout(() => {
      clipboardTimerRef.current = null
      void getImageFromClipboard()
        .then(image => {
          if (!mountedRef.current) return
          if (image !== null) {
            onImagePasteRef.current?.(
              image.base64,
              image.mediaType,
              undefined,
              image.dimensions,
              undefined,
              image.byteLength,
            )
          }
        })
        .catch(error => {
          if (mountedRef.current) onImageErrorRef.current?.(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (mountedRef.current) setIsPasting(false)
        })
    }, CLIPBOARD_DEBOUNCE_MS)
  }, [])

  const flush = useCallback((): void => {
    timerRef.current = null
    const joined = chunksRef.current.join('')
    chunksRef.current = []

    const candidates = splitPasteCandidates(joined)
    const imagePaths = candidates.filter(candidate =>
      isImageFilePath(candidate.trim()),
    )

    if (imagePaths.length > 0 && onImagePasteRef.current) {
      void (async () => {
        let anyRead = false
        const nonImageLines: string[] = []
        for (const candidate of candidates) {
          const trimmed = candidate.trim()
          if (asImageFilePath(trimmed) !== null) {
            try {
              const image = await tryReadImageFromPath(trimmed)
              if (image !== null) {
                anyRead = true
                if (mountedRef.current) {
                  onImagePasteRef.current?.(
                    image.base64,
                    image.mediaType,
                    basename(image.path),
                    image.dimensions,
                    image.path,
                    image.byteLength,
                  )
                }
                continue
              }
            } catch (error) {
              anyRead = true
              if (mountedRef.current) onImageErrorRef.current?.(error instanceof Error ? error.message : String(error))
              continue
            }
          }
          nonImageLines.push(candidate)
        }
        if (!mountedRef.current) return
        if (anyRead) {
          if (nonImageLines.length > 0) {
            onPasteRef.current?.(nonImageLines.join('\n'))
          }
          setIsPasting(false)
          return
        }
        if (getPlatform() === 'macos' && MACOS_SCREENSHOT_RE.test(joined)) {
          checkClipboardImage()
          return
        }
        onPasteRef.current?.(joined)
        setIsPasting(false)
      })()
      return
    }

    if (joined === '' && onImagePasteRef.current) {
      checkClipboardImage()
      return
    }

    onPasteRef.current?.(joined)
    setIsPasting(false)
  }, [checkClipboardImage])

  const wrappedOnInput = useCallback(
    (input: string, key: Key, _event?: unknown): void => {
      const flagged = key.isPasted === true
      if (flagged && input.length === 0 && onImagePasteRef.current) {
        setIsPasting(true)
        checkClipboardImage()
        return
      }

      const looksLikeImagePath = splitPasteCandidates(input).some(candidate =>
        isImageFilePath(candidate.trim()),
      )
      const treatAsPaste =
        (onPasteRef.current !== undefined || onImagePasteRef.current !== undefined) &&
        (input.length > PASTE_THRESHOLD ||
          timerRef.current !== null ||
          looksLikeImagePath ||
          flagged)

      if (treatAsPaste) {
        if (flagged) setIsPasting(true)
        chunksRef.current.push(input)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(flush, QUIET_FLUSH_MS)
        return
      }

      if (flagged || input.length > 10) setIsPasting(false)
      onInput(input, key)
    },
    [onInput, flush, checkClipboardImage],
  )

  return {
    wrappedOnInput,
    pasteState: { chunks: chunksRef.current, timeoutId: timerRef.current },
    isPasting,
    pendingNow,
  }
}
