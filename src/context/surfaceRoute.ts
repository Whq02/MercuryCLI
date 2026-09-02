// ============================================================================
//  surfaceRoute — THE in-process route owner
//  (the route-placement binding).
//
//  One typed transition owner above the REPL tree decides WHICH application
//  surface owns the frame: the root REPL, the in-process Boot Settings
//  projection, the Session Concourse, or a full-session REPL. Moving among
//  them is a pure in-process route swap inside the one mounted Ink root and
//  one outer terminal lifetime — a transition performs NO splash spawn, app
//  bootstrap, launchGraph re-arm, alternate-screen/raw-mode change,
//  standalone clear, provider call or worker lifecycle action (route-owned;
//  prove-route-silence drives the byte capture). The previous surface stays
//  MOUNTED underneath (state, workers, drafts intact) — presentation
//  transfer is the only thing a route changes.
//
//  REGISTRY, not switch: surfaces register their renderer under a typed kind
//  (registerRouteSurface) so plugs the Concourse in without editing the
//  router's decision logic. 'concourse' and 'session:<id>' are TYPED today
//  and refuse honestly ('surface-unregistered') until their surface exists —
//  a transition API that lies about an absent screen is the capability-
//  optimism class. The standalone splash can never call this owner: its only
//  channel is the validated receipt intent, resolved by
//  resolveInitialSurface at launch. The STRIP (shift+←/→) is this owner's
//  too: it counts its stops from what exists — the boot face always, the
//  concourse while its switch is on outside a `--chat` boot, the chat while
//  a session is focused — and never routes into an absent one.
//
//  Store idiom: module-scoped, React-free, useSyncExternalStore-compatible
//  (the overlayStack pattern). UI face: src/components/SurfaceRouter.tsx.
// ============================================================================

import { flagSpellings } from '../substrate/flagRegistry.js'
import { currentInputEventSeq, markInputConsumedThroughCurrentSeq } from '../ink/events/input-event.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { keyHintLabel } from '../components/mercury-ui/keyHintLabel.js'
import { concourseEnabled } from '../services/concourse/concourseEnabled.js'

export type SurfaceKind = 'repl' | 'boot-settings' | 'concourse' | 'session'

/**  R1a — the typed transition verb vocabulary
 * Every route change is exactly one of these; the store records
 *  the last transition with its verb, generation and committing input-event
 *  seq so consumers can fence input by DECODED-EVENT IDENTITY rather than
 *  timing (the useOpenEventGate law extended to routes). */
export type SurfaceTransitionVerb = 'PUSH' | 'RETURN' | 'HOME' | 'INIT'

export interface SurfaceTransitionRecord {
  readonly verb: SurfaceTransitionVerb
  readonly from: string
  readonly to: string
  /** Monotonic surface generation — bumps on EVERY committed transition. */
  readonly generation: number
  /** currentInputEventSeq() at the commit: the decoded event that caused
   *  this transition. Handlers in the REVEALED generation must decline any
   *  event with seq ≤ this stamp (it was decoded under the old surface). */
  readonly commitSeq: number
}

export type SurfaceRoute =
  | { readonly kind: 'repl' }
  | { readonly kind: 'boot-settings' }
  | { readonly kind: 'concourse' }
  | { readonly kind: 'session'; readonly sessionId: string }

export const ROOT_REPL_ROUTE: SurfaceRoute = { kind: 'repl' }

/** Stable string identity for a route (selection restore, proofs, logs). */
export function surfaceRouteId(route: SurfaceRoute): string {
  return route.kind === 'session' ? `session:${route.sessionId}` : route.kind
}

/** The typed return token a transition answers: leaving the entered
 *  surface through returnFromSurface(token) restores EXACTLY the route the
 *  operator came from. Tokens are single-use and identity-checked. */
export interface SurfaceReturnToken {
  readonly to: SurfaceRoute
  readonly nonce: number
}

export type SurfaceTransition =
  | { ok: true; token: SurfaceReturnToken }
  | { ok: false; code: 'surface-unregistered' | 'already-current' | 'invalid-target'; reason: string }

// ── the registry ─────────────────────────────────────────────────────────────

