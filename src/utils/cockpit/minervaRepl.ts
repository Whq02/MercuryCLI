// ============================================================================
//  utils/cockpit/minervaRepl — the TABULA card's MINERVA ask line (mini-REPL).
//
//  The helmConsole pattern applied to the notepad curator (operator goal
// Minerva must be a usable REPL in the LEFT cockpit, under the
//  TABULA container — one consolidated surface instead of board-`>` /
//  /minerva / boot-flag scatter). A pure module store (observable + version
//  counter, the helmFocus idiom) behind the lanes rail's TABULA section.
//
//  Three parties share it:
//    · PromptInput — the ONE input owner. While the LANES rail holds focus
//      AND compose is active, its useInput routes edit keys here.
//    · HelmLanesRail — renders the ask line (idle · compose · asking ·
//      receipt) from these getters, subscribed via the version.
//    · The board (`>`) and /minerva — the SAME engine (runMinervaMessage);
//      this store is only the cockpit face.
//
//  USAGE HONESTY (the console invariant, verbatim): this store cannot
//  construct an API request. The network side lives behind an injected
//  MinervaReplRunner that only minervaSubmitBuffer() invokes — exactly once
//  per explicit ↵ — so an idle/composing ask line provably costs zero tokens.
// ============================================================================

import { fluxMark } from '../flux/fluxProbe.js'
import { isTabulaEnabled } from '../tabula/tabulaGates.js'
import { errorMessage } from '../errors.js'
import { getHelmFocus, subscribeHelmFocus } from './helmFocus.js'

/** Rides the TABULA master gate — no ask line when the pad is off. Re-read
 *  live on every call (authority-feature-toggles doctrine). */
export function minervaReplEnabled(): boolean {
  return isTabulaEnabled()
}

// ── shapes ──────────────────────────────────────────────────────────────────

/** What a runner resolves with — structurally satisfied by MinervaChatResult
 *  (utils/tabula/minerva.ts) without importing the engine into this store. */
export type MinervaReplResult = {
  ran: boolean
  ok?: boolean
  reply?: string
  reason?: string
  added?: number
  closed?: number
  refined?: number
  repri?: number
}

export type MinervaReplRunner = (
  message: string,
  abortController: AbortController,
) => Promise<MinervaReplResult>

export type MinervaExchange = {
  message: string
  askedAt: number
  durationMs?: number
  reply?: string
  error?: string
  counts?: { added: number; closed: number; refined: number; repri: number }
}

// ── caps ────────────────────────────────────────────────────────────────────

/** One-line ask — matches the engine's MAX_CHAT_MESSAGE_CHARS ceiling. */
const BUFFER_MAX = 2000

// ── state ───────────────────────────────────────────────────────────────────

let composing = false
/** Codepoint array, not a string — cursor ops must never split a surrogate pair. */
let buffer: string[] = []
let cursor = 0
let askCount = 0
let pendingAsk: {
  id: number
  message: string
  startedAt: number
  controller: AbortController
} | null = null
/** Public mirror of pendingAsk (stable per ask — safe to hand to render). */
let pendingPublic: { message: string; startedAt: number } | null = null
let lastExchange: MinervaExchange | null = null
let askSeq = 0

let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  fluxMark('minerva:notify') // probe-gated ring stamp (off ⇒ no-op)
  for (const l of listeners) l()
}

