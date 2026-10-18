import type { MutableRefObject, ReactNode } from 'react'
import type { UUID } from 'crypto'
import type { Key } from '../ink.js'
import type { InputEvent } from '../ink/events/input-event.js'
import type { MessageOrigin } from './message.js'
import type { ContentBlockParam } from './wire.js'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'

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

type ImagePasteHandler = (
  base64Image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
  byteLength?: number,
) => void

type ValueProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  cursorOffset: number
  onChangeCursorOffset: (offset: number) => void
}

type RoutingProps = {
  routeInput?: (input: string, key: Key, event: InputEvent, pastePending: boolean) => RouteVerdict
  pastePendingRef?: MutableRefObject<(() => boolean) | null>
  inputFilter?: (input: string, key: Key) => string
  onExitMessage?: (show: boolean, key?: string) => void
}

type PasteProps = {
  onImagePaste?: ImagePasteHandler
  onImageError?: (message: string) => void
  onPaste?: (text: string) => void
  onIsPastingChange?: (isPasting: boolean) => void
}

type AppearanceProps = {
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

export type BaseTextInputProps = ValueProps &
  { [Name in SignalName]?: Signal } &
  { [Name in SwitchName]?: boolean } &
  RoutingProps &
  PasteProps &
  AppearanceProps

export type VimMode = 'INSERT' | 'NORMAL'

type Placement = 'cursorLine' | 'cursorColumn' | 'viewportCharOffset' | 'viewportCharEnd'

export type TextInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  isPasting?: boolean
} & { [Measure in Placement]: number }

export type VimInputState = TextInputState & {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'task-notification'

export type EditablePromptInputMode = Exclude<PromptInputMode, 'task-notification'>

export type QueuePriority = 'now' | 'next' | 'later'

type QueuePayload = {
  value: string | ContentBlockParam[]
  mode: PromptInputMode
  pastedContents?: Record<number, PastedContent>
  preExpansionValue?: string
  agentCompletion?: { agentId: string; start: number; end: number }
}

type QueueIdentity = {
  queueId?: string
  uuid?: UUID
}

type QueueRouting = {
  priority?: QueuePriority
  agentId?: string
  waitsForTurnEnd?: true
  ridesNextWords?: true
}

type QueueSource = {
  origin?: MessageOrigin
  sentAt?: string
  workload?: string
} & { [Flag in 'skipSlashCommands' | 'bridgeOrigin' | 'isMeta']?: boolean }

export type QueuedCommand = QueuePayload & QueueIdentity & QueueRouting & QueueSource

export type BatchedPrompt = Pick<QueuedCommand, 'value' | 'uuid' | 'origin'>

export function isValidImagePaste(content: PastedContent): boolean {
  return content.type === 'image' && content.content.length > 0
}

const imagePastesOf = (pasted: Record<number, PastedContent>): PastedContent[] =>
  Object.values(pasted).filter(isValidImagePaste)

export function getImagePasteIds(pastedContents?: Record<number, PastedContent>): number[] | undefined {
  if (!pastedContents) return undefined
  const ids = imagePastesOf(pastedContents).map(paste => paste.id)
  return ids.length ? ids : undefined
}