export interface RouteSurfaceEntry {
  /** Render the surface for the active route. The host box (SurfaceRouter)
   *  owns geometry + the elevated-surface registration; the renderer owns
   *  content + input (overlay-stack registration parks the REPL beneath) and
   *  leaves via leaveCurrentSurface() / returnFromSurface(its token). */
  render: (route: SurfaceRoute) => import('react').ReactNode
  /** AR-10: 'inherit' composes the persistent
   *  MercuryFrame band beneath this surface's content in the route host —
   *  usage/mode telemetry never disappears while the surface owns the
   *  frame. Surfaces carrying their OWN finished chrome (the Concourse
   *  shell) and byte-parity surfaces (the canonical Boot face) stay bare. */
  frame?: 'inherit'
}

const registry = new Map<SurfaceKind, RouteSurfaceEntry>()

/** Register a surface renderer for a kind. Returns the unregister. The root
 *  'repl' kind is structural (the always-mounted children) and never
 *  registers here. */
export function registerRouteSurface(kind: Exclude<SurfaceKind, 'repl'>, entry: RouteSurfaceEntry): () => void {
  registry.set(kind, entry)
  bump()
  return () => {
    if (registry.get(kind) === entry) {
      registry.delete(kind)
      bump()
    }
  }
}

export function routeSurfaceRegistered(kind: SurfaceKind): boolean {
  return kind === 'repl' ? true : registry.has(kind)
}

export function getRouteSurface(kind: SurfaceKind): RouteSurfaceEntry | undefined {
  return kind === 'repl' ? undefined : registry.get(kind)
}

// ── the store ────────────────────────────────────────────────────────────────

let current: SurfaceRoute = ROOT_REPL_ROUTE
/** Where each in-flight non-repl surface returns to (a small stack: boot
 *  settings may sit over the Concourse, which sits over the root REPL). */
let returnStack: SurfaceReturnToken[] = []
let nextNonce = 1
let version = 0
let generation = 0
let lastTransition: SurfaceTransitionRecord = {
  verb: 'INIT',
  from: 'repl',
  to: 'repl',
  generation: 0,
  commitSeq: 0,
}
const listeners = new Set<() => void>()

/** R1a: commit a transition — one place stamps generation + the committing
 *  decoded-event identity for every verb. */
function commitTransition(verb: SurfaceTransitionVerb, from: SurfaceRoute, to: SurfaceRoute): void {
  generation += 1
  lastTransition = {
    verb,
    from: surfaceRouteId(from),
    to: surfaceRouteId(to),
    generation,
    commitSeq: currentInputEventSeq(),
  }
  // the commit consumes the input world up to (and including) the
  // committing event — the emitter's dispatch guard enforces it for every
  // remaining listener in this dispatch and for any queued event decoded
  // under the old generation. The next independently decoded event carries
  // a higher seq and lands in the new generation.
  markInputConsumedThroughCurrentSeq()
}

/** The current surface generation (monotonic per committed transition). */
export function surfaceGeneration(): number {
  return generation
}

/** The last committed transition (verb + generation + commit seq). */
export function lastSurfaceTransition(): SurfaceTransitionRecord {
  return lastTransition
}

/** SR-022's decline predicate: true when a decoded input event belongs to a
 *  PRIOR surface generation — it was constructed at or before the event that
 *  committed the current route and must be consumed/declined by the OLD
 *  surface's owners, never observed by the revealed one. Both the elevated
 *  surfaces (via their open-event gates) and the revealed root (via the
 *  chord/prompt dispatch gates) ride this one predicate. */
export function isPriorGenerationInput(eventSeq: number): boolean {
  return eventSeq <= lastTransition.commitSeq
}

/** The SESSION-ENTRY DECISION's input consumption for the leg that changes
 *  NO route (the split frame keeps the board and only the chat pane swaps —
 *  stay-in-split): the committing event and its chunk-mates must die at the
 *  decision exactly as a committing transition kills them, or a doubled ↵
 *  decoded in the same chunk replays into the revealed pane (the
 *  input-generation-leak class). Spelled here because input consumption is
 *  the route owner's law (input-event's consumer stays this module alone);
 *  a route-changing entry consumes through its own commit and never calls
 *  this. Note the divergence it leaves by design: isPriorGenerationInput
 *  reads the last COMMIT's stamp, so this no-transition consumption fences
 *  dispatch (the emitter break, the chunk law) without re-classing later
 *  events — the standing route's own handlers stay live. */
export function consumeEntryDecisionInput(): void {
  markInputConsumedThroughCurrentSeq()
}

function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a throwing subscriber never blocks the others */
    }
  }
}

