// ============================================================================
//  src/types/textInputTypes.ts — the text-input contract and the command
//  queue vocabulary shared by the composer, the queue and the REPL input
//  path.
// ============================================================================
import type * as React from 'react'
import type { UUID } from 'crypto'
import type { Key } from '../ink.js'
import type { AssistantMessage, MessageOrigin } from './message.js'
import type { ContentBlockParam } from './wire.js'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
// TRAP (deliberate): the orphaned-permission payload pairs the AGENT SDK's
// permission-result type, NOT this slice's own permissions vocabulary. The
// two overlap in name and differ in shape.
import type { PermissionResult as SdkPermissionResult } from '../entrypoints/agentSdkTypes.js'

/** Inline ghost text for mid-input command completion. */
export type InlineGhostText = {
  /** The dimmed completion text rendered at the insertion position. */
  text: string
  /** The full command name the ghost completes to. */
  fullCommand: string
  /** Character offset the ghost renders at. */
  insertPosition: number
}

/**
 * A controlled multi-line terminal text field's props.
 *
 * Two shielding flags carry rationales that must be preserved:
 * - `disableEscapeDoublePress`: needed when a keybinding context owns
 *   escape — a keybinding's propagation stop cannot shield the text input,
 *   because child effects register input listeners before parent effects.
 * - `disablePageKeyCursorMovement`: needed when the hosting surface owns
 *   page keys as a LIST pager, so the pager's viewport motion is the key's
 *   one meaning.
 */
export type BaseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  /** Escape, when the owner gives it a meaning of its own (a comment
   *  composer discards its draft); without it escape is the double-press
   *  clear. */
  onEscape?: () => void
  /** Shows/hides the exit chord message (the one owner's sentence lives in
   *  ExitChordNotice — never spelled here). */
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  /** History navigation, invoked at the input's boundary lines. */
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  placeholder?: string
  /** Overrides the plain placeholder text when present. */
  placeholderElement?: React.ReactNode
  /** Defaults to true; continuation via a trailing backslash. */
  multiline?: boolean
  /** Routes input among several inputs. */
  focus?: boolean
  mask?: string
  showCursor?: boolean
  highlightPastedText?: boolean
  /** Column count used for wrapping. */
  columns: number
  /** Max visible lines; beyond it only lines around the cursor render. */
  maxVisibleLines?: number
  /**
   * Image paste: base64 payload first, then media type, filename, decoded
   * dimensions and the source path.
   */
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  /** Large text paste (the 800-character threshold lives in the input hook). */
  onPaste?: (text: string) => void
  onIsPastingChange?: (isPasting: boolean) => void
  /** Disables cursor movement for the vertical arrow keys. */
  disableCursorMovementForUpDownKeys?: boolean
  /** Argument hint rendered after command input. */
  argumentHint?: string
  onUndo?: () => void
  dimColor?: boolean
  cursorOffset: number
  onChangeCursorOffset: (offset: number) => void
  highlights?: TextHighlight[]
  inlineGhostText?: InlineGhostText
  /**
   * Raw-input filter applied before key routing: returns the possibly
   * transformed string; returning '' for a non-empty input drops the event.
   */
  inputFilter?: (input: string, key: Key) => string
  disableEscapeDoublePress?: boolean
  disablePageKeyCursorMovement?: boolean
  /** Enter submits nothing at the raw text layer — a later listener (the
   *  completion menu's accept) owns the submit while it is open. */
  suppressEnterSubmit?: boolean
  /**
   * Foreground colour of typed text, so the composer and the transcript
   * render the user's words identically; undefined = terminal default.
   */
  userTextColor?: string
}

/** Upper-case by contract — a lower-case union will not assign. */
export type VimMode = 'INSERT' | 'NORMAL'

export type VimTextInputProps = BaseTextInputProps & {
  initialMode?: VimMode
  onModeChange?: (mode: VimMode) => void
}

/** The core state every input hook exposes. */
export type BaseInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  /** Cursor line within the viewport, wrapping-aware. */
  cursorLine: number
  /** Display-width cursor column, wrapping-aware. */
  cursorColumn: number
  /** Character offset where the viewport starts (0 when not windowed). */
  viewportCharOffset: number
  /** Character offset where the viewport ends (text length when not windowed). */
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

