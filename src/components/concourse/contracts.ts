// ============================================================================
//  concourse/contracts — the ONE atomic snapshot the
//  Session Concourse renders from (header, rail,
//  groups, Peek, status rail and every external projection agree within one
//  paint because they are ONE object). Pure data — no store reads in the
//  render tree; the LIVE builder (concourseSnapshot.ts) folds the real
// owners into this shape, and the seeded scenario renders the fixture
//  through the SAME contract.
// ============================================================================

/** Typed lifecycle vocabulary — never free strings in the UI.
 * adds 'attached': the operator's terminal owns the
 *  session (the daemon child yielded); the board row reads "with you".
 *  'parked' (the concourse is the control plane and shows the current
 *  project's chats — Law 9, rule 4): a chat of the current project with NO
 *  runner — the session store remembers it; ↵ reactivates it in place
 *  through the estate's one resume door. */
export type ConcourseLifecycleLabel =
  | 'draft'
  | 'queued'
  | 'starting'
  | 'working'
  | 'needs-you'
  | 'stalled'
  | 'ready-to-review'
  | 'paused'
  | 'attached'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'parked'
  /** A DOOR ROW, not a session (cross-project awareness, law 4): another
   *  project's running-count line — "N running in foo" — whose ↵ switches
   *  the board's VIEW to that project (the REPO picker's own path) and
   *  whose sessions then appear as the live rows they always were. */
  | 'elsewhere'

/** ANOTHER PROJECT WITH ACTIVITY (law 4): the daemon's roster grouped by
 *  the catalog's project key — one owner (services/concourse/
 *  projectActivity) feeds the board's lines and the Boot face's rows. */
export interface ConcourseElsewhereV1 {
  /** The project's folder (a record's origin workspace) — the door's target. */
  dir: string
  /** The catalog's identity key (the session-store dir) — the stable row key. */
  key: string
  name: string
  /** Live runners (working · starting · ready-to-review · attached). */
  running: number
  /** Open asks and crashes waiting on the operator. */
  needsYou: number
  /** Turns settled and not yet reviewed. */
  finished: number
}

export interface ConcourseRowV1 {
  /** The runtime SessionId — THE stable row key (never index/title). */
  sessionId: string
  /** descriptor.ts one-title-renderer projection. */
  title: string
  state: ConcourseLifecycleLabel
  projectLabel: string
  /** Typed accountable-participant projection; null paints '—'. */
  ownerLabel: string | null
  ageLabel: string | null
  /** THE RECORD'S MODEL (the credential wall's row-receipt input, ledger
   *  L25 / L23's inline arm): the session's model id as its record carries
   *  it, so the live composer's gate can name the family a send would fail
   *  on. Present on record-backed rows; a dispatch, door or older row has
   *  none. Never painted. */
  modelId?: string
  /** null paints '—'; 'waits' is the queued row's honest seat cell. */
  seats: { held: number; ceiling: number } | 'waits' | null
  /** (the NOW cell): the session's latest activity in
   *  plain words — the transcript tail's own truth ("Bash: npm test",
   *  "settling", "waits"); null/absent paints nothing. */
  nowLabel?: string | null
  /** W3: the ONE standing workflows-allowed tag (plain
   *  "· workflows allowed" after the project cell). */
  workflowsAllowed?: boolean
  /** SATURN (the banked spec's concourse surfacing): the session's soonest
   *  standing fire, read through the landed projection
   *  (saturnSoonestFireMs — paused rows never count). Present exactly when
   *  a future fire stands; the paint composes the words. */
  scheduleNextFireMs?: number
  /** The session's canonical workspace root — the mirror derives the
   *  transcript home from THIS (the W0.1 home law's reader input). */
  workspaceDir?: string
  /** the fork's daemon-minted branch — the PROJECT cell
   *  leads with the branch glyph when present; the full name paints only in
   *  the entered view and waiting room (one home). */
  worktreeBranch?: string
  /** WHY a queued row waits — 'seat' and 'repo-held' are
   *  different truths; every surface branches on this, never on prose. */
  waitReason?: 'seat' | 'repo-held' | 'session-paused' | 'no-repository' | 'git-unavailable' | 'unborn-head' | 'unblocked'
  /** The repo-held holder's title (plain words beside the reason). */
  waitDetail?: string
  /** A PARKED row's transcript — the resume door's input (the same file
   *  the Boot face's Projects-↵ hands focusResumedSession). Present
   *  exactly on parked rows. */
  transcriptPath?: string
  /** THE ★ CARRY-OVER (cross-project awareness, law 2): present exactly on
   *  the FOCUSED session's row when it belongs to another project than the
   *  board's — that project's name. The board filters by project, then
   *  always adds the one focused session, wherever it lives: the row wears
   *  ✦ "from <name>" beside its title, keeps its own state and NOW cell
   *  (live or parked), and ↵ / shift+→ enter it as ever. Focusing a session
   *  of the current project hands it back SILENTLY (law 3): the next
   *  snapshot simply no longer derives it — no notice, no state change. */
  foreignProject?: string
  /** THE DOOR (law 4): present exactly on 'elsewhere' rows. 'switch-project'
   *  carries the project to switch the view to and its counts; 'pick-project'
   *  is the honest "+N more" line whose ↵ opens the REPO picker (the one
   *  switcher — never a second one). A door row has no workspace, no
   *  runner, no tile subscription: ↵ moves your eyes, nothing else. */
  door?:
    | { kind: 'switch-project'; dir: string; running: number; needsYou: number; finished: number }
    | { kind: 'pick-project'; more: number }
}