export function subscribeSurfaceRoute(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function surfaceRouteVersion(): number {
  return version
}

export function currentSurfaceRoute(): SurfaceRoute {
  return current
}

function enter(target: SurfaceRoute): SurfaceTransition {
  if (surfaceRouteId(target) === surfaceRouteId(current)) {
    return { ok: false, code: 'already-current', reason: `already on ${surfaceRouteId(current)}` }
  }
  if (!routeSurfaceRegistered(target.kind)) {
    return {
      ok: false,
      code: 'surface-unregistered',
      reason: `the ${target.kind} surface is not registered in this build — the route exists as a typed target only`,
    }
  }
  const token: SurfaceReturnToken = { to: current, nonce: nextNonce++ }
  returnStack.push(token)
  const from = current
  current = target
  commitTransition('PUSH', from, target)
  bump()
  return { ok: true, token }
}

/** Verbs — every direction preserves the surfaces beneath (nothing here
 *  stops, restarts or recreates a worker/session). */
export function enterBootSettings(): SurfaceTransition {
  return enter({ kind: 'boot-settings' })
}

export function enterConcourse(): SurfaceTransition {
  return enter({ kind: 'concourse' })
}

export function enterSessionRepl(sessionId: string): SurfaceTransition {
  if (sessionId.length === 0) {
    return { ok: false, code: 'invalid-target', reason: 'a session route needs a session id' }
  }
  return enter({ kind: 'session', sessionId })
}

/** Return to the Concourse from a deeper surface. */
export function returnToConcourse(): SurfaceTransition {
  return enter({ kind: 'concourse' })
}

// ── THE BRIDGE: the chat route is the focused session's viewer ──────────────
//
//  The root REPL renders whatever session holds the focused slot and nothing
//  of its own — so the router routes there in exactly ONE state: a chat is
//  PRESENT (a session in the slot, or a landing in flight — the hop, the
//  birth and the resume doors re-point the slot, then flip the route here).
//  The armed-root-command state RETIRED WHOLE:
//  every face row now lands through the estate's own doors or a face-native
//  layer, and the one sessionless-REPL road left — a prompt argument on
//  argv — mounts the chat route through the resolver's explicit-journey
//  landing (initializeSurfaceRoute), never this verb. The IN-CHAT '/health'
//  and '/resume' dialogs stay the REPL's own. With the slot resting the
//  chat route is UNREACHABLE from here: home is no movement, a return
//  token onto it refuses, and the REPL's own yield (a dialog closed, a
//  refused birth) hands the frame back through settleAbsentChat — one
//  owner of "no chat ⇒ where the frame goes".

export type ChatEntry = { ok: true } | { ok: false; code: 'no-chat'; reason: string }

/** Jump home to the focused chat, unwinding every stacked surface (Esc at
 *  the Concourse top level returns to the exact root REPL, which was never
 *  unmounted). With no chat present nothing moves: there is no chat to go
 *  home to. */
export function enterRootRepl(): ChatEntry {
  if (!chatPresent()) {
    return { ok: false, code: 'no-chat', reason: NO_CHAT_HINT }
  }
  if (current.kind !== 'repl' || returnStack.length > 0) {
    const from = current
    current = ROOT_REPL_ROUTE
    returnStack = []
    commitTransition('HOME', from, ROOT_REPL_ROUTE)
    bump()
  }
  return { ok: true }
}

/** Leave the surface a transition entered, restoring the EXACT prior route.
 *  Single-use: only the top-of-stack token restores (a stale token from a
 *  superseded transition is refused — the route it captured is absent). A
 *  token onto the chat route restores only while a chat is present: the
 *  bridge that emptied meanwhile is not a route to return to. */
export function returnFromSurface(token: SurfaceReturnToken): { ok: boolean } {
  const top = returnStack[returnStack.length - 1]
  if (!top || top.nonce !== token.nonce) return { ok: false }
  if (top.to.kind === 'repl' && !chatPresent()) return { ok: false }
  returnStack.pop()
  const from = current
  current = top.to
  commitTransition('RETURN', from, top.to)
  bump()
  return { ok: true }
}

/** The bridge emptied under the REPL — the last chat closed from the chat
 *  (/clear whose fresh birth was refused) or a root command ended with no
 *  session (Doctor's card closed, the resume picker cancelled): the boot
 *  menu takes the frame (rule 5: close all chats ⇒ the boot face) as a
 *  landing with NOTHING beneath to return to — never a return token onto
 *  the empty chat, which the face's esc would only bounce off. A no-op
 *  while the REPL does not own the frame or a chat is present. */
export function settleAbsentChat(): { ok: boolean } {
  if (current.kind !== 'repl' || chatPresent() || !routeSurfaceRegistered('boot-settings')) return { ok: false }
  const from = current
  current = { kind: 'boot-settings' }
  returnStack = []
  commitTransition('PUSH', from, current)
  bump()
  return { ok: true }
}

/** The return token the CURRENT surface would restore through — the top of
 *  the stack (null on the root route). The mounted surface's own Esc path
 *  rides this so the opener needn't thread its token through the registry. */
export function activeReturnToken(): SurfaceReturnToken | null {
  return returnStack[returnStack.length - 1] ?? null
}

/** Esc-from-the-current-surface: restore the exact route beneath. */
export function leaveCurrentSurface(): { ok: boolean } {
  const top = activeReturnToken()
  return top ? returnFromSurface(top) : { ok: false }
}

// ── THE STRIP: the screens shift+←/→ walk, counted from what exists ─────────
//
//  Law 9 at the strip (the session is the unit; every screen is a view):
//  the chat is a BRIDGE a focused session is slotted into, not a screen of
//  its own — so the strip carries a chat stop exactly while a session holds
//  the slot (or a landing is in flight). A fresh boot has two stops,
//  [boot face] ⇄ [concourse]; the chat stop APPEARS when a session is
//  entered (New Session's ↵, ↵ on a board row, a resume) and VANISHES when
//  the last chat closes. `--chat`, and the persisted concourse switch off,
//  are THE PLAIN WORLD: [boot face] ⇄ [chat], no concourse stop in that
//  boot. Every move walks to the nearest PRESENT stop in its direction; an
//  absent target is no movement plus the dim hint the key-map rows already
//  paint — never a bounce, a flash or an empty chat screen. (A strip that
//  RESERVED the chat stop rubber-banded a bare boot off the empty REPL and
//  onto the boot face; that reserved third stop retires here.)

export type StripStop = 'boot-settings' | 'concourse' | 'repl'
/** Left → right, the operator's order: the boot face, the concourse, the chat. */
export const STRIP_ORDER: readonly StripStop[] = ['boot-settings', 'concourse', 'repl']

export interface StripFacts {
  /** The persisted concourse switch (`--concourse-off` clears it). */
  readonly concourseEnabled: boolean
  /** This boot is `--chat`: the plain world for its lifetime. */
  readonly chatBoot: boolean
  /** A session holds the focused slot, or a landing is in flight. */
  readonly chatPresent: boolean
}

/** The plain world: `--chat` for this boot, or the concourse switched off —
 *  one fact the two switches already carry (no third flag exists). */
export function chatOnlyBootOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): boolean {
  return facts.chatBoot || !facts.concourseEnabled
}

