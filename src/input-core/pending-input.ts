// ============================================================================
//  input-core/pending-input.ts — the typed
//  pending-input owner.
//
//  ONE owner for the composer's nonvisual state families — the editable
//  draft (text · durable cursor · mode · pastes), the ctrl+s stash, and the
//  submit-staging record. The REPL and PromptInput render trees are
//  protected surfaces: they PROJECT this store (useSyncExternalStore over
//  the frozen snapshot, the command-queue pattern) and register the
//  REPL-owned edit interceptors once at mount. Queued follow-ups live next
//  door (command-queue.ts); auto-restore is a pure predicate
//  (shouldAutoRestore) — not state.
//
//  THE EDIT CHOKEPOINT (the five ordered effects the inputsched contract
//  pins — a new owner dropping any one kills a shipped behavior):
//    1. suggestion intercept (BG-PR) — may CONSUME the edit entirely;
//    2. empty→nonempty transition → the scroll re-pin callback (the
//       recent-scroll window gate stays REPL-side — scroll state is T7's);
//    3. synchronous store commit — module state commits before React does,
//       so every old "read the ref before React commits" site reads
//       text() and the stale-ref class dissolves;
//    4. prompt-active flip (dialog suppression) on trim-nonempty;
//    5. typing-activity mark.
//  Plus the owner-internal sixth: the suppression un-suppress timer
//  (PROMPT_SUPPRESSION_MS after the last keystroke → onActiveChange(false);
//  the old body kept this in a REPL useEffect keyed on [inputValue]).
// ============================================================================
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
  /** The DURABLE cursor (reported by PromptInput; the live cursor stays
   *  PromptInput state). */
  cursorOffset: number
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
}

export type StashedPrompt = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
}

/** Registered once at REPL mount — the REPL-owned chokepoint effects. */
export type EditInterceptors = {
  /** BG-PR suggestion intercept: true CONSUMES the edit (store untouched). */
  interceptSuggestion?: (prev: string, next: string) => boolean
  /** The empty→nonempty transition (the caller applies its recent-scroll
   *  window gate + repin). */
  onEmptyToNonempty?: () => void
  /** Dialog-suppression flip — mirrors trim-nonemptiness; also fired false
   *  by the owner's suppression timer. */
  onActiveChange?: (active: boolean) => void
}

const PROMPT_SUPPRESSION_MS = 1500

// ── the store ────────────────────────────────────────────────────────────────

let draft: ComposerDraft = {
  text: '',
  cursorOffset: 0,
  mode: 'prompt',
  pastedContents: {},
}
let stash: StashedPrompt | undefined
let interceptors: EditInterceptors = {}
let initialized = false
/** THE OWNING SESSION of the live draft (Law 9: the draft is the session's
 *  own state; the disk store below is keyed per session). Seeded at
 *  initSession, moved by rekeyToSession at the slot swap — the bootstrap
 *  identity (getSessionId) does NOT follow the focused slot in the
 *  concourse world, so the owner is carried here explicitly and every
 *  persist/delete keys by it. Null before init (falls back to the
 *  bootstrap id — the pre-concourse world's key). */
let owningSessionId: string | null = null
let suppressionTimer: ReturnType<typeof setTimeout> | null = null
// monotonic edit generation — the session-switch commit tail
// compares entry/commit generations so a restore can never roll back text
// the operator typed while the switch was staging (typing wins).
let editSeq = 0

const changed = createSignal()

function commit(): void {
  changed.emit()
}

// ── persistence (S3: the owner is promptDraft's ONLY writer) ─────────────
// Every draft mutation coalesces (the engine's 400ms debounce) into the
// per-(project, session) store, owning session captured AT MUTATION TIME —
// a mid-debounce switch flushes the SOURCE session's keystrokes
// (promptDraft's owning-session rule). An emptied prompt DELETES the entry
// downstream, so a submitted prompt never resurrects.

