import type { MutableRefObject, ReactNode } from 'react'
import type { UUID } from 'crypto'
import type { Key } from '../ink.js'
import type { InputEvent } from '../ink/events/input-event.js'
import type { MessageOrigin } from './message.js'
import type { ContentBlockParam } from './wire.js'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type InlineGhostText = Unbuilt

type Signal = () => void

type SignalName =
  | 'onExit'
  | 'onEscape'
  | 'onHistoryReset'
  | 'onClearInput'
  | 'onHistoryUp'
  | 'onHistoryDown'
  | 'onUndo'

type SwitchName =
  | 'multiline'
  | 'focus'
  | 'showCursor'
  | 'highlightPastedText'
  | 'disableCursorMovementForUpDownKeys'
  | 'disableEscapeDoublePress'
  | 'disablePageKeyCursorMovement'
  | 'suppressEnterSubmit'
  | 'dimColor'

type RouteVerdict = 'edit' | 'edit-and-consume' | 'consume' | 'yield'

export type BaseTextInputProps = Unbuilt

export type VimMode = Unbuilt

export type TextInputState = Unbuilt

export type VimInputState = Unbuilt

export type PromptInputMode = Unbuilt

export type QueuePriority = Unbuilt

export type QueuedCommand = Unbuilt

export type BatchedPrompt = Unbuilt

export function isValidImagePaste(content: PastedContent): boolean {
  return notBuilt('src/types/textInputTypes.ts:147')
}

export function getImagePasteIds(pastedContents?: Record<number, PastedContent>): number[] | undefined {
  return notBuilt('src/types/textInputTypes.ts:154')
}