/** Pure: the stops present under the facts, in strip order — the menu
 *  always; the concourse iff the switch is on and this is not a chat boot;
 *  the chat iff a session is focused. */
export function stripStops(facts: StripFacts): StripStop[] {
  const stops: StripStop[] = ['boot-settings']
  if (facts.concourseEnabled && !facts.chatBoot) stops.push('concourse')
  if (facts.chatPresent) stops.push('repl')
  return stops
}

export type StripDirection = 'left' | 'right'
export type StripMove = { readonly to: StripStop } | { readonly to: null; readonly hint: string | null }

/** The one absence worth naming: a chat the operator may expect to the
 *  right. The strip's ends stay silent. */
export const NO_CHAT_HINT = 'no chat open'

/** Pure: where a move from `at` lands over the PRESENT stops — the nearest
 *  one in that direction; null (with the dim hint when the chat is what is
 *  missing) when none exists. The current screen need not be a stop itself:
 *  a live view opened through the face's row in the plain world walks from
 *  the concourse's position, a 'session' route from the same. */
export function stripMove(at: SurfaceKind, dir: StripDirection, present: readonly StripStop[]): StripMove {
  const from = STRIP_ORDER.indexOf(at === 'session' ? 'concourse' : at)
  const step = dir === 'right' ? 1 : -1
  for (let i = from + step; i >= 0 && i < STRIP_ORDER.length; i += step) {
    const stop = STRIP_ORDER[i]!
    if (present.includes(stop)) return { to: stop }
  }
  const chatMissingAhead = dir === 'right' && at !== 'repl' && !present.includes('repl')
  return { to: null, hint: chatMissingAhead ? NO_CHAT_HINT : null }
}