function persistDraft(): void {
  saveDraftDebounced(owningSessionId ?? getSessionId(), {
    text: draft.text,
    cursorOffset: draft.cursorOffset,
    mode: draft.mode,
    pastedContents: draft.pastedContents,
  })
  // Companion calm rule: the creature never quips over an actively
  // mutating draft — the same per-mutation cadence as the old effect.
  noteCompanionTyping()
}

/** Flush pending keystroke saves (session switch STAGE phase · unmount). */
export function flushDrafts(): Promise<void> {
  return flushDraftSaves()
}

/** The target session's draft, sync (the REPL commit tail — torn-write-free
 *  after flushDrafts; also the cursor boot seed). */
export const readDraftFor = readDraftSync

/** SUBMIT clears the durable draft deterministically: cancel the pending
 *  keystroke save FIRST (a late flush would resurrect the just-submitted
 *  text), THEN delete. The empty-save path in PromptInput cannot own this —
 *  a local-JSX submit unmounts PromptInput in the same commit that clears
 *  the input, so its effect never sees the ''. */
export function clearForSubmit(submittedText?: string): void {
  cancelPendingDraftSave()
  deleteDraft(owningSessionId ?? getSessionId())
  if (submittedText !== undefined) {
    staged = { text: submittedText, at: Date.now() }
  }
}

// ── projections (useSyncExternalStore-compatible) ────────────────────────────

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

