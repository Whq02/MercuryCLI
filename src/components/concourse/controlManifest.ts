// ============================================================================
//  src/components/concourse/controlManifest.ts — the typed
//  control manifest for the recomposed switchboard screen. EVERY canonical
//  control: stable ID, typed action, focus rule, keyboard path, pointer
//  path, receipt. The screen WIRES this manifest; the provers CENSUS
//  against it — a control that exists here must be live in the frame (no
//  dead affordance), and an affordance in the frame must exist here (no
//  unregistered control). Every printed key fires; every
//  firing browse key prints (or lives in the '?' atlas).
// ============================================================================

/** The switchboard interaction modes. */
export type ConcourseMode = 'browse' | 'filter-edit' | 'coordinator-picker' | 'confirmation'

/** Focus regions in visual tab order — PANELS (L17 item 4): coordinator ·
 *  list · live (the mirror + its composer are ONE panel) · needs-you.
 *  TYPING NEEDS THE COMPOSER'S OWN FOCUS: printables reach the
 *  COORDINATOR's composer while its panel holds focus and the LIVE
 *  composer (the row-side box; its target is the selected row) while ITS
 *  panel holds focus — never from the rows, the rail or the split pane,
 *  whose single letters are verbs (no key belongs to two focus states).
 *  Single-letter hotkeys fire only while their region holds focus. 'chat'
 *  is the split view's chat pane — the LAST stop of the extended Tab ring,
 *  present exactly while the split frame composes (the split-view sheet,
 *  item 4). */
export type ConcourseFocusRegion = 'needs-you' | 'list' | 'live' | 'coordinator' | 'chat'

export interface ConcourseControlSpec {
  /** Stable control id — hit-region key, focus key, receipt key. */
  id: string
  /** The typed action identity click AND keyboard settle. */
  action: string
  region: ConcourseFocusRegion | 'header' | 'status'
  /** Modes in which the control is live. */
  modes: ConcourseMode[]
  /** Keyboard path (visible in the help grammar when contextual). */
  keys: string[]
  /** Pointer semantics. */
  pointer: 'activate' | 'select-then-activate' | 'none'
  /** The receipt family the action settles (typed, idempotent). */
  receipt: string
  /** Informational elements carry NO control spec — listed here only as the
   *  explicit non-interactive census. */
  informational?: boolean
}

