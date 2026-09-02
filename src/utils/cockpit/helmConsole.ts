// ============================================================================
//  utils/cockpit/helmConsole — the Helm cockpit CONSOLE store (mini-REPL).
//
//  A pure module store (observable + version counter, Mercury's module-state
//  pattern — see helmFocus.ts) behind the telemetry rail's `console` section:
//  a one-line REPL that asks the side-question engine (runSideQuestion) from the cockpit
//  without leaving the helm or touching the main thread.
//
//  Three parties share it:
//    · PromptInput — the ONE input owner. While the telemetry rail holds
//      focus AND compose is active, its useInput routes edit keys here.
//    · HelmTelemetryRail — renders the section (input line, asking state,
//      answer block) from these getters, subscribed via the version.
//    · /console — the full-history overlay command; same store, so the rail
//      and the overlay can never disagree.
//
//  USAGE HONESTY (the design invariant): this store cannot construct an API
//  request. The network side lives behind an injected ConsoleRunner that only
//  consoleSubmitBuffer()/consoleAsk() invoke — exactly once per explicit ↵ —
//  so an idle/composing console provably costs zero tokens.
// ============================================================================

import { errorMessage } from '../errors.js'
import { getHelmFocus, subscribeHelmFocus } from './helmFocus.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Kill switch (default-ON): `MERCURY_HELM_CONSOLE=0` removes the section,
 *  the compose routing, and the /console surface. Re-read live on every call
 *  (authority-feature-toggles doctrine — a gate must never cache the env). */
export function consoleEnabled(): boolean {
  return flagEnv('MERCURY_HELM_CONSOLE') !== '0'
}

// ── shapes ──────────────────────────────────────────────────────────────────

export type ConsoleUsage = {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export type ConsoleEntry = {
  id: number
  question: string
  askedAt: number
  durationMs?: number
  answer?: string
  error?: string
  usage?: ConsoleUsage
  /** Parentage — where the ask branched from. */
  originRef?: string
  /** the ask's OWN stable conversation identity in the
   *  crew registry (console-side kind, parent lineage to the main thread;
   *  set once the async mint lands; absent while the directory is off). */
  conversationId?: string
}

/** What a runner resolves with — structurally satisfied by SideQuestionResult
 *  (utils/sideQuestion.ts) without importing the API layer into this store. */
export type ConsoleRunnerResult = {
  response: string | null
  /** Parentage — echoed from the side-question engine
   *  and recorded on the settled history entry. */
  originRef?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export type ConsoleRunner = (
  question: string,
  abortController: AbortController,
) => Promise<ConsoleRunnerResult>

// ── caps ────────────────────────────────────────────────────────────────────

/** Input line cap — a paste larger than this truncates (one-line ask, not a doc). */
const BUFFER_MAX = 2000
/** Bounded session memory: older Q/A entries fall off the front. */
const ENTRIES_MAX = 24
/** Recall ring for ↑/↓ (independent of entry trimming). */
const HISTORY_MAX = 50

// ── state ───────────────────────────────────────────────────────────────────

let composing = false
/** Codepoint array, not a string — cursor ops must never split a surrogate pair. */
let buffer: string[] = []
let cursor = 0
/** Live-draft stash while ↑/↓ walks history (readline behavior). */
let draft: string[] = []
let histIdx: number | null = null
let history: string[] = []
let entries: ConsoleEntry[] = []
let entrySeq = 0
let askCount = 0
let pendingAsk: {
  id: number
  question: string
  startedAt: number
  controller: AbortController
} | null = null
/** Public mirror of pendingAsk (stable per ask — safe to hand to render). */
let pendingPublic: { question: string; startedAt: number } | null = null

let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const l of listeners) l()
}

// ── M6: conversation identity for every ask ───────────────────
// Each console ask is its OWN console-side conversation (a NEW id with parent
// lineage to the main thread — never the main id, never a transcript merge).
// The registry writes are fire-and-forget behind the crew flag: the console's
// Q/A truth stays THIS store; the registry rows are the cross-surface
// projection. A settle racing the mint chains on the mint promise.
const conversationMints = new Map<number, Promise<string | null>>()