const STOP_NAMES: Readonly<Record<StripStop, string>> = { 'boot-settings': 'boot face', concourse: 'concourse', repl: 'chat' }

/** Pure: a key-map row's text for the screen `at` — ONLY the present moves,
 *  in the kit's lowercase key grammar, ' · '-joined; the absent chat to the
 *  right paints its dim hint. Empty when nothing moves either way. */
export function stripKeyMapHintOf(at: SurfaceKind, present: readonly StripStop[]): string {
  // Class 5: the chord spelling folds to the host's own (identity on macOS,
  // 'shift+←' words elsewhere) at this ONE composer — every strip row and
  // face key-map reads it from here.
  const parts: string[] = []
  const left = stripMove(at, 'left', present)
  if (left.to !== null) parts.push(`${keyHintLabel('⇧←')} ${STOP_NAMES[left.to]}`)
  const right = stripMove(at, 'right', present)
  if (right.to !== null) parts.push(`${keyHintLabel('⇧→')} ${STOP_NAMES[right.to]}`)
  else if (right.hint !== null) parts.push(`${keyHintLabel('⇧→')} ${right.hint}`)
  return parts.join(' · ')
}

// The chat-presence seam. The slot module (engine-connector/focusedConnector)
// is not imported here: its static graph reaches the concourse supervisor,
// and the resolver's Off path carries zero supervisor modules — so the face
// registers the slot's read where the route surfaces register (the
// SurfaceRouter module's side effect). Until a seam registers, no chat
// exists. The router re-emits on every presence change so the strip's
// consumers (the key-map rows, the router face) repaint from one store.
export interface ChatPresenceSeam {
  present: () => boolean
  subscribe: (listener: () => void) => () => void
}
let chatPresence: ChatPresenceSeam | null = null
let unsubscribeChatPresence: (() => void) | null = null
export function registerChatPresence(seam: ChatPresenceSeam): () => void {
  unsubscribeChatPresence?.()
  chatPresence = seam
  unsubscribeChatPresence = seam.subscribe(bump)
  bump()
  return () => {
    if (chatPresence !== seam) return
    unsubscribeChatPresence?.()
    unsubscribeChatPresence = null
    chatPresence = null
    bump()
  }
}

/** Is a chat on the strip — a session in the slot or a landing in flight? */
export function chatPresent(): boolean {
  return chatPresence?.present() ?? false
}

// The `--chat` fact: main.tsx marks it once at launch classification; it
// holds for the process lifetime (the plain world never re-grows a concourse
// stop mid-boot).
let chatBoot = false
export function markChatBoot(): void {
  chatBoot = true
  bump()
}