/** The ONE queued-wait copy home — the NOW cell, the mirror
 *  placeholder, and the composer note all speak through this. The
 *  distinctive word leads so 80-col truncation stays legible. */
export function concourseWaitCopy(reason?: string, byTitle?: string): string {
  switch (reason) {
    case 'repo-held':
      return `repo held by ${byTitle ?? 'a live session'}`
    case 'unblocked':
      return 'unblocked — replay starts it'
    case 'session-paused':
      return 'held — the target is paused'
    case 'no-repository':
    case 'unborn-head':
      return 'needs git — say yes to the offer'
    case 'git-unavailable':
      return 'needs git installed'
    default:
      return 'waits for a seat'
  }
}

export interface ConcourseSnapshotV1 {
  schema: 1
  /** State revision — the dedup/idempotent-repaint key. */
  revision: number
  /** 'HH:MM:SS' — ONE time owner; every derived age reads it. */
  clock: string
  context: { projectLabel: string; operatorHandle: string; effortLabel?: string }
  breadcrumb: { active: 'boot' | 'concourse' | 'main-repl' }
  coordinator: {
    mode: 'off' | 'rules-only' | 'agent-assisted'
    /** Display projection (a GPT_DISPLAY_PINS seed is lawful — display only). */
    assistModelLabel?: string
    /** The chosen model's truthful label when it is not 'ready' (not signed
     *  in · provider unavailable · not in the catalogue — credential and
     *  catalogue facts only, the verdict-word removal), typed and spelled —
     *  the lane still runs on it; the wire decides the turn. */
    assistModelAvailability?: import('../../services/concourse/coordinatorModels.js').CoordinatorModelAvailability
    assistModelStatus?: string
    /** Present exactly when effective ≠ requested (the resolver's typed
     *  downgrade reason, snapshot-carried; the chip paints it). */
    fallbackReason?: string
  }
  /** (the no-hidden-sixth-chat law): the host's parked root REPL, disclosed
   *  in the ONE snapshot contract. While the concourse owns the frame the
   *  host REPL is a PARKED NON-MODEL CONTROLLER — RouteSurfaceHost claims
   *  the input path and every provider submission this surface offers
   *  reaches a WORKER (the composer dispatches, the attached composer
   *  redirects) — so the root is visibly excluded from the live/seat math
   *  (counted:false is a statement, not an omission) and reachable through
   *  the legend's own 'esc focused chat'. A model-capable root would have to
   *  join as a counted board row; this field makes the hidden-sixth-chat
   *  state inexpressible silently. */
  mainRepl: {
    kind: 'non-model-controller'
    counted: false
    submission: 'disabled-while-parked'
    reachedBy: 'esc'
  }
  /** From ONE supervisor snapshot, never derived in the UI. */
  counts: {
    live: number
    needsYou: number
    working: number
    queued: number
    seatsHeld: number
    /** Σ per-session recorded ceiling (seatsMax ?? 2) over live +
     *  (agent-assisted coordinator ? 1 : 0). */
    seatsDenominator: number
    admission: 'auto-balanced' | 'fixed'
  }
  needsYou: Array<{
    obligationId: string
    sessionId: string
    title: string
    question: string
    projectLabel: string
    agentLabel: string
    ageLabel: string
    /** The obligation's idempotency ref — a `permission:<requestId>` ref is
     *  a parked PERMISSION ask (Q2): the answer is y/n through the
     *  answer-permission door, never a typed message. A
     *  `cross-project:finished:` ref is the finished-elsewhere kind (law 5). */
    ref?: string
    /** THE CROSS-PROJECT PING IS A DOOR (law 5): present when the asking
     *  session belongs to ANOTHER project than the board's — the row reads
     *  "switch to <name> · needs you / finished" and ↵ switches the view to
     *  that project and focuses the session (once per need, never a nag). */
    foreignProject?: { dir: string; name: string }
  }>
  /** Upstream: the crew inbox's ONE comparator order (buckets).
   * adds 'attached' (WITH YOU — the sessions this terminal
   *  owns through an attach). 'elsewhere' (OTHER PROJECTS — the per-project
   *  door lines, law 4) sits AFTER every live group of the current project
   *  and BEFORE 'parked'. 'parked' is ALWAYS the last group: the current
   *  project's parked chats sit BENEATH every live row, never above one. */
  groups: Array<{
    id: 'attached' | 'needs-you' | 'stalled' | 'ready-to-review' | 'working' | 'queued' | 'starting' | 'paused' | 'stopped' | 'elsewhere' | 'parked'
    label: string
    rows: ConcourseRowV1[]
  }>
  /** EVERY other project with activity (law 4), most active first — the
   *  board paints the first ELSEWHERE_CAP as door lines and folds the rest
   *  into "+N more"; the coordinator and the pins read the whole list.
   *  Absent on fixtures that predate it. */
  elsewhere?: ConcourseElsewhereV1[]
  peek: null | {
    sessionId: string
    title: string
    state: ConcourseLifecycleLabel
    projectLabel: string
    agentLabel: string
    modelLabel: string
    seats: { held: number; ceiling: number } | null
    /** Bounded, newest-last. */
    timeline: Array<{ clock: string; label: string }>
    scope: { kind: 'clear' } | { kind: 'overlap'; detail: string }
    actions: Array<'enter-full-session' | 'pause-after-turn' | 'redirect' | 'resume'>
    /** (IDENTITY-ATOMIC): the session's IMMUTABLE settings
     *  capture vs the live profile — `current` is false when the profile
     *  moved on after this session was admitted (a Boot edit reaches new
     *  sessions only; the peek distinguishes both). Absent when the record
     *  predates the capture (fixtures, legacy rows) — never fabricated. */
    settings?: { revisionLabel: string; profileRevision: number; current: boolean }
    /** The peeked session's identity color (the resident's shell binding —
     * absent ⇒ the accentSoft fallback at the render site). */
    identityColor?: string
    /** the resident's event-bound state. AT-03: 'held' is the
     *  admission-queue truth — never conflated with 'refused'. */
    residentState: 'settled' | 'empty' | 'wink' | 'refused' | 'molt' | 'held'
    /** AT-02: the KERNEL's own refusal/hold diagnosis — the caption paints
     *  THIS, never a fabricated seats story. */
    residentReason?: string
  }
  newSession: {
    seeds: {
      projectLabel: string
      agentLabel: string
      modelLabel: string
      /** The RESOLVED canonical model id the chip's label names — submit
       *  sends THIS when no explicit override exists, so the daemon can
       *  never silently substitute its own (possibly divergent) default. */
      modelId: string
      /** True when the seed resolves to the registry default (operator
       * the thrice-painted model name): the strip paints the
       *  model chip only when FOCUSED for editing or non-default — the
       *  status rail is the one always-on model location. */
      modelIsDefault: boolean
      /** Operator: the per-session effort seed — the daemon
       *  convention ('high') when unset; same exception-paint rule. */
      effortLevel: string
      effortIsDefault: boolean
      isolation: 'isolated-worktree' | 'exclusive' | 'shared-read-only'
      seatsMax: 1 | 2
    }
    /** Durable draft projection. */
    draft: string
    /** the durable cursor into the draft — restored on compose
     *  re-entry after routing/resize/restart (absent ⇒ end of text). */
    draftCaret?: number
    /** The AVAILABLE worker-model rows from the ONE callable-model owner
     * the model chip cycles exactly these. */
    modelOptions?: Array<{ modelId: string; displayName: string }>
    /** B4: the '› advanced' chip paints ONLY when the affordance
     *  is real — the live builder omits this while openAdvanced is a stub
     * (dead controls are banned on the live surface); the fixture
     *  sets it (the frozen reference frame keeps its chip). */
    advancedAvailable?: boolean
    /** The advanced editor's title seed (durable; rides op.title). */
    titleSeed?: string
    /** The dispatch PREVIEW — the deterministic start
     *  gate's verdict for the CURRENT draft, before any provider use.
     *  Present only while a draft exists; refusals are bounded reasons the
     *  strip paints in place of the seed segments (same geometry). */
    preflight?: { ok: boolean; refusals: string[] }
  }
}

