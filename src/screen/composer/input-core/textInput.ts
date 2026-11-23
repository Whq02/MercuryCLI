import type { MutableRefObject, ReactNode } from 'react'
import type { UUID } from 'crypto'
import type { Key } from '../../themedRenderer.js'
import type { InputEvent } from '../../renderer/events/input-event.js'
import type { MessageOrigin } from '../../../engine/message-shapes/message.js'
import type { ContentBlockParam } from '../../../engine/message-shapes/wire.js'
import type { PastedContent } from '../../../platform/settings/config.js'
import type { ImageDimensions } from '../../../platform/images/imageResizer.js'
import type { TextHighlight } from '../textHighlighting.js'

export type InlineGhostText = {
  text: string
  fullCommand: string
  insertPosition: number
}

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

type ControlledValue = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  cursorOffset: number
  onChangeCursorOffset: (offset: number) => void
}

type InputRouting = {
  routeInput?: (input: string, key: Key, event: InputEvent, pastePending: boolean) => RouteVerdict
  pastePendingRef?: MutableRefObject<(() => boolean) | null>
  inputFilter?: (input: string, key: Key) => string
  onExitMessage?: (show: boolean, key?: string) => void
}

type PasteHandlers = {
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
    byteLength?: number,
  ) => void
  onImageError?: (errorMessage: string) => void
  onPaste?: (text: string) => void
  onIsPastingChange?: (isPasting: boolean) => void
}

type Appearance = {
  columns: number
  placeholder?: string
  placeholderElement?: ReactNode
  mask?: string
  maxVisibleLines?: number
  argumentHint?: string
  highlights?: TextHighlight[]
  inlineGhostText?: InlineGhostText
  userTextColor?: string
}

export type BaseTextInputProps = ControlledValue &
  Partial<Record<SignalName, Signal>> &
  Partial<Record<SwitchName, boolean>> &
  InputRouting &
  PasteHandlers &
  Appearance

export type VimMode = 'INSERT' | 'NORMAL'

export type TextInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  isPasting?: boolean
} & Record<'cursorLine' | 'cursorColumn' | 'viewportCharOffset' | 'viewportCharEnd', number>

export type VimInputState = TextInputState & {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

export type InputMode =
  | 'bash'
  | 'prompt'
  | 'task-notification'

export type QueuePriority = 'now' | 'next' | 'later'

type QueuedPayload = {
  value: string | Array<ContentBlockParam>
  mode: InputMode
  schema?: Record<string, unknown>
  pastedContents?: Record<number, PastedContent>
  preExpansionValue?: string
  agentCompletion?: { agentId: string; start: number; end: number }
}

type QueuedIdentity = Partial<{
  queueId: string
  uuid: UUID
}>

type QueuedRouting = Partial<{
  priority: QueuePriority
  agentId: string
  waitsForTurnEnd: true
  localCommand: true
  ridesNextWords: true
}>

type QueuedSource = Partial<{
  origin: MessageOrigin
  sentAt: string
  workload: string
  skipSlashCommands: boolean
  bridgeOrigin: boolean
  isMeta: boolean
}>

export type QueuedCommand = QueuedPayload & QueuedIdentity & QueuedRouting & QueuedSource

export type BatchedPrompt = Pick<QueuedCommand, 'value' | 'uuid' | 'origin'>

export function isValidImagePaste(content: PastedContent): boolean {
  return content.type === 'image' && content.content.length > 0
}

export function getImagePasteIds(pastedContents?: Record<number, PastedContent>): number[] | undefined {
  const ids = Object.values(pastedContents ?? {}).filter(isValidImagePaste).map(content => content.id)
  return ids.length > 0 ? ids : undefined
}
