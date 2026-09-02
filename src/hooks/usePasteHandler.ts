// Paste coalescing and routing. Paste is recognised from the
// decoder's pasted flag — never a competing raw-stream listener. Chunks
// accumulate and flush after 100 ms of quiet; a SYNCHRONOUS pending flag
// mirrors the timer handle, because one terminal read can carry a paste
// plus the following keystroke in a single batch — the state-held handle
// still reads empty on the second call, the input routes as an ordinary
// keystroke, and where that keystroke is Enter the composer submits the
// pre-paste draft and the pasted text is absent. Chunk joining is VERBATIM:
// the scanner already stripped every real protocol token upstream.

import { useCallback, useEffect, useRef, useState } from 'react'
import { basename } from 'node:path'
import type { Key } from '../ink.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import {
  PASTE_THRESHOLD,
  getImageFromClipboard,
  isImageFilePath,
  asImageFilePath,
} from '../utils/imagePaste.js'
import { readFileSync } from 'node:fs'
import { detectImageFormatFromBuffer } from '../utils/imageResizer.js'
import { getPlatform } from '../utils/platform.js'
import { logForDebugging } from '../utils/debug.js'

const QUIET_FLUSH_MS = 100
const CLIPBOARD_DEBOUNCE_MS = 50

type ImagePasteHandler = (
  base64Image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
) => void

/** The macOS screen-capture temporary path shape. */
const MACOS_SCREENSHOT_RE = /\/TemporaryItems\/.*screencaptureui/i

/** Split on spaces that immediately precede an absolute path, then on
 *  line breaks, discarding blanks — spaces inside real paths arrive
 *  escaped. A Windows console paste delivers CR-delimited lines (no LF
 *  ever reaches this seam), so the break class covers CRLF, LF and lone
 *  CR — an LF-only split glued two dragged paths into one candidate that
 *  no longer ended in an image extension (TASK-017 supplement, SURVIVED). */
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
}: {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: ImagePasteHandler
}): {
  wrappedOnInput: (input: string, key: Key, event?: unknown) => void
  pasteState: { chunks: string[]; timeoutId: NodeJS.Timeout | null }
  isPasting: boolean
} {
  const chunksRef = useRef<string[]>([])
  // The synchronously updated pending flag mirroring the timer handle.
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const [isPasting, setIsPasting] = useState(false)
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
            )
          }
        })
        .catch(error => {
          if (mountedRef.current) logForDebugging(`clipboard image check failed: ${error}`)
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
      let anyRead = false
      const nonImageLines: string[] = []
      for (const candidate of candidates) {
        const trimmed = candidate.trim()
        const asImage = asImageFilePath(trimmed)
        if (asImage !== null) {
          try {
            const buffer = readFileSync(asImage)
            // DetectedFormat IS the media-type string.
            const detected = detectImageFormatFromBuffer(buffer)
            anyRead = true
            onImagePasteRef.current(
              buffer.toString('base64'),
              detected,
              basename(asImage),
              undefined,
              asImage,
            )
            continue
          } catch {
            /* fall through to the non-image handling below */
          }
        }
        nonImageLines.push(candidate)
      }
      if (anyRead) {
        if (nonImageLines.length > 0) {
          onPasteRef.current?.(nonImageLines.join('\n'))
        }
        setIsPasting(false)
        return
      }
      // None readable: the screenshot-shape case checks the clipboard.
      if (getPlatform() === 'macos' && MACOS_SCREENSHOT_RE.test(joined)) {
        checkClipboardImage()
        return
      }
      onPasteRef.current?.(joined)
      setIsPasting(false)
      return
    }

    if (
      joined === '' &&
      getPlatform() === 'macos' &&
      onImagePasteRef.current
    ) {
      // The residual empty-paste path (the entry-time check normally fires).
      checkClipboardImage()
      return
    }

    onPasteRef.current?.(joined)
    setIsPasting(false)
  }, [checkClipboardImage])

  const wrappedOnInput = useCallback(
    // The third parameter is the ink InputEvent; the paste path never
    // claims it — propagation control stays with the caller.
    (input: string, key: Key, _event?: unknown): void => {
      const flagged = key.isPasted === true
      // Entry-time empty flagged paste on macOS: check the clipboard at
      // once, clear the flag, and leave the chunk buffer untouched.
      if (flagged && input.length === 0 && getPlatform() === 'macos' && onImagePasteRef.current) {
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

      // Non-paste path: a decoder-flagged or long input clears the latch —
      // a short flagged paste with no handler must not swallow every Enter.
      if (flagged || input.length > 10) setIsPasting(false)
      onInput(input, key)
    },
    [onInput, flush, checkClipboardImage],
  )

  return {
    wrappedOnInput,
    pasteState: { chunks: chunksRef.current, timeoutId: timerRef.current },
    isPasting,
  }
}