/** The board-row union the panes render: group headers interleave as
 *  unavailable rows (the ONE availability policy walks straight across). */
export type ConcourseBoardRow =
  | { kind: 'group'; id: string; label: string; count: number }
  | { kind: 'session'; row: ConcourseRowV1 }

export function boardRowsOf(snapshot: ConcourseSnapshotV1): ConcourseBoardRow[] {
  const out: ConcourseBoardRow[] = []
  for (const g of snapshot.groups) {
    out.push({ kind: 'group', id: g.id, label: g.label, count: g.rows.length })
    for (const row of g.rows) out.push({ kind: 'session', row })
  }
  return out
}

/** STABLE-ID-SELECTION: where the board cursor lands when the
 *  selected session id survives (itself) or vanishes (the same clamped
 *  POSITION — the useStableSelection law over the id-keyed walk list). Pure
 *  so the reorder/lifecycle property is provable off-screen. */
export function stableSelectionFallback(
  ids: readonly string[],
  sel: string | null,
  lastIdx: number,
): { sessionId: string | null; index: number } {
  const at = sel === null ? -1 : ids.indexOf(sel)
  if (at >= 0) return { sessionId: sel, index: at }
  if (ids.length === 0) return { sessionId: null, index: 0 }
  const index = Math.min(lastIdx, ids.length - 1)
  return { sessionId: ids[Math.max(0, index)] ?? null, index: Math.max(0, index) }
}

