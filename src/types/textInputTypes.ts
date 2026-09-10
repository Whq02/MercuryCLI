import type * as React from 'react'
import type { UUID } from 'crypto'
import type { Key } from '../ink.js'
import type { InputEvent } from '../ink/events/input-event.js'
import type { AssistantMessage, MessageOrigin } from './message.js'
import type { ContentBlockParam } from './wire.js'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import type { PermissionResult as SdkPermissionResult } from '../entrypoints/agentSdkTypes.js'

export type InlineGhostText = {
  text: string
  fullCommand: string
  insertPosition: number
}

export type BaseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onEscape?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  placeholder?: string
  placeholderElement?: React.ReactNode
  multiline?: boolean
  focus?: boolean
  routeInput?: (input: string, key: Key, event: InputEvent, pastePending: boolean) => 'edit' | 'edit-and-consume' | 'consume' | 'yield'
  pastePendingRef?: React.MutableRefObject<(() => boolean) | null>
  mask?: string
  showCursor?: boolean
  highlightPastedText?: boolean
  columns: number
  maxVisibleLines?: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
    byteLength?: number,
  ) => void
  onImageError?: (message: string) => void
  onPaste?: (text: string) => void
  onIsPastingChange?: (isPasting: boolean) => void
  disableCursorMovementForUpDownKeys?: boolean
  argumentHint?: string
  onUndo?: () => void
  dimColor?: boolean
  cursorOffset: number
  onChangeCursorOffset: (offset: number) => void
  highlights?: TextHighlight[]
  inlineGhostText?: InlineGhostText
  inputFilter?: (input: string, key: Key) => string
  disableEscapeDoublePress?: boolean
  disablePageKeyCursorMovement?: boolean
  suppressEnterSubmit?: boolean
  userTextColor?: string
}

export type VimMode = 'INSERT' | 'NORMAL'

export type VimTextInputProps = BaseTextInputProps & {
  initialMode?: VimMode
  onModeChange?: (mode: VimMode) => void
}

export type BaseInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  cursorLine: number
  cursorColumn: number
  viewportCharOffset: number
  viewportCharEnd: number
}

export type TextInputState = BaseInputState & {
  isPasting?: boolean
}

export type VimInputState = TextInputState & {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'orphaned-permission'
  | 'task-notification'

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>

export type QueuePriority = 'now' | 'next' | 'later'

export type OrphanedPermission = {
  permissionResult: SdkPermissionResult
  assistantMessage: AssistantMessage
}

export type QueuedCommand = {
  value: string | ContentBlockParam[]
  mode: PromptInputMode
  priority?: QueuePriority
  queueId?: string
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  pastedContents?: Record<number, PastedContent>
  preExpansionValue?: string
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
  isMeta?: boolean
  origin?: MessageOrigin
  workload?: string
  agentId?: string
}

export function isValidImagePaste(content: PastedContent): boolean {
  return content.type === 'image' && content.content.length > 0
}

export function getImagePasteIds(
  pastedContents?: Record<number, PastedContent>,
): number[] | undefined {
  if (!pastedContents) return undefined
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map(content => content.id)
  return ids.length > 0 ? ids : undefined
}
