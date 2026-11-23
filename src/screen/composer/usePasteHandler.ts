import { useCallback, useRef, useState } from 'react'
import { useClaim } from '../effects/effects.js'
import { basename } from 'node:path'
import type { Key } from '../themedRenderer.js'
import type { ImageDimensions } from '../../platform/images/imageResizer.js'
import {
  PASTE_THRESHOLD,
  getImageFromClipboard,
  isImageFilePath,
  asImageFilePath,
  tryReadImageFromPath,
} from './imagePaste.js'
import { getPlatform } from '../../platform/environment/platform.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const QUIET_FLUSH_MS = 100
const CLIPBOARD_DEBOUNCE_MS = 50
const PASTE_CANDIDATE_SPLIT_RE = /\r\n|\r|\n| +(?=["']?(?:\/|[A-Za-z]:[\\/]|\\\\))/

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
    .split(PASTE_CANDIDATE_SPLIT_RE)
    .filter(part => part.trim().length > 0)
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
  const [pasteState, setPasteState] = useState<{
    chunks: string[]
    timeoutId: NodeJS.Timeout | null
  }>({ chunks: [], timeoutId: null })
  const [isPasting, setIsPasting] = useState(false)

  const chunksRef = useRef<string[]>([])
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null)
  const clipboardTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isPastingRef = useRef(false)
  const mountedRef = useRef(true)
  const callbacksRef = useRef({
    onPaste,
    onInput,
    onImagePaste,
    onImageError,
  })
  callbacksRef.current = { onPaste, onInput, onImagePaste, onImageError }

  const setPasting = useCallback((next: boolean) => {
    isPastingRef.current = next
    if (mountedRef.current) setIsPasting(next)
  }, [])

  const syncPasteState = useCallback(() => {
    if (!mountedRef.current) return
    setPasteState({
      chunks: [...chunksRef.current],
      timeoutId: flushTimerRef.current,
    })
  }, [])

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      stopTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  useClaim(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (flushTimerRef.current !== null) {
        stopTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      if (clipboardTimerRef.current !== null) {
        stopTimeout(clipboardTimerRef.current)
        clipboardTimerRef.current = null
      }
    }
  }, [])

  const requestClipboardImage = useCallback(() => {
    if (!callbacksRef.current.onImagePaste) return
    setPasting(true)
    if (clipboardTimerRef.current !== null) {
      stopTimeout(clipboardTimerRef.current)
      clipboardTimerRef.current = null
    }
    clipboardTimerRef.current = startTimeout(() => {
      clipboardTimerRef.current = null
      void getImageFromClipboard()
        .then(result => {
          if (!mountedRef.current) return
          if (result !== null) {
            callbacksRef.current.onImagePaste?.(
              result.base64,
              result.mediaType,
              undefined,
              result.dimensions,
              undefined,
              result.byteLength,
            )
          }
          setPasting(false)
        })
        .catch(error => {
          if (!mountedRef.current) return
          const message = error instanceof Error ? error.message : String(error)
          callbacksRef.current.onImageError?.(message)
          setPasting(false)
        })
    }, CLIPBOARD_DEBOUNCE_MS)
  }, [setPasting])

  const flushBuffer = useCallback(() => {
    clearFlushTimer()
    const joined = chunksRef.current.join('')
    chunksRef.current = []
    syncPasteState()

    if (joined.length === 0) {
      if (callbacksRef.current.onImagePaste) {
        requestClipboardImage()
        return
      }
      callbacksRef.current.onPaste?.(joined)
      setPasting(false)
      return
    }

    const candidates = splitPasteCandidates(joined)
    const hasImageCandidate =
      callbacksRef.current.onImagePaste !== undefined &&
      candidates.some(candidate => isImageFilePath(candidate))

    if (!hasImageCandidate) {
      callbacksRef.current.onPaste?.(joined)
      setPasting(false)
      return
    }

    setPasting(true)
    void (async () => {
      let handledImages = 0
      const remaining: string[] = []
      for (const candidate of candidates) {
        if (!mountedRef.current) return
        if (!isImageFilePath(candidate)) {
          remaining.push(candidate)
          continue
        }
        try {
          const image = await tryReadImageFromPath(candidate)
          if (!mountedRef.current) return
          if (image !== null) {
            handledImages += 1
            callbacksRef.current.onImagePaste?.(
              image.base64,
              image.mediaType,
              basename(image.path),
              image.dimensions,
              image.path,
              image.byteLength,
            )
          } else {
            remaining.push(candidate)
          }
        } catch (error) {
          if (!mountedRef.current) return
          handledImages += 1
          const message = error instanceof Error ? error.message : String(error)
          callbacksRef.current.onImageError?.(message)
        }
      }
      if (!mountedRef.current) return
      if (handledImages > 0) {
        const remainder = remaining.join('\n')
        if (remainder.length > 0) {
          callbacksRef.current.onPaste?.(remainder)
        }
        setPasting(false)
        return
      }
      const isMacTempScreenshot =
        getPlatform() === 'macos' &&
        candidates.some(candidate => {
          const cleaned = asImageFilePath(candidate)
          return cleaned !== null && MACOS_SCREENSHOT_RE.test(cleaned)
        })
      if (isMacTempScreenshot) {
        requestClipboardImage()
        return
      }
      callbacksRef.current.onPaste?.(joined)
      setPasting(false)
    })()
  }, [clearFlushTimer, syncPasteState, requestClipboardImage, setPasting])

  const wrappedOnInput = useCallback(
    (input: string, key: Key, _event?: unknown) => {
      const { onPaste: pasteCb, onImagePaste: imageCb, onInput: inputCb } =
        callbacksRef.current
      if (key.isPasted && input.length === 0 && imageCb !== undefined) {
        requestClipboardImage()
        return
      }
      const hasPasteCallback = pasteCb !== undefined || imageCb !== undefined
      const joinsBuffer =
        hasPasteCallback &&
        (key.isPasted ||
          input.length > PASTE_THRESHOLD ||
          flushTimerRef.current !== null ||
          splitPasteCandidates(input).some(candidate => isImageFilePath(candidate)))
      if (joinsBuffer) {
        chunksRef.current.push(input)
        setPasting(true)
        if (key.isPasted) {
          flushBuffer()
          return
        }
        clearFlushTimer()
        flushTimerRef.current = startTimeout(() => {
          flushTimerRef.current = null
          flushBuffer()
        }, QUIET_FLUSH_MS)
        syncPasteState()
        return
      }
      if (key.isPasted || input.length > 10) {
        clearFlushTimer()
        chunksRef.current = []
        syncPasteState()
        setPasting(false)
      }
      inputCb(input, key)
    },
    [clearFlushTimer, flushBuffer, requestClipboardImage, setPasting, syncPasteState],
  )

  const pendingNow = useCallback(
    () =>
      isPastingRef.current ||
      flushTimerRef.current !== null ||
      clipboardTimerRef.current !== null ||
      chunksRef.current.length > 0,
    [],
  )

  return {
    wrappedOnInput,
    pasteState,
    isPasting,
    pendingNow,
  }
}
