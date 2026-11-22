import { useCallback, useRef, useState } from 'react'
import { useClaim } from './effects.js'
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
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const QUIET_FLUSH_MS = 100
const CLIPBOARD_DEBOUNCE_MS = 50

type ImagePasteHandler = (...args: Unbuilt[]) => Unbuilt

type ImageErrorHandler = (message: string) => void

const MACOS_SCREENSHOT_RE = /\/TemporaryItems\/.*screencaptureui/i

export function splitPasteCandidates(text: string): string[] {
  return notBuilt('src/hooks/usePasteHandler.ts:33')
}

export function usePasteHandler(arg0: {
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
  return notBuilt('src/hooks/usePasteHandler.ts:40')
}