function mintAskConversation(id: number, question: string): void {
  const mint = (async (): Promise<string | null> => {
    const { crewDirectoryEnabled } = await import('../../services/crew/identity.js')
    if (!crewDirectoryEnabled()) return null
    const [{ openSideConversation }, { operatorPrincipal }] = await Promise.all([
      import('../../services/crew/consoleHandoff.js'),
      import('../../substrate/identity/identity.js'),
    ])
    const conversation = await openSideConversation({
      question,
      askedBy: { kind: 'operator', principalId: operatorPrincipal().id },
    })
    const e = entries.find(x => x.id === id)
    if (e) {
      e.conversationId = conversation.conversationId
      notify()
    }
    return conversation.conversationId
  })().catch(() => null)
  conversationMints.set(id, mint)
}

function recordAskOutcome(
  id: number,
  outcome:
    | { kind: 'answered'; response: string; ref?: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'dismissed' },
): void {
  const mint = conversationMints.get(id)
  conversationMints.delete(id)
  if (!mint) return
  void mint
    .then(async conversationId => {
      if (!conversationId) return
      const { recordSideOutcome } = await import('../../services/crew/consoleHandoff.js')
      await recordSideOutcome(conversationId as never, outcome)
    })
    .catch(() => {
      // the console entry is the session truth; the registry row is bounded
      // best-effort projection
    })
}

export function subscribeConsole(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Monotonic version — the useSyncExternalStore snapshot (state reads are
 *  separate getters, matching the helmFocus pattern). */
export function getConsoleVersion(): number {
  return version
}

// ── focus suspension ────────────────────────────────────────────────────────
// Compose is a sub-state of telemetry focus: the instant focus leaves the
// telemetry pane (esc, Tab, rail unmount hygiene — every transition flows
// through setHelmFocus), compose SUSPENDS. The buffer survives as a draft, so
// ↵ on the console row resumes exactly where the operator left off. The watch
// is armed only while composing — an unused console adds zero subscriptions.

let unsubFocus: (() => void) | null = null

function armFocusWatch(): void {
  if (unsubFocus) return
  unsubFocus = subscribeHelmFocus(() => {
    if (composing && getHelmFocus() !== 'telemetry') exitConsoleCompose()
  })
}

function disarmFocusWatch(): void {
  if (!unsubFocus) return
  unsubFocus()
  unsubFocus = null
}

// ── getters (read after a version-subscribed render, helmFocus idiom) ───────

export function isConsoleComposing(): boolean {
  return composing
}

export function getConsoleBuffer(): string {
  return buffer.join('')
}

export function getConsoleCursor(): number {
  return cursor
}

export function isConsoleRecalling(): boolean {
  return histIdx !== null
}

export function getConsolePending(): { question: string; startedAt: number } | null {
  return pendingPublic
}

/** Live entries, oldest→newest (the rail reads .at(-1); /console lists all).
 *  The array reference is live — treat as read-only. */
export function getConsoleEntries(): readonly ConsoleEntry[] {
  return entries
}

/** Total asks this session (survives entry trimming — the section count). */
export function getConsoleAskCount(): number {
  return askCount
}

// ── compose lifecycle ───────────────────────────────────────────────────────

export function beginConsoleCompose(seed?: string): void {
  if (composing && seed === undefined) return
  composing = true
  if (seed !== undefined) {
    insertRaw(seed)
  }
  armFocusWatch()
  notify()
}

export function exitConsoleCompose(): void {
  if (!composing) return
  composing = false
  histIdx = null
  disarmFocusWatch()
  notify()
}

// ── edit ops (pure buffer/cursor transitions; no-ops outside compose) ───────

function insertRaw(s: string): void {
  // One-line discipline: newlines/tabs from a paste become single spaces;
  // other control chars drop. Cap the line at BUFFER_MAX codepoints.
  const clean = Array.from(
    s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ''),
  )
  const room = BUFFER_MAX - buffer.length
  if (room <= 0) return
  const ins = clean.slice(0, room)
  buffer.splice(cursor, 0, ...ins)
  cursor += ins.length
  histIdx = null
}