/** + the H displayed-target law: the peek the operator SEES.
 *  When the SELECTED row names a session the store peek does not yet carry
 *  (the async rebuild window live; static fixture snapshots forever), the
 *  pane derives the row's OWN facts and paints the honest '—' for the deeper
 *  facts only the rebuilt snapshot carries — identity never diverges, and
 *  facts never borrow another session's timeline. Layout paint, cursor
 *  bounds and the ACTION EXECUTOR all consume THIS one pure derivation, so a
 *  displayed action always targets the displayed session at the displayed
 *  snapshot revision — the store peek alone must never be an action target. */
export function deriveEffectivePeek(
  storePeek: ConcourseSnapshotV1['peek'],
  sessionRows: readonly ConcourseRowV1[],
  selectedId: string | null,
): ConcourseSnapshotV1['peek'] {
  const selRow = selectedId !== null ? sessionRows.find(r => r.sessionId === selectedId) : undefined
  if (storePeek === null || selRow === undefined || storePeek.sessionId === selRow.sessionId) return storePeek
  return {
    sessionId: selRow.sessionId,
    title: selRow.title,
    state: selRow.state,
    projectLabel: selRow.projectLabel,
    agentLabel: selRow.ownerLabel ?? 'Mercury',
    modelLabel: '—',
    // A row's 'waits' seat label has no numeric shape — the transient peek
    // paints the honest '—' until the rebuilt snapshot lands.
    seats: typeof selRow.seats === 'string' ? null : selRow.seats,
    timeline: [],
    scope: { kind: 'clear' as const },
    actions: [
      // a QUEUED row
      // IS enterable now — ↵ opens its waiting room (stack messages, watch
      // it promote). One enter truth again, in the other direction.
      'enter-full-session' as const,
      // R7 C-LOW-3: ready-to-review means "give it the next instruction" —
      // it must not lose pause/redirect on the derived-peek surface.
      ...(selRow.state === 'working' || selRow.state === 'needs-you' || selRow.state === 'ready-to-review'
        ? (['pause-after-turn', 'redirect'] as const)
        : []),
      ...(selRow.state === 'paused' ? (['resume'] as const) : []),
    ],
    residentState: 'settled' as const,
  }
}