/** The plain world for THIS boot: `--chat`, or the concourse switched off. */
export function chatOnlyBoot(): boolean {
  return chatOnlyBootOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

/** WHY this boot is the plain world, in the operator's own spellings — the
 *  `--chat` mark, the saved switch off, or both (`--chat` over a saved off
 *  is no contradiction: both are the plain world). Null in the fleet
 *  world. Pure over the two facts. */
export type PlainWorldWhy = '--chat' | 'concourse off' | '--chat · concourse off'
export function plainWorldWhyOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): PlainWorldWhy | null {
  if (facts.chatBoot && !facts.concourseEnabled) return '--chat · concourse off'
  if (facts.chatBoot) return '--chat'
  if (!facts.concourseEnabled) return 'concourse off'
  return null
}
export function plainWorldWhy(): PlainWorldWhy | null {
  return plainWorldWhyOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

/** THE PLAIN WORLD'S ONE SENTENCE — why the Session Concourse is off in
 *  this boot and the way back — for every surface that must say so (a
 *  concourse-only command typed, the face's row, /status, /config). The
 *  saved switch off names `--concourse-on` (or /config); a `--chat` boot
 *  with the switch on names the plain boot that has it. Null in the fleet
 *  world. */
export function concourseOffSentenceOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): string | null {
  const why = plainWorldWhyOf(facts)
  if (why === null) return null
  return `the Session Concourse is off in this boot (${why}) — ${concourseWayBackOf(facts)}`
}
export function concourseOffSentence(): string | null {
  return concourseOffSentenceOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

/** THE WAY BACK, in one place: with the saved switch off it is the switch
 *  (`--concourse-on` or /config); with the switch on the plain world is this
 *  boot's `--chat` alone, so the next plain boot has the concourse. */
export function concourseWayBackOf(facts: Pick<StripFacts, 'concourseEnabled'>): string {
  return facts.concourseEnabled ? 'a plain `mercury` boot has it' : '`mercury --concourse-on` or /config turns it back'
}
export function concourseWayBack(): string {
  return concourseWayBackOf({ concourseEnabled: concourseEnabled() })
}

/** The live facts, read at call time — never a cached capability guess. */
export function stripFacts(): StripFacts {
  return { concourseEnabled: concourseEnabled(), chatBoot, chatPresent: chatPresent() }
}

/** The stops present NOW: the facts' stops, minus any surface this build
 *  never registered (an absent screen is never a stop; the root 'repl' kind
 *  is structural). */
export function presentStripStops(): StripStop[] {
  return stripStops(stripFacts()).filter(stop => routeSurfaceRegistered(stop))
}

/** The key-map row's text for the CURRENT screen (the face and the board
 *  paint this; it changes exactly when a stop appears or vanishes). */
export function stripKeyMapHint(): string {
  return stripKeyMapHintOf(current.kind, presentStripStops())
}

export type StripOutcome = { ok: true; moved: boolean; hint: string | null } | { ok: false; reason: string }

/** The surface chords move along the strip: `dir` +1 walks toward the boot
 *  menu (the operator's LEFT; the ctrl+pgdn order REPL → Concourse → Boot
 *  Settings), -1 toward the chat (RIGHT). The move lands on the nearest
 *  PRESENT stop or does not move at all — `moved: false` with the hint the
 *  key-map rows already show, so a caller paints nothing and the frame
 *  stays byte-still. Mechanically HOME + PUSH with an empty return stack, so
 *  esc from any cycled-to surface stays the one-hop root return.
 *
 *  CB-10: the strip refuses on a non-fullscreen boot — the route surfaces
 *  mount an absolute full-viewport host that an inline (MERCURY_FULLSCREEN=0)
 *  boot has no frame for (the driven inline capture settled boot-settings as
 *  a torn fragment). ONE guard site covers both chord pairs, with the same
 *  honest refusal grammar /bootmenu and /concourse speak; the env read is
 *  live per call. Callers surface a refusal as a transient note. */
export function cycleSurface(dir: 1 | -1): StripOutcome {
  if (!isFullscreenEnvEnabled()) {
    return {
      ok: false,
      reason:
        'the surface strip needs the fullscreen surface (MERCURY_FULLSCREEN=0 boots have no frame to claim) — the standalone Boot Menu on the next launch carries the same rows',
    }
  }
  const move = stripMove(current.kind, dir === 1 ? 'left' : 'right', presentStripStops())
  if (move.to === null) return { ok: true, moved: false, hint: move.hint }
  // ONE DIRECT COMMIT: cycling is a root-level surface SWITCH — one
  // transition record, one store bump, no intermediate REPL commit between
  // an unwind and a second entry (the ledger and any same-chunk input
  // watermark saw two hops; a subscriber tearing between them saw the root
  // flash).
  const from = current
  current = move.to === 'repl' ? ROOT_REPL_ROUTE : ({ kind: move.to } as SurfaceRoute)
  returnStack = []
  commitTransition(move.to === 'repl' ? 'HOME' : 'PUSH', from, current)
  bump()
  return { ok: true, moved: true, hint: null }
}

// ── the initial-target resolver (the MERCURY_CONCOURSE consumer) ─────

export type ConcoursePolicy = 'off' | 'auto' | 'always'

/** The registered MERCURY_CONCOURSE flag's closed value grammar. Unknown
 *  values resolve to 'off' (never a guessed capability). Spelling order rides
 *  the registry (canonical wins); the env param is the proof-injection seam. */
export function resolveConcoursePolicy(env: NodeJS.ProcessEnv = process.env): ConcoursePolicy {
  let raw: string | undefined
  for (const spelling of flagSpellings('MERCURY_CONCOURSE')) {
    raw = env[spelling]
    if (raw !== undefined) break
  }
  return raw === 'auto' || raw === 'always' ? raw : 'off'
}

export interface InitialSurfaceResolution {
  /** What the policy asked for. */
  requested: SurfaceRoute
  /** What the router will actually mount (requested ∩ registered). */
  effective: SurfaceRoute
  policy: ConcoursePolicy
  /** Typed decision trail — the honesty surface. */
  reason:
    | 'concourse-off'
    | 'always'
    | 'auto-live-sessions'
    | 'auto-needs-you'
    | 'auto-idle'
    | 'splash-intent'
    | 'face-door-intent'
    | 'boot-menu-landing'
    | 'concourse-surface-unregistered'
  /** The bounded summary fact the decision read (auto only). */
  liveWorkers?: number
}

/**
 * Resolve the surface the runtime should boot into: reads ONLY the
 * registered flag and — for Auto — the bounded atomic supervisor summary
 * (the durable worker records; never a daemon RPC, never fleet discovery,
 * never a transcript/PID/provider enumeration). With the policy Off the
 * Concourse subsystem is not even imported (the Off path carries zero
 * supervisor modules — the import below is dynamic and policy-gated).
 *
 * Auto's condition today is the live/nonterminal session count (>1 enters
 * the Concourse). The needs-you/ready-to-review arm of Auto joins in
 * when durable attention obligations exist to read.
 */
export async function resolveInitialSurface(
  opts: { env?: NodeJS.ProcessEnv; recordsDir?: string } = {},
): Promise<InitialSurfaceResolution> {
  // THE CONCOURSE STOP gates the policy: a boot whose strip has no concourse
  // stop (the persisted switch off, or `--chat` — the plain world) never
  // auto-enters it, whatever the env says — the policy reads 'off'. The
  // live view of a switched-off concourse keeps its explicit doors (the
  // face's row, /concourse), never a landing.
  const policy = stripStops(stripFacts()).includes('concourse') ? resolveConcoursePolicy(opts.env) : 'off'
  // RFI-3: the splash's typed boot-surface
  // intent resolves BEFORE the policy read and before the first visible
  // commit — the retired argv-splice executed post-paint and flashed the
  // un-navigated Main REPL (the operator's binding capture). One-shot
  // (consume-on-read); the concourse direction stays fullscreen-gated like
  // the /concourse command, and the existing registered-check downgrade
  // still guards an absent surface. NEW-2 (amended): an
  // explicit CONTINUE choice records 'repl' and outranks a
  // policy-always/auto-live Concourse — the operator's chosen conversation
  // owns the first frame (ambient policy never eats an explicitly chosen
  // journey); the splash's DOCTOR and RESUME picks carry the same outrank
  // through the face-door deep-link arm below.
  // THE LANDING RULE (the boot
  // menu everywhere). Every interactive fullscreen boot with no explicit
  // journey lands on the Boot face — whichever door it came through, the
  // launcher's handoff or a direct `node dist/mercury.mjs`, Mac or Windows.
  // What outranks it is exactly what outranks it today: an argv-explicit
  // journey (--continue / --resume / --from-pr / a prompt —
  // markExplicitBootJourney), a splash pick of continue (the 'repl'
  // intent), doctor/resume (the face-door deep-link — the face IS the
  // landing, sub-view open) or concourse (the 'concourse' intent), a
  // MERCURY_CONCOURSE always/auto-live policy; a non-fullscreen boot (CB-10)
  // or an unregistered face degrades to the root REPL as today.
  let bootMenuArmed = false
  try {
    const handover = await import('../substrate/splashHandover.js')
    const { isFullscreenEnvEnabled } = await import('../utils/fullscreen.js')
    const intent = handover.consumeBootSurfaceIntent()
    if (intent === 'repl') {
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      return { requested: ROOT_REPL_ROUTE, effective: ROOT_REPL_ROUTE, policy, reason: 'splash-intent' }
    }
    if (intent === 'concourse' && isFullscreenEnvEnabled()) {
      const requested: SurfaceRoute = { kind: 'concourse' }
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      if (!routeSurfaceRegistered('concourse')) {
        return { requested, effective: ROOT_REPL_ROUTE, policy, reason: 'concourse-surface-unregistered' }
      }
      return { requested, effective: requested, policy, reason: 'splash-intent' }
    }
    // Way A (operator-ruled): a splash doctor/resume pick
    // rides a FACE-DOOR deep-link — the boot lands the Boot face with its
    // own sub-view armed, OUTRANKING a policy-always/auto-live Concourse
    // (the NEW-2 law: ambient policy never eats an explicitly chosen
    // journey). The resolver only PEEKS — the face consumes the one-shot
    // at mount. A non-fullscreen boot or an unregistered face falls
    // through to today's roads exactly (CB-10 degrade); the armed one-shot
    // then waits for whichever face mounts first (the kit precedent).
    if (handover.peekFaceDoorDeepLink() !== null && isFullscreenEnvEnabled() && routeSurfaceRegistered('boot-settings')) {
      const requested: SurfaceRoute = { kind: 'boot-settings' }
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      return { requested, effective: requested, policy, reason: 'face-door-intent' }
    }
    bootMenuArmed = !handover.bootJourneyIsExplicit() && isFullscreenEnvEnabled() && routeSurfaceRegistered('boot-settings')
  } catch {
    /* a torn handover module never blocks boot — fall through to policy */
  }
  const bootMenuLanding = (): InitialSurfaceResolution => {
    const requested: SurfaceRoute = { kind: 'boot-settings' }
    void import('../substrate/launchMilestones.js')
      .then(m => m.recordLaunchMilestone('route-ready'))
      .catch(() => {})
    return { requested, effective: requested, policy, reason: 'boot-menu-landing' }
  }
  if (policy === 'off') {
    if (bootMenuArmed) return bootMenuLanding()
    return { requested: ROOT_REPL_ROUTE, effective: ROOT_REPL_ROUTE, policy, reason: 'concourse-off' }
  }
  const concourse: SurfaceRoute = { kind: 'concourse' }
  const settle = (requested: SurfaceRoute, reason: InitialSurfaceResolution['reason'], liveWorkers?: number): InitialSurfaceResolution => {
    // The settle IS route-ready — every exit records the
    // milestone exactly once per process (fail-soft; telemetry only).
    void import('../substrate/launchMilestones.js')
      .then(m => m.recordLaunchMilestone('route-ready'))
      .catch(() => {})
    if (requested.kind !== 'repl' && !routeSurfaceRegistered(requested.kind)) {
      return {
        requested,
        effective: ROOT_REPL_ROUTE,
        policy,
        reason: 'concourse-surface-unregistered',
        ...(liveWorkers !== undefined ? { liveWorkers } : {}),
      }
    }
    return { requested, effective: requested, policy, reason, ...(liveWorkers !== undefined ? { liveWorkers } : {}) }
  }
  if (policy === 'always') return settle(concourse, 'always')
  // Auto: one records read (validated, fail-soft-to-empty), pid-alive count.
  let live = 0
  try {
    const supervisor = await import('../daemon/concourseSupervisor.js')
    live = supervisor.countLiveConcourseWorkers(opts.recordsDir)
  } catch {
    live = 0 // a torn/absent summary renders the honest idle answer, never blocks boot
  }
  if (live > 1) return settle(concourse, 'auto-live-sessions', live)
  // The second Auto fact: a waiting question (needs-you) enters even with
  // one/zero live workers — the durable obligations store is the same
  // bounded-atomic-read class as the records summary (one JSON, fail-soft).
  try {
    const obligations = await import('../services/crew/obligations.js')
    const open = await obligations.openObligations({ scope: 'switchboard' })
    if (open.length > 0) return settle(concourse, 'auto-needs-you', live)
  } catch {
    // a torn/absent obligations store never blocks boot
  }
  // Auto found nothing to show — the Boot face is the landing (auto-LIVE
  // outranks the menu; auto-idle falls to it).
  if (bootMenuArmed) return bootMenuLanding()
  return settle(ROOT_REPL_ROUTE, 'auto-idle', live)
}

/** Mount-time seeding (launchRepl): adopt the resolver's EFFECTIVE route as
 *  the starting point without minting a return token — there is nothing to
 *  return to before the first surface. */
export function initializeSurfaceRoute(initial: SurfaceRoute): void {
  const from = current
  current = routeSurfaceRegistered(initial.kind) ? initial : ROOT_REPL_ROUTE
  returnStack = []
  commitTransition('INIT', from, current)
  bump()
}

/** Proof seam — route state is process-lifetime (the strip's facts too: the
 *  chat boot mark and the presence seam reset with it). */
export function _resetSurfaceRouteForTesting(): void {
  current = ROOT_REPL_ROUTE
  returnStack = []
  registry.clear()
  generation = 0
  lastTransition = { verb: 'INIT', from: 'repl', to: 'repl', generation: 0, commitSeq: 0 }
  unsubscribeChatPresence?.()
  unsubscribeChatPresence = null
  chatPresence = null
  chatBoot = false
  bump()
}