/** bumps on every text edit — fences async/staged restores. */
export function editGeneration(): number {
  return editSeq
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** One-time mount seed (REPL's lazy useState initializers, moved). The
 *  caller passes the early-input/draft resolution. Idempotent: a
 *  StrictMode double-mount seeds once. */
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
  // No commit: nothing subscribes before first render reads the snapshot.
  // No persist: a boot seed is not a mutation.
}

/** The consolidated boot seed (S3 — ONE draft read replaces the
 *  REPL's three lazy initializer reads): early input wins; only the
 *  EDITABLE modes are draft-restorable (the transient dialog modes never
 *  persist); the saved cursor seeds only when the saved text is what
 *  actually seeded. */
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

/** THE SESSION RE-KEY (SWIFTVERIFY W4 — the hop's swap; Law 9: the draft
 *  is the session's own): the REPL's hop effect calls this when the
 *  focused slot re-points. The outgoing session's keystrokes ride the
 *  debounced saves' capture-at-mutation (flushed here to ITS disk entry);
 *  the owner moves to the target; the target's saved draft then seeds the
 *  live families — unless the operator typed meanwhile (the editSeq fence:
 *  typing wins, the landed commit-tail rule; a mid-swap keystroke may save
 *  once under the outgoing key — the next keystroke heals it). A restore
 *  is NOT a keystroke: the write bypasses the edit chokepoint (no
 *  suggestion intercept, no typing-activity mark, no suppression flip —
 *  initOnce semantics). The STASH (ctrl+s) deliberately survives the swap:
 *  it is the OPERATOR's pocket, not the session's page — stash, go look
 *  (often at another session), come back. `staged` settles through its own
 *  ms-scale clearStaged and is left alone. */
export async function rekeyToSession(sessionId: string | null, opts?: { landing?: boolean }): Promise<void> {
  const fence = editSeq
  // A LANDING is not a hop: the slot filling from NO session (a birth, a
  // resume from the face) carries the words typed while it landed — they
  // were typed for the chat that is arriving, and the born session has no
  // saved page of its own to restore over them. A session that does own a
  // saved page keeps it (the page wins, as on any hop). The caller names
  // the landing: the store's owner at boot is the bootstrap identity, which
  // is also a live session's own id in the plain world, so the owner alone
  // cannot tell a landing from a hop.
  const typedWhileLanding = opts?.landing === true ? draft.text : ''
  await flushDraftSaves()
  owningSessionId = sessionId
  // THE LANDING MOVES THE PAGE: the composer mounted under the boot's own id
  // (no session held the slot yet), so what the operator typed while the
  // chat landed — and any page an older boot left under such an id — sits
  // under a key no transcript carries. On a landing the one orphaned page
  // of this project follows the conversation; a hop never migrates (the
  // page under a boot id during a hop is this boot's own live draft).
  if (opts?.landing === true && sessionId !== null) await migrateOrphanedDraft(sessionId)
  const saved = readDraftSync(sessionId)
  if (editSeq !== fence) return // the operator typed into the new view — typing wins
  if (typedWhileLanding !== '' && (!saved || saved.text === '')) return // the landing keeps the live draft
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

// THE IDENTITY SWITCH (the plain road's resume): a boot-flag resume adopts
// its transcript AFTER the composer mounted under the boot's own id, and no
// seat holds the slot to re-key it — the adopted conversation is the owner
// from the switch on (its saved page restores; words typed while it landed
// stay). A hosted chat's slot re-keys at the swap instead (the REPL's own
// effect), so the switch is left to it while a session holds the slot.
onSessionSwitch(id => {
  if (getFocusedSessionConnector().sessionId() !== '') return
  void rekeyToSession(String(id), { landing: true })
})

/** REPL registers its chokepoint effects once at mount; a re-register
 *  replaces (the latest render's closures win). */
export function registerInterceptors(next: EditInterceptors): () => void {
  interceptors = next
  return () => {
    if (interceptors === next) interceptors = {}
  }
}

/** Test seam — mirrors resetCommandQueue's role. */
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

// ── the chokepoint ───────────────────────────────────────────────────────────

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

/** The ONE edit path — every text change (keystroke, seed, restore, pop,
 *  clear) rides these five ordered effects. */
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
  // Interaction clock (S5 — the per-keystroke half of the old REPL
  // [inputValue, submitCount] effect; must be immediate, not post-render).
  activityManager.recordUserActivity()
  updateLastInteractionTime(true)
  interceptors.onActiveChange?.(value.trim().length > 0)
  armSuppressionTimer(value.trim().length > 0)
  // COCKPIT S2: decoration pauses while the operator types.
  markTypingActivity()
}

/** The consent-card/companion seed path — SAME chokepoint by construction. */
export function append(seed: string): void {
  edit(draft.text + seed)
}

// ── non-text draft families ──────────────────────────────────────────────────

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

/** PromptInput reports the durable cursor (no re-render: cursor is not a
 *  projected field — it feeds persistence and stash round-trips). */
export function reportCursor(offset: number): void {
  if (draft.cursorOffset === offset) return
  draft = { ...draft, cursorOffset: offset }
  persistDraft()
}

// ── stash (ctrl+s) ───────────────────────────────────────────────────────────

export function setStash(next: StashedPrompt | undefined): void {
  stash = next
  commit()
}

// ── submit staging (S4) ──────────────────────────────────────────────────
// The accounting record between "the composer cleared for submit" and "the
// turn actually started": the NO-LOST-INPUT law reads it — a character is
// always in exactly one of {draft, queue entry, staged/submitted, stash}.

let staged: { text: string; at: number } | null = null

export function stagedSubmit(): { text: string; at: number } | null {
  return staged
}

/** The submission was taken (delivered or re-queued) — the staged record
 *  settles. */
export function clearStaged(): void {
  staged = null
}

// ── auto-restore (S4) ────────────────────────────────────────────────────

/** The five-guard auto-restore predicate, pure (the REPL's finally consults
 *  it; the inner selectable/synthetic gates stay REPL-side — they read the
 *  message systems). Restores the cancelled submission into the composer
 *  ONLY when:
 *   1. the abort was an explicit user-cancel (not a steer/interrupt),
 *   2. no new turn is already running,
 *   3. the composer is still EMPTY (the operator hasn't typed since),
 *   4. nothing is queued (a queued follow-up owns the next turn),
 *   5. not viewing a teammate (the transcript is the main conversation). */
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