/** The editable subset: the notification modes drop by name pattern
 *  (orphaned-permission IS editable — the user answers in it). */
export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>

/**
 * Queue priorities (contract data; identical semantics in normal and
 * proactive modes):
 * - `now`   — interrupt and send immediately, aborting any in-flight tool
 *   call (escape-then-send); consumers subscribe to queue changes and
 *   abort when they observe one.
 * - `next`  — mid-turn drain: the current tool call finishes, then the
 *   message goes between the tool result and the next model round trip;
 *   wakes an in-progress sleep call.
 * - `later` — end-of-turn drain: wait for the turn to finish, then process
 *   as a new query; also wakes a sleep call (the turn loop raises the
 *   drain threshold after a sleep so the message attaches to the same
 *   turn).
 * The sleep tool exists only in proactive mode, so the wake clauses are
 * inert elsewhere.
 */
export type QueuePriority = 'now' | 'next' | 'later'

/** A permission result orphaned from its dialog, with the assistant
 *  message that raised it. */
export type OrphanedPermission = {
  permissionResult: SdkPermissionResult
  assistantMessage: AssistantMessage
}

/**
 * One queued command. Queue records are IMMUTABLE once minted: re-staging
 * replaces the record with a new one carrying the same `queueId`, so
 * identity-keyed consumers follow the id while already-held React
 * snapshots stay retroactively unchanged (the external-store subscription
 * contract requires this).
 */
export type QueuedCommand = {
  value: string | ContentBlockParam[]
  mode: PromptInputMode
  /** Defaults to the priority the mode implies. */
  priority?: QueuePriority
  /**
   * Minted by the queue at enqueue; absent on a caller's original object.
   */
  queueId?: string
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  /** Raw pasted contents including images, resized at execution time. */
  pastedContents?: Record<number, PastedContent>
  /**
   * The input before pasted-text placeholders were expanded, for keyword
   * detection (pasted content containing a keyword must not trigger the
   * behaviour). Falls back to `value` when unset — bridge, socket and MCP
   * sources have no paste expansion.
   */
  preExpansionValue?: string
  /**
   * Treat the input as plain text even when it begins with a slash — for
   * remotely received messages that must not trigger local commands.
   */
  skipSlashCommands?: boolean
  /**
   * Bridge-origin: slash commands dispatch but are filtered through the
   * bridge-safety predicate, so interactive-surface and terminal-only
   * commands return a helpful error instead of executing (this is what
   * stops a remote client popping a local picker).
   */
  bridgeOrigin?: boolean
  /**
   * The resulting user message is model-visible but transcript-hidden;
   * used by system-generated prompts routed through the queue.
   */
  isMeta?: boolean
  /** Provenance, stamped structurally; undefined = a human at the keyboard. */
  origin?: MessageOrigin
  /**
   * Billing-attribution workload tag. Rides the queued command because the
   * queue is the asynchronous boundary between a scheduler firing and the
   * turn running — a user prompt can arrive in between — and is hoisted
   * into bootstrap state only when THIS command is dequeued.
   */
  workload?: string
  /**
   * Which agent receives the notification; undefined = the main thread.
   * Subagents share the module-level queue, so the drain gate filters on
   * this — without it a subagent's background notifications leak into the
   * coordinator's context.
   */
  agentId?: string
}

/**
 * A valid image paste: the entry is an image AND its content is non-empty.
 * Empty-content images (a zero-byte drag) produce empty base64 the
 * provider API rejects; every conversion site must use this predicate so
 * the filter and the id list stay in step.
 */
export function isValidImagePaste(content: PastedContent): boolean {
  return content.type === 'image' && content.content.length > 0
}

/** Ids of valid image pastes, or nothing when the map is absent or empty. */
export function getImagePasteIds(
  pastedContents?: Record<number, PastedContent>,
): number[] | undefined {
  if (!pastedContents) return undefined
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map(content => content.id)
  return ids.length > 0 ? ids : undefined
}