/** Every action the surface can take — receipts upstream; the UI never
 *  mutates state itself. */
/** the per-control receipt state — painted BESIDE the originating
 *  control (peek action rows, the composer strip). 'pending' holds while
 *  the op is in flight; the settled states echo the kernel receipt and
 *  clear after a short beat.
 *
 *  AT-01/03/05: the vocabulary is
 *  the FIVE-state protocol — pending | applied | held | refused | failed
 *  (idle = no note) — and a note may carry the kernel's OWN diagnosis:
 *  `reason` paints verbatim beside the control (never a fabricated
 *  caption), `next` names one immediately actionable step. 'held' is the
 *  admission-queue truth (its replay is the designed re-admission door —
 *  NEVER painted as a refusal); 'failed' is transport/defect (retryable),
 *  distinct from a provider/kernel refusal; a kernel 'noop' paints as
 *  applied WITH its no-change reason. Bare-word shorthand stays legal at
 *  call sites; consumers normalize through controlNoteOf. */
export type ControlNoteKind = 'pending' | 'applied' | 'held' | 'refused' | 'failed'
export interface ControlNote {
  state: ControlNoteKind
  reason?: string
  next?: string
}
export type ControlNoteState = ControlNoteKind | ControlNote

export const controlNoteOf = (n: ControlNoteState): ControlNote =>
  typeof n === 'string' ? { state: n } : n

