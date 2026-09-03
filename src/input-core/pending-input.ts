import type { PastedContent } from '../utils/config.js'
import type {
  EditablePromptInputMode,
  PromptInputMode,
} from '../types/textInputTypes.js'
import { getSessionId, onSessionSwitch, updateLastInteractionTime } from '../bootstrap/state.js'
import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { activityManager } from '../utils/activityManager.js'
import {
  cancelPendingDraftSave,
  deleteDraft,
  flushDraftSaves,
  readDraftSync,
  saveDraftDebounced,
  migrateOrphanedDraft,
} from '../utils/promptDraft.js'
import { createSignal } from '../utils/signal.js'
import { noteCompanionTyping } from '../utils/cockpit/companionEngine.js'
import { markTypingActivity } from '../utils/cockpit/typingActivity.js'

export type ComposerDraft = {
  text: string
  cursorOffset: number
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
}

export type StashedPrompt = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
}

export type EditInterceptors = {
  interceptSuggestion?: (prev: string, next: string) => boolean
  onEmptyToNonempty?: () => void
  onActiveChange?: (active: boolean) => void
}

const PROMPT_SUPPRESSION_MS = 1500


let draft: ComposerDraft = {
  text: '',
  cursorOffset: 0,
  mode: 'prompt',
  pastedContents: {},
}
let stash: StashedPrompt | undefined
let interceptors: EditInterceptors = {}
let initialized = false
let owningSessionId: string | null = null
let suppressionTimer: ReturnType<typeof setTimeout> | null = null
let editSeq = 0

const changed = createSignal()

function commit(): void {
  changed.emit()
}


function persistDraft(): void {
  saveDraftDebounced(owningSessionId ?? getSessionId(), {
    text: draft.text,
    cursorOffset: draft.cursorOffset,
    mode: draft.mode,
    pastedContents: draft.pastedContents,
  })
  noteCompanionTyping()
}

export function flushDrafts(): Promise<void> {
  return flushDraftSaves()
}

export const readDraftFor = readDraftSync

export function clearForSubmit(submittedText?: string): void {
  cancelPendingDraftSave()
  deleteDraft(owningSessionId ?? getSessionId())
  if (submittedText !== undefined) {
    staged = { text: submittedText, at: Date.now() }
  }
}


export const subscribePendingInput = changed.subscribe

export function text(): string {
  return draft.text
}

export function mode(): PromptInputMode {
  return draft.mode
}

export function pastedContents(): Record<number, PastedContent> {
  return draft.pastedContents
}

export function stashedPrompt(): StashedPrompt | undefined {
  return stash
}

export function editGeneration(): number {
  return editSeq
}


export function initOnce(seed: {
  text: string
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
  cursorOffset?: number
}): void {
  if (initialized) return
  initialized = true
  draft = {
    text: seed.text,
    cursorOffset: seed.cursorOffset ?? seed.text.length,
    mode: seed.mode,
    pastedContents: seed.pastedContents,
  }
}

export function initSession(
  sessionId: string | null | undefined,
  earlyInput: string,
): void {
  if (initialized) return
  owningSessionId = sessionId ?? null
  const saved = readDraftSync(sessionId)
  const chosenText = earlyInput !== '' ? earlyInput : (saved?.text ?? '')
  initOnce({
    text: chosenText,
    mode: saved?.mode === 'bash' || saved?.mode === 'prompt' ? saved.mode : 'prompt',
    pastedContents: saved?.pastedContents ?? {},
    cursorOffset:
      saved && saved.text === chosenText
        ? Math.max(0, Math.min(saved.cursorOffset, chosenText.length))
        : undefined,
  })
}

export async function rekeyToSession(sessionId: string | null, opts?: { landing?: boolean }): Promise<void> {
  const fence = editSeq
  const typedWhileLanding = opts?.landing === true ? draft.text : ''
  await flushDraftSaves()
  owningSessionId = sessionId
  if (opts?.landing === true && sessionId !== null) await migrateOrphanedDraft(sessionId)
  const saved = readDraftSync(sessionId)
  if (editSeq !== fence) return
  if (typedWhileLanding !== '' && (!saved || saved.text === '')) return
  const text = saved?.text ?? ''
  draft = {
    text,
    cursorOffset:
      saved && saved.text === text ? Math.max(0, Math.min(saved.cursorOffset, text.length)) : text.length,
    mode: saved?.mode === 'bash' || saved?.mode === 'prompt' ? saved.mode : 'prompt',
    pastedContents: saved?.pastedContents ?? {},
  }
  commit()
}

onSessionSwitch(id => {
  if (getFocusedSessionConnector().sessionId() !== '') return
  void rekeyToSession(String(id), { landing: true })
})

export function registerInterceptors(next: EditInterceptors): () => void {
  interceptors = next
  return () => {
    if (interceptors === next) interceptors = {}
  }
}

export function resetPendingInputForTests(): void {
  draft = { text: '', cursorOffset: 0, mode: 'prompt', pastedContents: {} }
  stash = undefined
  staged = null
  interceptors = {}
  initialized = false
  owningSessionId = null
  editSeq = 0
  if (suppressionTimer !== null) {
    clearTimeout(suppressionTimer)
    suppressionTimer = null
  }
}


function armSuppressionTimer(nonempty: boolean): void {
  if (suppressionTimer !== null) {
    clearTimeout(suppressionTimer)
    suppressionTimer = null
  }
  if (!nonempty) return
  suppressionTimer = setTimeout(() => {
    suppressionTimer = null
    interceptors.onActiveChange?.(false)
  }, PROMPT_SUPPRESSION_MS)
}

export function edit(value: string): void {
  const prev = draft.text
  if (interceptors.interceptSuggestion?.(prev, value)) return
  if (prev === '' && value !== '') {
    interceptors.onEmptyToNonempty?.()
  }
  editSeq++
  draft = { ...draft, text: value }
  commit()
  persistDraft()
  activityManager.recordUserActivity()
  updateLastInteractionTime(true)
  interceptors.onActiveChange?.(value.trim().length > 0)
  armSuppressionTimer(value.trim().length > 0)
  markTypingActivity()
}

export function append(seed: string): void {
  edit(draft.text + seed)
}


export function setMode(next: PromptInputMode): void {
  if (draft.mode === next) return
  draft = { ...draft, mode: next }
  commit()
  persistDraft()
}

export function setPastedContents(
  next: Record<number, PastedContent>,
): void {
  if (draft.pastedContents === next) return
  draft = { ...draft, pastedContents: next }
  commit()
  persistDraft()
}

export function reportCursor(offset: number): void {
  if (draft.cursorOffset === offset) return
  draft = { ...draft, cursorOffset: offset }
  persistDraft()
}


export function setStash(next: StashedPrompt | undefined): void {
  stash = next
  commit()
}


let staged: { text: string; at: number } | null = null

export function stagedSubmit(): { text: string; at: number } | null {
  return staged
}

export function clearStaged(): void {
  staged = null
}


export function shouldAutoRestore(ctx: {
  reason: unknown
  queryActive: boolean
  queueLength: number
  viewingAgent: boolean
}): boolean {
  return (
    ctx.reason === 'user-cancel' &&
    !ctx.queryActive &&
    draft.text === '' &&
    ctx.queueLength === 0 &&
    !ctx.viewingAgent
  )
}