export function consoleInsert(s: string): void {
  if (!composing || !s) return
  insertRaw(s)
  notify()
}

export function consoleBackspace(): void {
  if (!composing || cursor === 0) return
  buffer.splice(cursor - 1, 1)
  cursor--
  histIdx = null
  notify()
}

export function consoleDeleteForward(): void {
  if (!composing || cursor >= buffer.length) return
  buffer.splice(cursor, 1)
  histIdx = null
  notify()
}

export function consoleMoveCursor(delta: number): void {
  if (!composing) return
  const next = Math.max(0, Math.min(buffer.length, cursor + delta))
  if (next === cursor) return
  cursor = next
  notify()
}

export function consoleCursorHome(): void {
  if (!composing || cursor === 0) return
  cursor = 0
  notify()
}

export function consoleCursorEnd(): void {
  if (!composing || cursor === buffer.length) return
  cursor = buffer.length
  notify()
}

/** ctrl+u — clear the whole line (readline kill-line-backwards, whole-line
 *  here: a one-line prompt treats it as "start over"). */
export function consoleKillLine(): void {
  if (!composing || buffer.length === 0) return
  buffer = []
  cursor = 0
  histIdx = null
  notify()
}

/** ctrl+w — delete the word before the cursor. */
export function consoleKillWord(): void {
  if (!composing || cursor === 0) return
  let i = cursor
  while (i > 0 && buffer[i - 1] === ' ') i--
  while (i > 0 && buffer[i - 1] !== ' ') i--
  buffer.splice(i, cursor - i)
  cursor = i
  histIdx = null
  notify()
}

// ── history recall (↑/↓ while composing) ────────────────────────────────────

function pushHistory(q: string): void {
  if (history[history.length - 1] === q) return
  history.push(q)
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
}

export function consoleHistoryMove(dir: -1 | 1): void {
  if (!composing || history.length === 0) return
  if (dir === -1) {
    if (histIdx === null) {
      draft = buffer
      histIdx = history.length - 1
    } else if (histIdx > 0) {
      histIdx--
    } else {
      return
    }
    buffer = Array.from(history[histIdx] ?? '')
    cursor = buffer.length
    notify()
    return
  }
  if (histIdx === null) return
  if (histIdx < history.length - 1) {
    histIdx++
    buffer = Array.from(history[histIdx] ?? '')
  } else {
    histIdx = null
    buffer = draft
    draft = []
  }
  cursor = buffer.length
  notify()
}

// ── ask lifecycle ───────────────────────────────────────────────────────────