export interface ConcourseCallbacks {
  enterSession: (sessionId: string) => void
  /** THE OLDER-CHATS BROWSE (L20): reactivate one of the census's older
   *  chats — a record-less transcript picked from the board's in-place
   *  drop-down — through the estate's ONE resume door (the same
   *  focusResumedSession leg a parked row's ↵ rides; the fact travels
   *  because no board row carries it). Optional: fixture wirings and
   *  stages without the door resume nowhere. */
  resumeOlderChat?: (sessionId: string, transcriptPath: string, title: string) => void
  /** THE NEW SESSION TAB (Law 9, rule 4): birth a blank session through the
   *  one birth door in the current harness ground and focus the chat — the
   *  boot face's New Session, from the board. Optional: fixture wirings and
   *  the reduced stage carry no door (and paint no tab). `contractText`
   *  (the offer's Yes leg, coordinator-tooling T2): the words the session
   *  births under — set as its advisory contract draft through the daemon's
   *  one contract verb right after the admit; absent = a plain birth. */
  newSession?: (opts?: { contractText?: string }) => void
  /** Item 5 (the queued-void ruling): the deliver-on-start room is an
   *  EXPLICIT door only — 'm' on a queued row (and the rail's 'open
   *  session' on a queued question) opens it; the default ↵ paints the
   *  in-place queued line instead. Optional: fixture wirings open nowhere. */
  openQueuedRoom?: (sessionId: string) => void
  /** Daemon-start OFFER: a dispatch that finds NO
   *  daemon (ENOCONN — the socket does not exist) arms an offer instead of
   *  a dead-end failure; the screen routes y/n while armed. y spawns the
   *  owned daemon and REPLAYS the same request (the kept identity makes the
   *  retry exact); n keeps the draft with the honest manual copy. Optional:
   *  fixture wirings dispatch nowhere. */
  daemonOfferArmed?: () => boolean
  answerDaemonOffer?: (yes: boolean) => void
  /** receipts beside controls: the screen can surface a typed refusal
   *  for a control it must guard itself (e.g. ↵ on a QUEUED board row) —
   *  the route owns the note store. Optional: fixtures without it simply
   *  paint no note. */
  noteControl?: (control: string, state: ControlNoteState) => void
  /** Board→Peek stable-ID follow: selection rebuilds the peek for
   *  this session WITHOUT entering it — the live path's setPeek; the fixture
   *  path derives at the screen. */
  peekSession: (sessionId: string) => void
  /** (the H answer law): the COLLECTED typed answer travels with the
   *  settle intent — delivery to the exact session precedes the settle, and
   *  only the delivery receipt settles the exact obligation. */
  answerObligation: (obligationId: string, answer: string) => void
  /** Q2 (the ask-wire): answer a parked permission ask — allow echoes the
   *  original input back through the child's control channel; the
   *  obligation settles daemon-side. THE L17 CUT (board controls, item 2):
   *  on the board this door serves EXACTLY ONE ask — the folder-scoped
   *  git-init offer's card (no chat exists behind a folder ask); a
   *  SESSION's permission ask is never answered from the board — its
   *  needs-you row routes into the chat, the one answering place.
   *  Optional: fixture wirings answer nowhere. */
  answerPermission?: (requestId: string, allow: boolean, obligationId: string) => void
  openObligation: (obligationId: string) => void
  /** Re-owner the
   *  question to the OPERATOR (claim) — the single-operator floor of the
   *  redirect verb (cross-human redirect left with the multiplayer estate;
   *  a successor rides the channel when one returns). */
  claimObligation: (obligationId: string) => void
  /** AT-04: settle the question 'withdrawn' (operator) — the ONE exit for
   *  a dispatch-refused obligation with no session behind it. */
  withdrawObligation: (obligationId: string) => void
  /** Pause = close the delivery valve via the kernel verb
   *  (executeKernelDecision, operator actor — parity); the in-flight
   *  turn finishes on its own. */
  pauseAfterTurn: (sessionId: string) => void
  /** Re-open the valve (session.resume). */
  resumeSession: (sessionId: string) => void
  /** BOARD CONTROLS item 1 (`i`): abort the selected LIVE session's
   *  running turn — concourseControl `interrupt` on the child's own
   *  control channel. The turn ends, the session stays; never a kill,
   *  never a park. Optional: fixture wirings interrupt nothing. */
  interruptSession?: (sessionId: string) => void
  /** BOARD CONTROLS item 1 (`m`): switch the selected session's model in
   *  place — concourseControl `set-model` (idle applies now; busy parks it
   *  for the turn's end and the chat paints the ruled grey "model
   *  switched" note when the settle lands). `displayName` rides only the
   *  receipt's wording. Optional: fixture wirings switch nothing. */
  setSessionModel?: (sessionId: string, modelId: string, displayName?: string) => void
  /** BOARD CONTROLS item 1 (`e`): set the selected session's effort in
   *  place through concourseControl `set-effort` (the handler
   *  mirrors set-model's grammar and the child applies via its own
   *  set_effort control). `effort` is a shared-ladder level. Optional:
   *  fixture wirings set nothing. */
  setSessionEffort?: (sessionId: string, effort: string) => void
  /** Operator x-gesture: first x STOPS the selected session
   *  (child dies, row stays as 'stopped'); the second x within the beat
   *  REMOVES it (release — the row leaves the board, transcript survives). */
  stopSession?: (sessionId: string) => void
  /** The close chord's second rung: a stopped row parks — the record stands
   *  (the chat survives) until the third rung deletes it. */
  archiveSession?: (sessionId: string) => void
  removeSession?: (sessionId: string) => void
  /** THE BOARD'S RENAME (session-aware naming, L16): store the typed title
   *  on the session's record through the daemon's set-title door (source
   *  'operator' — it outranks and outlives the one-time mint). Optional:
   *  fixture wirings and the reduced stage carry no door. */
  renameSession?: (sessionId: string, title: string) => void
  /** Deliver an instruction to an EXISTING live session (session.redirect
   *  — the same idempotent dispatch door; a paused target holds typed). */
  redirectSession: (sessionId: string, instruction: string) => void
  startSessionDraft: (text: string, caret?: number) => void
  /** Structured seeds: merge one durable override (null resets the
   *  field to its default). Every field maps to a REAL dispatch input. */
  setDraftSeed: (patch: {
    projectDir?: string | null
    modelKey?: string | null
    /** Operator: the per-session effort pick (EffortLevel). */
    effort?: string | null
    isolation?: 'isolated-worktree' | 'exclusive' | 'shared-read-only' | null
    title?: string | null
    /**: the worker's OWNER handle — a real
     *  dispatch input painted back as the board's OWNER column. */
    agentName?: string | null
    /** the per-session background-seat ceiling — rides the op. */
    seatsMax?: 1 | 2 | null
  }) => void
  /** B5 (D2): the EXPLICIT submit path — the screen submits its LOCAL echo
   *  (draftNow), never the possibly-stale store projection. Replaces the
   *  retired text-equality submit heuristic (which could submit on a
   *  keystroke that happened to equal the stored draft). */
  submitSessionDraft: (text: string) => void
  enterBootSettings: () => void
  exitToRepl: () => void
  /** the CLEAR retry while the live snapshot refresh is failing —
   *  the frame keeps the last coherent snapshot and the help rail names
   *  this action (⌃r / click). Optional: fixture wirings need no retry. */
  retrySnapshot?: () => void
  /** The G wave: one operator message into the coordinator conversation
   *  (the lane's operator-message door — durable append + assisted turn +
   *  reply-with-receipts). Optional: fixture wirings converse nowhere. */
  /** AT-07: the surface mints ONE clientMessageId per composed draft and
   *  keeps it across retries — the lane replays the same durable entry
   *  instead of duplicating it. onAccepted fires when the operator entry is
   *  durably journaled (the acceptance point): the composer clears there, in
   *  the same beat the transcript echo paints, while the promise keeps
   *  running the assisted turn. */
  sendCoordinatorMessage?: (
    text: string,
    clientMessageId?: string,
    onAccepted?: () => void,
    /** MANAGER MODE (ledger T7+T8): this send runs under the coordinator
     *  composer's manager mode — the lane binds the manager addendum + the
     *  card tools for exactly this turn. */
    opts?: { manager?: boolean },
  ) => Promise<void>
  /** The safe-boundary coordinator switches. The route
   *  executes the OWNER write (validated against the composed registry;
   *  typed refusal receipts; config untouched on refusal) and hands the
   *  receipt back for the picker's note line. */
  switchCoordinatorModel: (modelId: string) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
  switchCoordinatorMode: (
    mode: 'off' | 'rules-only' | 'agent-assisted',
  ) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
  /** The coordinator model's own persistent effort (the e doorway in the
   *  coordinator-model picker — the same RowPickModal UI the session rows'
   *  e opens). The owner normalizes through the ONE effort normalizer and
   *  refuses junk typed; its engine turns carry the persisted level.
   *  Optional so older hosts type-check; the picker no-ops without it. */
  switchCoordinatorEffort?: (
    effort: string,
  ) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
}
