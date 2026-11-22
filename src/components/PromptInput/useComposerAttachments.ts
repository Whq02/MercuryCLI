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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ComposerAttachmentsInput = Unbuilt

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

export function useComposerAttachments(arg0: ComposerAttachmentsInput): ComposerAttachments {
  return notBuilt('src/components/PromptInput/useComposerAttachments.ts:66')
}