function normalizeUsage(u: ConsoleRunnerResult['usage']): ConsoleUsage | undefined {
  if (!u) return undefined
  return {
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

function settle(id: number, res: ConsoleRunnerResult | undefined, err: unknown): void {
  // Stale settles (aborted, superseded) are ignored — abort already rewound.
  if (pendingAsk?.id !== id) return
  const startedAt = pendingAsk.startedAt
  pendingAsk = null
  pendingPublic = null
  const e = entries.find(x => x.id === id)
  if (!e) {
    notify()
    return
  }
  e.durationMs = Date.now() - startedAt
  if (err !== undefined) {
    e.error = errorMessage(err) || 'Failed to get response'
    recordAskOutcome(id, { kind: 'failed', reason: e.error })
  } else if (res?.response) {
    e.answer = res.response
    e.usage = normalizeUsage(res.usage)
    if (res.originRef !== undefined) e.originRef = res.originRef
    recordAskOutcome(id, {
      kind: 'answered',
      response: res.response,
      ...(res.originRef !== undefined ? { ref: res.originRef } : {}),
    })
  } else {
    e.error = 'No response received'
    recordAskOutcome(id, { kind: 'failed', reason: e.error })
  }
  notify()
}

/** The relief verbs (chat-relief item 1 — every chat surface answers
 *  /clear and /compact per its OWN lifecycle law). The console's context is
 *  a cache-sharing FORK of the main chat's conversation (runSideQuestion —
 *  every ask reads it fresh, and the fork respects the main chat's compact
 *  boundary), so nothing console-side accumulates into a model window:
 *  /clear rides the ONE clear owner (consoleClear — the rail's ctrl+l and
 *  the /console overlay run the same door: wipes the shelf, aborts a
 *  pending ask), and /compact answers the honest truth about where the
 *  context lives instead of pretending to fold anything. Both settle
 *  locally: zero model calls, zero usage, no billed-ask count, no registry
 *  mint. */
export const CONSOLE_COMPACT_TRUTH =
  `the console shares the main chat's context — /compact there relieves both; ` +
  `this shelf keeps the last ${ENTRIES_MAX} asks, and /clear empties it`

function reliefVerb(q: string): boolean {
  if (q !== '/clear' && q !== '/compact') return false
  if (q === '/clear') {
    consoleClear()
    return true
  }
  const id = ++entrySeq
  entries.push({ id, question: q, askedAt: Date.now(), durationMs: 0, answer: CONSOLE_COMPACT_TRUTH })
  if (entries.length > ENTRIES_MAX) entries = entries.slice(-ENTRIES_MAX)
  pushHistory(q)
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  notify()
  return true
}

function startAsk(question: string, run: ConsoleRunner): boolean {
  if (!consoleEnabled()) return false
  const q = question.trim()
  if (!q) return false
  // The relief verbs land ahead of the one-in-flight guard: /clear during a
  // pending ask aborts it (exactly the ctrl+l behavior it rides).
  if (reliefVerb(q)) return true
  if (pendingAsk) return false
  const id = ++entrySeq
  entries.push({ id, question: q, askedAt: Date.now() })
  if (entries.length > ENTRIES_MAX) entries = entries.slice(-ENTRIES_MAX)
  mintAskConversation(id, q)
  pushHistory(q)
  askCount++
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  const controller = new AbortController()
  const startedAt = Date.now()
  pendingAsk = { id, question: q, startedAt, controller }
  pendingPublic = { question: q, startedAt }
  notify()
  run(q, controller).then(
    res => settle(id, res, undefined),
    err => settle(id, undefined, err),
  )
  return true
}

/** ↵ in compose mode: ask the buffer. One ask in flight at a time. */
export function consoleSubmitBuffer(run: ConsoleRunner): boolean {
  if (!composing) return false
  return startAsk(buffer.join(''), run)
}

/** Programmatic ask (the /console command with args) — no compose needed. */
export function consoleAsk(question: string, run: ConsoleRunner): boolean {
  return startAsk(question, run)
}

/** esc while asking: abort Mercury (the stream stops billing), drop the
 *  entry, and hand the question back as the compose buffer for re-editing. */
export function consoleAbortAsk(): boolean {
  if (!pendingAsk) return false
  const { id, controller, question } = pendingAsk
  pendingAsk = null
  pendingPublic = null
  controller.abort()
  recordAskOutcome(id, { kind: 'dismissed' })
  const idx = entries.findIndex(e => e.id === id)
  if (idx >= 0) entries.splice(idx, 1)
  buffer = Array.from(question)
  cursor = buffer.length
  histIdx = null
  composing = true
  armFocusWatch()
  notify()
  return true
}

/** ctrl+l (rail compose + /console) and `/console clear`: wipe the console
 *  session — entries, recall history, draft, and any in-flight ask (aborted,
 *  so the stream stops billing). Compose state itself survives: clearing is
 *  "fresh screen", not "leave the REPL". Returns whether anything was wiped. */
export function consoleClear(): boolean {
  const had =
    entries.length > 0 ||
    history.length > 0 ||
    buffer.length > 0 ||
    pendingAsk !== null
  if (pendingAsk) {
    pendingAsk.controller.abort()
    recordAskOutcome(pendingAsk.id, { kind: 'dismissed' })
    pendingAsk = null
    pendingPublic = null
  }
  entries = []
  history = []
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  askCount = 0
  if (had) notify()
  return had
}

// ── test hook ───────────────────────────────────────────────────────────────

export function resetConsoleForTest(): void {
  composing = false
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  history = []
  entries = []
  entrySeq = 0
  askCount = 0
  pendingAsk?.controller.abort()
  pendingAsk = null
  pendingPublic = null
  conversationMints.clear()
  disarmFocusWatch()
  version = 0
}