export function subscribeMinervaRepl(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Monotonic version — the useSyncExternalStore snapshot. */
export function getMinervaReplVersion(): number {
  return version
}

// ── focus suspension (the console contract, LANES pane) ─────────────────────

let unsubFocus: (() => void) | null = null

function armFocusWatch(): void {
  if (unsubFocus) return
  unsubFocus = subscribeHelmFocus(() => {
    if (composing && getHelmFocus() !== 'lanes') exitMinervaCompose()
  })
}

function disarmFocusWatch(): void {
  if (!unsubFocus) return
  unsubFocus()
  unsubFocus = null
}

// ── getters ─────────────────────────────────────────────────────────────────

export function isMinervaComposing(): boolean {
  return composing
}

export function getMinervaBuffer(): string {
  return buffer.join('')
}

export function getMinervaCursor(): number {
  return cursor
}

export function getMinervaPending(): { message: string; startedAt: number } | null {
  return pendingPublic
}

export function getMinervaLastExchange(): MinervaExchange | null {
  return lastExchange
}

/** Total sends this session (the honest billed-call count). */
export function getMinervaAskCount(): number {
  return askCount
}

// ── compose lifecycle ───────────────────────────────────────────────────────

export function beginMinervaCompose(seed?: string): void {
  if (composing && seed === undefined) return
  composing = true
  if (seed !== undefined) insertRaw(seed)
  armFocusWatch()
  notify()
}

export function exitMinervaCompose(): void {
  if (!composing) return
  composing = false
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
}

export function minervaInsert(s: string): void {
  if (!composing || !s) return
  insertRaw(s)
  notify()
}

export function minervaBackspace(): void {
  if (!composing || cursor === 0) return
  buffer.splice(cursor - 1, 1)
  cursor--
  notify()
}

export function minervaDeleteForward(): void {
  if (!composing || cursor >= buffer.length) return
  buffer.splice(cursor, 1)
  notify()
}

export function minervaMoveCursor(delta: number): void {
  if (!composing) return
  const next = Math.max(0, Math.min(buffer.length, cursor + delta))
  if (next === cursor) return
  cursor = next
  notify()
}

export function minervaCursorHome(): void {
  if (!composing || cursor === 0) return
  cursor = 0
  notify()
}

export function minervaCursorEnd(): void {
  if (!composing || cursor === buffer.length) return
  cursor = buffer.length
  notify()
}

/** ctrl+u — one-line prompt: "start over". */
export function minervaKillLine(): void {
  if (!composing || buffer.length === 0) return
  buffer = []
  cursor = 0
  notify()
}

// ── ask lifecycle ───────────────────────────────────────────────────────────

function settle(id: number, res: MinervaReplResult | undefined, err: unknown): void {
  // Stale settles (aborted, superseded) are ignored — abort already rewound.
  if (pendingAsk?.id !== id) return
  const { message, startedAt } = pendingAsk
  pendingAsk = null
  pendingPublic = null
  const ex: MinervaExchange = {
    message,
    askedAt: startedAt,
    durationMs: Date.now() - startedAt,
  }
  if (err !== undefined) {
    ex.error = errorMessage(err) || 'minerva call failed'
  } else if (res && res.ran && res.ok && typeof res.reply === 'string') {
    ex.reply = res.reply
    ex.counts = {
      added: res.added ?? 0,
      closed: res.closed ?? 0,
      refined: res.refined ?? 0,
      repri: res.repri ?? 0,
    }
  } else {
    ex.error = res?.reason ?? 'no reply'
  }
  lastExchange = ex
  notify()
}

/** The relief verbs (chat-relief item 1 — every chat surface answers
 *  /clear and /compact per its OWN lifecycle law). Minerva's engine is
 *  one-shot by design: every ask reads the LIVE notepad fresh (bounded
 *  notes + an optional bounded session digest) and carries no chat history
 *  at all, so no Minerva-side context ever accumulates. /clear resets this
 *  ask line to its fresh birth (the last exchange gone — the notepad is
 *  operator territory and is never touched); /compact answers that truth.
 *  Both settle locally: zero model calls, no billed-ask count. */
export const MINERVA_COMPACT_TRUTH =
  'nothing accumulates here — every ask reads the live notepad fresh; /clear resets this line (notes are yours, on the board)'

function minervaReliefVerb(message: string): boolean {
  if (message !== '/clear' && message !== '/compact') return false
  if (message === '/clear') {
    lastExchange = null
  } else {
    lastExchange = {
      message,
      askedAt: Date.now(),
      durationMs: 0,
      reply: MINERVA_COMPACT_TRUTH,
      counts: { added: 0, closed: 0, refined: 0, repri: 0 },
    }
  }
  buffer = []
  cursor = 0
  notify()
  return true
}

/** ↵ in compose mode: send the buffer. One exchange in flight at a time —
 *  the ONLY spender (an explicit ↵ is the billed consent, the board-`>` rule). */
export function minervaSubmitBuffer(run: MinervaReplRunner): boolean {
  if (!composing || pendingAsk) return false
  if (!minervaReplEnabled()) return false
  const message = buffer.join('').trim()
  if (!message) return false
  if (minervaReliefVerb(message)) return true
  const id = ++askSeq
  askCount++
  buffer = []
  cursor = 0
  const controller = new AbortController()
  pendingAsk = { id, message, startedAt: Date.now(), controller }
  pendingPublic = { message, startedAt: pendingAsk.startedAt }
  notify()
  run(message, controller).then(
    res => settle(id, res, undefined),
    err => settle(id, undefined, err),
  )
  return true
}

/** esc while asking: abort the call (the stream stops billing) and hand the
 *  message back as the compose buffer for re-editing. */
export function minervaAbortAsk(): boolean {
  if (!pendingAsk) return false
  const { id, controller, message } = pendingAsk
  void id
  pendingAsk = null
  pendingPublic = null
  controller.abort()
  buffer = Array.from(message)
  cursor = buffer.length
  composing = true
  armFocusWatch()
  notify()
  return true
}

// ── test hook ───────────────────────────────────────────────────────────────

export function resetMinervaReplForTest(): void {
  composing = false
  buffer = []
  cursor = 0
  askCount = 0
  askSeq = 0
  pendingAsk?.controller.abort()
  pendingAsk = null
  pendingPublic = null
  lastExchange = null
  disarmFocusWatch()
  version = 0
}