export const CONCOURSE_CONTROLS: readonly ConcourseControlSpec[] = [
  // ── header ────────────────────────────────────────────────────────────────
  { id: 'crumb:boot', action: 'route:boot-settings', region: 'header', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'route-transition' },
  { id: 'crumb:main-repl', action: 'route:root-repl', region: 'header', modes: ['browse'], keys: ['escape'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'crumb:concourse', action: 'none', region: 'header', modes: ['browse'], keys: [], pointer: 'none', receipt: 'none', informational: true },
  // ── needs-you ─────────────────────────────────────────────────────────────
  { id: 'needs-you:row', action: 'concourse:select-obligation', region: 'needs-you', modes: ['browse'], keys: ['up', 'down'], pointer: 'select-then-activate', receipt: 'selection' },
  { id: 'needs-you:answer', action: 'concourse:answer-obligation', region: 'needs-you', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'obligation-settled' },
  { id: 'needs-you:open', action: 'concourse:open-session', region: 'needs-you', modes: ['browse'], keys: ['o'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'needs-you:withdraw', action: 'concourse:withdraw-obligation', region: 'needs-you', modes: ['browse'], keys: ['w'], pointer: 'none', receipt: 'obligation-settled' },
  // ── session list ──────────────────────────────────────────────────────────
  // First click selects (the mirror follows in the same frame); second
  // click / ↵ ENTERS the session — the one-terminal full swap (IP-1;
  // retired as a named deletion with the switchboard recomposition).
  { id: 'board:row', action: 'concourse:select-session', region: 'list', modes: ['browse'], keys: ['up', 'down'], pointer: 'select-then-activate', receipt: 'selection' },
  // On an OTHER PROJECTS door row (cross-project awareness, law 4) the same
  // ↵ switches the board's VIEW to that project through the REPO picker's
  // own path — the row is a door, and the one switcher stays one.
  { id: 'board:open', action: 'concourse:enter-session', region: 'list', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  // ARM-THEN-ENTER (L17 item 2): a SESSION row's first keyboard ↵ ARMS it
  // as the live composer's target (the row shows the arm — "↵ again
  // enters · tab to message"); the second ↵ or → enters; esc (or a
  // selection move) disarms. The arm never changes what the letters do:
  // the rows keep their verbs, and tab (or a click) reaches the composer.
  // Doors, the older line and held launches keep their one-press grammar;
  // pointer clicks keep select-then-enter.
  { id: 'board:arm', action: 'concourse:arm-session', region: 'list', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'selection' },
  // Item 5: ↵ on a QUEUED row paints the in-place queued line (no screen);
  // the deliver-on-start room is the EXPLICIT 'm' door on the queued row.
  { id: 'board:queued-room', action: 'concourse:open-queued-room', region: 'list', modes: ['browse'], keys: ['m'], pointer: 'none', receipt: 'route-transition' },
  // Line 5 (expand in place): `→` opens the selected row's live peek in
  // the list band; the same key or esc collapses; ↵ still enters.
  { id: 'board:peek', action: 'concourse:toggle-row-peek', region: 'list', modes: ['browse'], keys: ['right'], pointer: 'none', receipt: 'selection' },
  // ITEM 7 (L20): the older-chats DROP-DOWN — ↵ (or →) on the census line
  // unfolds this project's older chats IN PLACE on the board; ↑↓ choose,
  // ↵ reactivates the pick through the ONE resume door, esc folds. Rows
  // click (select, then activate). The board keeps the frame — no route
  // change, never a shunt into a chat panel.
  { id: 'board:older-browse', action: 'concourse:older-browse', region: 'list', modes: ['browse'], keys: ['return', 'right', 'up', 'down', 'escape'], pointer: 'select-then-activate', receipt: 'route-transition' },
  { id: 'board:group-heading', action: 'none', region: 'list', modes: ['browse'], keys: [], pointer: 'none', receipt: 'none', informational: true },
  { id: 'board:empty-start', action: 'concourse:focus-composer', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  // THE EMPTY STATE's second door (item 4): the designed empty board offers
  // the blank-session birth beside the coordinator door — same n path.
  { id: 'board:empty-new', action: 'concourse:new-session', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'route-transition' },
  // FOCUS IS LEGIBLE (item 4): the panel titles are the Tab ring's mouse
  // parity — clicking a title focuses its panel (the collapsed coordinator
  // tail's click swaps the tall band up).
  { id: 'board:focus', action: 'concourse:focus-list', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  { id: 'coordinator:focus-title', action: 'concourse:focus-coordinator', region: 'coordinator', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  // THE NEW SESSION TAB (the operator: "a small
  // little tab there"): the SESSIONS pane's title carries it — click, or n
  // in the list grammar — and it births a blank session through the one
  // birth door in the current ground, then focuses the chat. A full-
  // concourse control: the reduced stage (concourse off) paints no tab and
  // prints no n (the boot face is the solo road).
  { id: 'board:new-session', action: 'concourse:new-session', region: 'list', modes: ['browse'], keys: ['n'], pointer: 'activate', receipt: 'route-transition' },
  // THE BOARD'S RENAME (session-aware naming, L16): r on a session row arms
  // the composer with a rename context; ↵ stores the typed title through
  // the daemon's set-title door. Full-concourse only (the reduced stage has
  // no composer — the same stage fact that hides the New Session tab).
  { id: 'board:rename', action: 'concourse:rename-session', region: 'list', modes: ['browse'], keys: ['r'], pointer: 'none', receipt: 'mode-transition' },
  // BOARD CONTROLS: the row controls act on
  // the SELECTED LIVE-runner row only — i aborts the running turn
  // (concourseControl `interrupt`: the turn ends, the session stays; never
  // a kill, never a park), p toggles the delivery valve (session.pause /
  // session.resume — the row wears "paused by you"; resume clears it), m
  // opens the session-arm model picker on a LIVE row (set-model — idle
  // applies now, busy parks for the turn's end; the same key keeps its
  // queued-row meaning, the deliver-on-start room). Every control paints a
  // typed who/what/when receipt on the row; a non-live selection answers
  // its honest reason there instead — never a silent dead key.
  { id: 'board:interrupt', action: 'concourse:interrupt-session', region: 'list', modes: ['browse'], keys: ['i'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:pause-resume', action: 'concourse:pause-resume-session', region: 'list', modes: ['browse'], keys: ['p'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:set-model', action: 'concourse:set-session-model', region: 'list', modes: ['browse'], keys: ['m'], pointer: 'none', receipt: 'row-control' },
  // `e` EFFORT — the board effort door, same picker grammar as m, written
  // through concourseControl `set-effort`.
  { id: 'board:set-effort', action: 'concourse:set-session-effort', region: 'list', modes: ['browse'], keys: ['e'], pointer: 'none', receipt: 'row-control' },
  // THE BROADCAST MARK: space on the
  // selected row toggles its mark — the pre-signed set the live composer's
  // broadcast speaks to (≥2 marks: the placeholder counts them and ↵↵ fans
  // ONE message through the one steering door; the fan skips refusing rows
  // with their typed reason — item 3). ANY row marks; the send decides.
  // On the rows space is this verb and nothing else; in the live composer
  // (its own focus) space is a printable, so a mid-sentence space can
  // never toggle a mark. Marks are SCREEN state (never persisted, never a
  // record fact); esc clears them all; a project switch clears them (item
  // 5). Full stage only: the reduced stage keeps space dead and untaught.
  { id: 'board:mark', action: 'concourse:toggle-broadcast-mark', region: 'list', modes: ['browse'], keys: ['space'], pointer: 'none', receipt: 'selection' },
  // ── the live pane (the mirror + ITS composer — one panel) ─────────────────
  { id: 'mirror:title', action: 'concourse:enter-session', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  // THE LIVE COMPOSER (L17 item 1): words to the SELECTED row's session —
  // delivered instantly, read at the session's next readable moment
  // (session.redirect rides the same delivery law as the composer).
  { id: 'live:send', action: 'concourse:live-send', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'row-control' },
  // ── SPLIT VIEW ────────────────────────────
  // `s` toggles the split frame — the board and the focused chat side by
  // side, one VIEW STATE of this stop (the strip's stops do not change). A
  // board letter-verb by the landed m/e/i/p pattern (a focused composer
  // keeps s a letter); the SAME control fires from
  // the split chat pane (there it reads 'full board'). Full stage only: the
  // reduced stage / plain world has no board to split with — the key stays
  // dead and untaught there. A frame under the two-minimum threshold
  // answers one honest line naming the needed width, and nothing changes.
  { id: 'board:split-toggle', action: 'concourse:toggle-split-view', region: 'list', modes: ['browse'], keys: ['s'], pointer: 'none', receipt: 'mode-transition' },
  // `[` / `]` nudge the divider between the named ratios while split is on
  // (board-min · even · chat-min, clamped to both minimums); both panes
  // fire them. Off-split the rows ignore them; a focused composer keeps
  // them as printables.
  { id: 'board:split-ratio', action: 'concourse:nudge-split-ratio', region: 'list', modes: ['browse'], keys: ['[', ']'], pointer: 'none', receipt: 'mode-transition' },
  // The chat pane's ↵ — the FOCUSED session enters the full chat (the same
  // enter journey shift+→ rides); with no focused session it is the board's
  // own New Session birth (the one birth door). Typing reaches only the
  // focused pane: the chat pane owns no composer in v1, so printables land
  // nowhere there.
  { id: 'split:chat-enter', action: 'concourse:enter-session', region: 'chat', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  // (the boot-region ↵): an EMPTY live draft's ↵ is the browse verb —
  // it enters the selected session instead of running a silent empty send.
  { id: 'live:enter-selected', action: 'concourse:enter-session', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'route-transition' },
  // ── the coordinator pane's own composer (its REPL; the launcher when the
  //    coordinator is off) ───────────────────────────────────────────────────
  { id: 'composer:send', action: 'concourse:composer-send', region: 'coordinator', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'coordinator-turn' },
  { id: 'composer:model-chip', action: 'concourse:coordinator-model', region: 'coordinator', modes: ['browse', 'coordinator-picker'], keys: ['ctrl+s'], pointer: 'activate', receipt: 'mode-transition' },
  // ── status rail ───────────────────────────────────────────────────────────
  // UI-2: the harness-ground selector (THE GROUND LAW's live door) — click
  // on the rail's project segment where painted; ⌃g everywhere, including
  // widths where the segment sheds.
  { id: 'status:project-ground', action: 'concourse:ground-picker', region: 'status', modes: ['browse'], keys: ['ctrl+g'], pointer: 'activate', receipt: 'mode-transition' },
  // ── the one-time capacity ask (sheet) — a DECLARED modal ──────────────
  // While armed it owns every key: y probes once, n/esc keep the default
  // (both recorded — it never asks again); the answer rows are clickable.
  { id: 'capacity-ask:allow', action: 'concourse:capacity-allow', region: 'coordinator', modes: ['confirmation'], keys: ['y'], pointer: 'activate', receipt: 'mode-transition' },
  { id: 'capacity-ask:decline', action: 'concourse:capacity-decline', region: 'coordinator', modes: ['confirmation'], keys: ['n', 'escape'], pointer: 'activate', receipt: 'mode-transition' },
] as const

/** Browse-mode key grammar (the ruled base legend — derives
 *  the painted legend from these bindings, never copied strings). The base
 *  set carries ONLY keys that fire in EVERY region (`/` and `↵
 *  enter session` printed everywhere while bound list-only — a printed key
 *  that does not fire is a lie); region-varying verbs live in the region
 *  sets, and ↑↓ browse is base for every BOARD-side region — the rows, the
 *  live view and the split chat pane bind board-browse (the live composer
 *  keeps caret travel on a multiline draft). The coordinator panel is the
 *  one exception: browseKeysFor drops the row there (the arrow-focus law,
 *  below). */
export const CONCOURSE_BROWSE_KEYS = [
  { keys: '↑↓', label: 'browse' },
  { keys: 'tab', label: 'panes' },
  // UI-2: the ground door rides the atlas ('?') — the painted legend stays
  // short; the rail's project segment carries the pointer half when painted.
  { keys: '⌃g', label: 'ground' },
  { keys: 'esc', label: 'focused chat' },
] as const

/** The focused region's own verbs append to the base legend (a11y-p2-10;
 *  every row mirrors a REAL region-scoped binding in ConcourseScreen). The
 *  composer's ↵ is resolved by the LAYOUT (enter session on an empty draft
 *  — the browse state; the strip's own meta row carries '↵ send' while a
 *  draft exists). */
export const CONCOURSE_REGION_KEYS = {
  rail: [
    { keys: '↵', label: 'answer' },
    { keys: 'o', label: 'open session' },
    { keys: 'w', label: 'withdraw' },
  ],
  list: [
    { keys: '↵↵', label: 'enter session' },
    { keys: 'n', label: 'new session' },
    { keys: 'r', label: 'rename' },
    { keys: '→', label: 'peek' },
    { keys: '/', label: 'filter' },
    // THE CLOSE CHORD (the operator's word — plain x retired to typing):
    // one gesture, staged — the first completed chord stops the running
    // row (it stays, wearing stopped), the same gesture again removes it.
    { keys: '⌃x ⌃x', label: 'stop · again removes' },
    { keys: 'm', label: 'message queued' },
    // THE BROADCAST MARK (item 1): the key-map row teaches space only where
    // it fires — the list on the full stage (stageFilter drops it with the
    // other full-stage doors; 'none' selections keep it off below). On the
    // rows space is the mark and nothing else; the live composer's own
    // focus keeps space a printable there, so this row never lies.
    { keys: 'space', label: 'mark' },
    { keys: 's', label: 'split' },
  ],
  // The LIVE panel: the mirror and ITS composer are one focus stop — the
  // composer's ↵ meaning is resolved by the layout (enter on an empty
  // draft; its own meta row says '↵ send' while a draft exists).
  live: [
    { keys: '⇧↵/⌃j', label: 'newline' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
  // The coordinator panel: its own composer (the REPL when on, the
  // launcher when off) — ↵ sends there, never a board browse verb.
  coordinator: [
    { keys: '↵', label: 'send' },
    { keys: '⇧↵/⌃j', label: 'newline' },
    { keys: '⌃s', label: 'coordinator model' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
  // The split chat pane (region 'chat' — present only while split composes,
  // so the toggle's label here is always the way BACK; `↵`'s truth is
  // resolved per the focused slot by regionKeysFor).
  chat: [
    { keys: '↵', label: 'full chat' },
    { keys: 's', label: 'full board' },
    { keys: '[ ]', label: 'divider' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
} as const

export const CONCOURSE_HELP_KEY = { keys: '?', label: 'keys' } as const

/** The base legend resolved for the strip (the control-plane model: the
 *  chat is a bridge that exists only while a session is focused): esc leaves
 *  the board for the focused chat when one exists, and for the boot face
 *  when none does (the root REPL never fronts a resting slot) — the label
 *  says where esc lands. ONE resolver: the legend, the atlas and the pins
 *  read the same rows.
 *
 *  THE ARROW-FOCUS LAW (the operator's live find): ↑↓ browse the
 *  board only from the panels whose ↵ acts on the selection — the rows, the
 *  live view, the split chat pane. The coordinator panel keeps its own ↑↓
 *  (the zero-state example walk; caret travel on a multiline draft) and
 *  never moves the board, exactly as its ↵ never enters a row — so with
 *  `region: 'coordinator'` the ↑↓ row is not printed (a printed key that
 *  does not fire is a lie), and the region-less atlas row names where the
 *  key fires. */
export function browseKeysFor(opts: {
  chatPresent: boolean
  region?: keyof typeof CONCOURSE_REGION_KEYS
}): ReadonlyArray<{ keys: string; label: string }> {
  const rows = opts.region === 'coordinator' ? CONCOURSE_BROWSE_KEYS.filter(k => k.keys !== '↑↓') : CONCOURSE_BROWSE_KEYS
  return rows.map(k =>
    k.keys === 'esc'
      ? { keys: 'esc', label: opts.chatPresent ? 'focused chat' : 'boot face' }
      : k.keys === '↑↓' && opts.region === undefined
        ? { keys: '↑↓', label: 'browse (list · live · split)' }
        : k,
  )
}

/** BOARD CONTROLS (the present-moves law): what kind of row the
 *  board cursor stands on — the list legend prints ONLY the moves that
 *  exist for THAT row, here and now. Derived from the row's own facts;
 *  'none' is an empty board. */
export type BoardSelectionClass =
  | 'live'
  | 'paused'
  | 'attached'
  | 'queued'
  | 'parked'
  | 'stopped'
  | 'door'
  | 'none'

/** The row-controls liveness fold — ONE derivation for the legend, the
 *  screen's key guards and the pins: which selections the i/p/m controls
 *  act on ('live'/'paused'), and what every other selection is instead. */
export function boardSelectionClassOf(
  row?: { sessionId: string; state: string; door?: unknown },
): BoardSelectionClass {
  if (row === undefined) return 'none'
  if (row.door !== undefined || row.sessionId.startsWith('older:') || row.state === 'elsewhere') return 'door'
  if (row.sessionId.startsWith('dispatch:') || row.state === 'queued') return 'queued'
  if (row.state === 'parked') return 'parked'
  if (row.state === 'attached') return 'attached'
  if (row.state === 'stopped') return 'stopped'
  if (row.state === 'paused') return 'paused'
  return 'live'
}

/** A region's legend resolved for the stage: the New Session tab is a
 *  full-concourse control, so the reduced stage (concourse off — rule 5's
 *  plain live view) has no tab and must print no n (a printed key that does
 *  not fire is a lie). ONE resolver — the layout's legend and the pins read
 *  the same rows.
 *
 *  BOARD CONTROLS (the present-moves law): with a `selection` the LIST
 *  legend says only the moves that exist for the selected row — a live row
 *  adds i/p/m (p reads resume on a paused one; m means model there, and
 *  keeps its queued-row meaning on a queued one), a parked row dims to its
 *  reason ("parked · ↵ brings it back"), a queued row keeps m and the
 *  close chord with their own words, a door row keeps ↵ alone. Without a
 *  `selection` the static census rows answer exactly as before (the pins'
 *  baseline). */
export function regionKeysFor(
  region: keyof typeof CONCOURSE_REGION_KEYS,
  opts: {
    newSession: boolean
    selection?: BoardSelectionClass
    chatSession?: boolean
    landing?: boolean
    olderBrowse?: boolean
    /** ARM-THEN-ENTER: the selected row is armed — the list's ↵ row reads
     *  'enters (armed)' and → reads 'enter'; every letter verb stays (the
     *  arm never changes what the letters do). */
    armed?: boolean
    /** THE DRAFT-AWARE ↵ (ruled): with words held in the live composer the
     *  list's ↵ SENDS them wherever it lands — the row says 'send', never
     *  'enter session'. */
    liveDraftHeld?: boolean
  },
): ReadonlyArray<{ keys: string; label: string }> {
  // ITEM 7 (L20): while the older drop-down stands, the row verbs yield to
  // the browse grammar — the one move is bringing a chat back (the base
  // legend's ↑↓/esc swap their labels at the paint site, one resolver).
  if (opts.olderBrowse === true) {
    return [{ keys: '↵', label: 'bring it back' }]
  }
  const stageFilter = (rows: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> =>
    // The full-stage doors print together: the New Session tab, the rename
    // AND the split toggle (the first two need the composer the reduced
    // stage lacks; the split needs the board the plain world lacks — the
    // same one stage fact carries all three).
    // G3 (input-mapping truth): the reduced stage also has no live
    // composer, so its ↵ enters on ONE press (no arm to stage) and no
    // newline row prints — a printed key that does not fire is a lie.
    // The broadcast mark rides the same stage fact: no live composer on the
    // reduced stage ⇒ nothing to broadcast from ⇒ space untaught (item 5).
    opts.newSession
      ? rows
      : rows
          .filter(k => k.keys !== 'n' && k.keys !== 'r' && k.keys !== 's' && k.keys !== 'space' && k.keys !== '⇧↵/⌃j')
          .map(k => (k.keys === '↵↵' ? { keys: '↵', label: k.label } : k))
  if (region === 'chat') {
    // The split chat pane: ↵'s label follows the focused slot — the full
    // chat while a session holds it, the board's own New Session grammar
    // while none does (a printed key that fires either way).
    // A LANDING IN FLIGHT (SP-1): the chat is milliseconds from existing and
    // ↵ waits — no ↵ row prints while it does (a printed key that does not
    // fire is a lie; the pane's own body says "opening the focused chat…").
    if (opts.landing === true) return CONCOURSE_REGION_KEYS.chat.filter(k => k.keys !== '↵')
    return CONCOURSE_REGION_KEYS.chat.map(k =>
      k.keys === '↵' && opts.chatSession === false ? { keys: '↵', label: 'new session' } : k,
    )
  }
  if (region !== 'list') {
    return stageFilter(CONCOURSE_REGION_KEYS[region])
  }
  // THE LIST'S ↵ TRUTH rides the same resolver as its verbs (the legend,
  // the atlas and the pins read one row): armed ⇒ the second press enters
  // and → enters; a held live draft ⇒ ↵ sends (the draft-aware ↵ outranks
  // the arm — a send is what the key does). The letters are untouched in
  // every state: an armed row and a held draft change nothing about what
  // n, m, e, i, p, r, s, space or / do on the rows.
  const withEnterTruth = (rows: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> =>
    rows.map(k =>
      k.keys === '↵↵' && opts.liveDraftHeld === true
        ? { keys: '↵', label: 'send' }
        : k.keys === '↵↵' && opts.armed === true
          ? { keys: '↵', label: 'enters (armed)' }
          : k.keys === '→' && opts.armed === true
            ? { keys: '→', label: 'enter' }
            : k,
    )
  if (opts.selection === undefined) {
    return withEnterTruth(stageFilter(CONCOURSE_REGION_KEYS.list))
  }
  const base = CONCOURSE_REGION_KEYS.list
  const row = (keys: string): { keys: string; label: string } | undefined => base.find(k => k.keys === keys)
  const keep = (...names: string[]): Array<{ keys: string; label: string }> =>
    names.map(n => row(n)).filter((k): k is { keys: string; label: string } => k !== undefined)
  const listRowsFor = (selection: BoardSelectionClass): ReadonlyArray<{ keys: string; label: string }> => {
    switch (selection) {
      case 'live':
      case 'paused':
        // The row controls lead (shedToFit drops rightmost on ties — the
        // selection's own moves survive a narrow legend longest).
        return stageFilter([
          ...keep('↵↵'),
          { keys: 'i', label: 'interrupt' },
          { keys: 'p', label: selection === 'paused' ? 'resume' : 'pause' },
          { keys: 'm', label: 'model' },
          { keys: 'e', label: 'effort' },
          ...keep('r', '→', '/', '⌃x ⌃x', 'n', 'space', 's'),
        ])
      case 'attached':
        // With you — its own chat carries the controls; the board only
        // browses, renames and removes. Space still marks: the fan types the
        // skip at the send (item 3 — the toggle itself never refuses).
        return stageFilter([...keep('↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'space', 's')])
      case 'queued':
        // A held reservation: m queues a message for its start, one x
        // withdraws it outright (the screen's own withdraw arm).
        return stageFilter([...keep('n', 'm', '/'), { keys: '⌃x ⌃x', label: 'withdraw' }, ...keep('space', 's')])
      case 'parked':
        // The ruled dim reason IS the row-controls cluster here — the
        // legend's instruction ink is the dim; ↵ is the one move.
        return stageFilter([{ keys: 'parked', label: '· ↵ brings it back' }, ...keep('n', 'r', '/'), { keys: '⌃x ⌃x', label: 'clear' }, ...keep('space', 's')])
      case 'stopped':
        return stageFilter([...keep('n', '/'), { keys: '⌃x ⌃x', label: 'remove' }, ...keep('space', 's')])
      case 'door':
        return stageFilter([{ keys: '↵', label: 'open' }, ...keep('n', '/', 'space', 's')])
      case 'none':
        // No row under the cursor — nothing to mark (space reaches nothing).
        return stageFilter([...keep('n', '/', 's')])
    }
  }
  return withEnterTruth(listRowsFor(opts.selection))
}

/** The split toggle's label truth (one resolver — the legend, the atlas and
 *  the pins read the same row): the list's `s` reads 'split' while the full
 *  board stands and 'full board' while the split frame composes (the same
 *  control, the way back). While the split frame stands the divider nudge
 *  ('[' / ']') fires from the same regions the toggle does (board:split-ratio
 *  binds list AND chat), so the row prints beside the way back wherever an
 *  `s` row prints and no '[ ]' row already does — the split state's TRUE
 *  affordances stay painted (AGENTDIALS C4). */
export function withSplitViewTruth(
  rows: ReadonlyArray<{ keys: string; label: string }>,
  opts: { splitOn: boolean },
): ReadonlyArray<{ keys: string; label: string }> {
  if (!opts.splitOn) return rows
  const out = rows.map(k => (k.keys === 's' ? { keys: 's', label: 'full board' } : k))
  const sAt = out.findIndex(k => k.keys === 's')
  if (sAt !== -1 && !out.some(k => k.keys === '[ ]')) {
    out.splice(sAt + 1, 0, { keys: '[ ]', label: 'divider' })
  }
  return out
}

/** The painted legend's shed priority — ONE resolver, the manifest's own
 *  (ConcourseLayout's shedToFit consumes it; the pins read the same
 *  weights): the esc exit promise survives longest, then the atlas key;
 *  region verbs tie at 3; the base browse chrome yields first (it lives in
 *  the atlas). Shed order within a tie drops RIGHTMOST (geometry.ts).
 *
 *  THE SPLIT CONTINUITY ARM (AGENTDIALS C4): pressing s narrows the board
 *  pane to its lawful 80-col minimum, and the tie-class shed used to drop
 *  the split's own rows FIRST (s sits last in every list set) — the legend
 *  that taught s vanished with the split and the operator got lost. While
 *  the split frame stands the way-back verb rides ABOVE the tie class and
 *  the atlas key (esc 4 · s 3.7 · ? 3.5): the legend is a claim about what
 *  works HERE, and the way back must survive the narrow pane it itself
 *  creates. */
export function legendPriorityOf(keys: string, opts: { splitOn: boolean }): number {
  if (keys === 'esc') return 4
  if (keys === 's' && opts.splitOn) return 3.7
  if (keys === '?') return 3.5
  if (keys === '↑↓') return 2
  if (keys === 'tab') return 1.9
  if (keys === '⌃g') return 1
  return 3
}

/** The coordinator pane's own key rows (IA-6: legends derive from the ONE
 *  manifest — unbinding a key removes its hint). */
export const COORDINATOR_SURFACE_KEYS = [
  { keys: '↵', label: 'send' },
  { keys: '⌃s', label: 'coordinator model' },
  { keys: '⇧↵/⌃j', label: 'newline' },
  { keys: 'pgup/pgdn', label: 'scroll' },
] as const

/** THE NEW SESSION TAB's label — the SESSIONS pane title's right-hand
 *  affordance. The `n` half prints exactly where the key fires: the rows
 *  hold focus and no filter is being typed. From a focused composer n is a
 *  letter, and while the / filter captures it is a filter character, so the
 *  tab shows its click-only face there (ONE state-truth resolver — the
 *  layout paints it, the pins read it). */
export function newSessionTabLabel(opts: { region: string; filtering: boolean }): string {
  return opts.region === 'list' && !opts.filtering ? '+ new session · n' : '+ new session'
}

/** THE ATLAS KEY's truth — '?' opens the key atlas from the rows, the rail
 *  and the split pane always, and from a composer only while its draft is
 *  empty (with words held it is a question mark). ONE resolver: the screen's
 *  handler decides with it, the layout prints the '? keys' row with it. */
export function helpKeyFiresFor(region: string, focusedComposerEmpty: boolean): boolean {
  if (region !== 'coordinator' && region !== 'live') return true
  return focusedComposerEmpty
}
