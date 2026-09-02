// ============================================================================
//  actionGraph — the ONE interaction authority.
//
//  Every bindable action Mercury ships, with its meaning, the contexts its
//  consumers register, and — when it deliberately ships without a default
//  key — the reason. Before this file the estate kept THREE parallel copies
//  (the types.ts union, schema.ts's KEYBINDING_ACTIONS, and whatever the
//  defaults happened to bind) that could drift silently; now types, schema,
//  validation and the help/atlas surfaces all derive from THIS record, and
//  scripts/cockpit-interaction/prove-action-graph.ts enforces the graph laws:
//
//    · REACHABILITY — every action is default-bound, or carries an explicit
//      `rebindOnly` reason (reachable via user config / a surface's own
//      contextual dispatch). An action nobody can reach cannot exist.
//    · TOTALITY — every action the defaults bind exists here, both ways.
//    · HONEST COLLISIONS — no default rides a reserved chord without a
//      documented allowance.
//
//  React-free by design: config-level modules (defaultBindings, types)
//  import it, so it must never pull ink/React.
// ============================================================================

export type ActionMeta = {
  /** What the action does, from the operator's side of the screen. */
  description: string
  /** Contexts where live consumers register handlers for this action. */
  contexts: readonly string[]
  /** Present ⟺ the action deliberately ships with NO default binding — the
   *  string is the reason (user-rebindable; often the surface reaches it
   *  through its own contextual dispatch). Enforced by the ratchet. */
  rebindOnly?: string
}

export const ACTION_GRAPH = {
  // ── app-level (Global) ────────────────────────────────────────────────────
  'app:interrupt': { description: 'Interrupt the current turn (double-press quits)', contexts: ['Global'] },
  'app:exit': { description: 'Exit Mercury (double-press)', contexts: ['Global'] },
  'app:toggleTodos': { description: 'Toggle the task list panel', contexts: ['Global'] },
  'app:toggleTranscript': { description: 'Toggle the transcript viewer', contexts: ['Global'] },
  'app:toggleTeammatePreview': { description: 'Toggle the teammate preview pane', contexts: ['Global'] },
  'app:toggleTerminal': {
    description: 'Toggle the integrated terminal pane',
    contexts: ['Global'],
    rebindOnly: 'IDE-integration niche — no chord is spent on it by default; bind one in keybindings.json',
  },
  'app:redraw': { description: 'Force a full screen repaint', contexts: ['Global'] },
  'app:commandPalette': { description: 'Open the command palette', contexts: ['Global'] },
  'app:fileOpen': { description: 'Open the file quick-open (insert @path)', contexts: ['Global'] },
  'app:contentSearch': { description: 'Search file contents (insert @file#Lline)', contexts: ['Global'] },
  //  R1c: the universal surface switcher —
  // the Session Concourse IS the visible surface map (actionable breadcrumbs
  // + the V2 footer), so the switcher semantic opens it from the root.
  'app:openSurfaceSwitcher': { description: 'Open the Session Concourse — every surface, one board', contexts: ['Global'] },
  // The board's close verb (the operator's word — plain x retired: a bare
  // printable is typing wherever a composer is live). ctrl+x ctrl+x over the
  // highlighted Concourse row, staged: the first completed chord stops (the
  // row stays, wearing stopped); the same gesture again removes. Queued rows
  // withdraw; parked rows say so, then clear. Registered in the REPL world
  // (routeSafe) and dispatched through the Concourse's one-slot seam —
  // where no board stands, the completion declines silently.
  'concourse:closeSession': { description: 'Close the highlighted Concourse session (staged: stop, then remove — the same chord walks both)', contexts: ['Global'] },
  // #43 (family): the lateral surface cycle — ctrl+pgdn/pgup; the
  // ctrl+arrow candidate FAILED the collision census (macOS Spaces owns
  // ctrl+←/→ at the OS; ⌥←/→ is the session tab-flip + word-nav).
  'app:cycleSurfaceForward': { description: 'Cycle to the next surface (the focused chat → Concourse → Boot menu — only screens that exist)', contexts: ['Global'] },
  'app:cycleSurfaceBack': { description: 'Cycle to the previous surface', contexts: ['Global'] },
  // Operator directive: the LEFT-RIGHT surface strip on shift+arrows — the
  // operator's mental order is [Boot menu] [Concourse] [the focused chat];
  // shift+→ moves right, shift+← moves left toward the boot face. The strip
  // counts its stops from what exists (surfaceRoute): the chat stop is there
  // exactly while a session is focused, the concourse stop while its switch
  // is on outside a `--chat` boot — a move onto an absent stop is no
  // movement, and the key-map rows say so ("no chat open"). Same mechanics
  // as the ctrl+pg chords (HOME + PUSH; esc stays a one-hop root return).
  'app:surfaceRight': { description: 'Surface strip right (Boot menu → Concourse → the focused chat; only stops that exist — with no chat open, no movement)', contexts: ['Global'] },
  'app:surfaceLeft': { description: 'Surface strip left (the focused chat → Concourse → Boot menu)', contexts: ['Global'] },
  // ── history ───────────────────────────────────────────────────────────────
  'history:search': { description: 'Search command history', contexts: ['Global'] },
  // ── chat composer ─────────────────────────────────────────────────────────
  'chat:cancel': { description: 'Cancel the current input or close the transient surface', contexts: ['Chat'] },
  'chat:killAgents': { description: 'Stop all running agents', contexts: ['Chat'] },
  'chat:cycleMode': { description: 'Cycle the permission mode', contexts: ['Chat'] },
  'chat:modelPicker': { description: 'Open the model picker', contexts: ['Chat'] },
  'chat:thinkingToggle': { description: 'Toggle extended thinking', contexts: ['Chat'] },
  // The ⊞ SESSIONS strip's flip (the strip
  // advertised "⌥←→ flip" — and the surface-cycle comment above already
  // called ⌥←/→ "the session tab-flip" — while NO binding or handler
  // existed anywhere; a fully advertised dead chord). Armed exactly as the
  // strip says: an empty prompt, tabs to flip to.
  'chat:flipSessionBack': { description: 'Flip to the previous session on the ⊞ SESSIONS strip (recency ring backward)', contexts: ['Chat'] },
  'chat:flipSessionForward': { description: 'Flip to the next session on the ⊞ SESSIONS strip (the most recent other)', contexts: ['Chat'] },
  'chat:newline': {
    description: 'Insert a newline in the composer',
    contexts: ['Chat'],
    rebindOnly: 'the editor already inserts newlines via shift+enter/backslash-enter; bind a chord if your terminal delivers neither',
  },
  'chat:undo': { description: 'Undo the last composer edit', contexts: ['Chat'] },
  'chat:redo': { description: 'Redo the undone composer edit', contexts: ['Chat'] },
  'chat:externalEditor': { description: 'Edit the draft in your external editor (on the plan card: the plan file)', contexts: ['Chat', 'Confirmation'] },
  'chat:stash': { description: 'Stash the current draft', contexts: ['Chat'] },
  'chat:imagePaste': { description: 'Paste an image from the clipboard', contexts: ['Chat'] },
  'chat:messageActions': { description: 'Open message actions on a previous turn', contexts: ['Chat'] },
  // ── autocomplete ──────────────────────────────────────────────────────────
  'autocomplete:accept': { description: 'Accept the highlighted completion', contexts: ['Autocomplete'] },
  'autocomplete:dismiss': { description: 'Dismiss the completion menu', contexts: ['Autocomplete'] },
  'autocomplete:previous': { description: 'Previous completion', contexts: ['Autocomplete'] },
  'autocomplete:next': { description: 'Next completion', contexts: ['Autocomplete'] },
  // ── confirmation dialogs ──────────────────────────────────────────────────
  'confirm:yes': { description: "Confirm the dialog's primary action", contexts: ['Confirmation'] },
  'confirm:no': { description: 'Decline / dismiss', contexts: ['Confirmation', 'Settings'] },
  'confirm:previous': { description: 'Previous option', contexts: ['Confirmation'] },
  'confirm:next': { description: 'Next option', contexts: ['Confirmation'] },
  'confirm:cycleMode': { description: 'Cycle the dialog mode', contexts: ['Confirmation'] },
  'confirm:approveWithFeedback': { description: 'Approve the plan carrying the typed feedback', contexts: ['Confirmation'] },
  'confirm:toggleExplanation': { description: 'Toggle the permission explanation', contexts: ['Confirmation'] },
  'confirm:toggleFullPreview': { description: 'Expand or collapse the consent card\'s bounded file preview', contexts: ['Confirmation'] },
  // ── tabs ──────────────────────────────────────────────────────────────────
  'tabs:next': { description: 'Next tab', contexts: ['Tabs'] },
  'tabs:previous': { description: 'Previous tab', contexts: ['Tabs'] },
  // ── transcript viewer ─────────────────────────────────────────────────────
  'transcript:toggleShowAll': { description: 'Toggle full transcript detail', contexts: ['Transcript'] },
  'transcript:exit': { description: 'Leave the transcript viewer', contexts: ['Transcript'] },
  // ── history search ────────────────────────────────────────────────────────
  'historySearch:next': { description: 'Next history match', contexts: ['HistorySearch'] },
  'historySearch:accept': { description: 'Accept the match into the composer', contexts: ['HistorySearch'] },
  'historySearch:cancel': { description: 'Cancel history search', contexts: ['HistorySearch'] },
  'historySearch:execute': { description: 'Run the matched command immediately', contexts: ['HistorySearch'] },
  // ── foreground task ───────────────────────────────────────────────────────
  'task:background': { description: 'Send the running task to the background', contexts: ['Task'] },
  // ── theme picker ──────────────────────────────────────────────────────────
  'theme:toggleSyntaxHighlighting': { description: 'Toggle syntax highlighting preview', contexts: ['ThemePicker'] },
  // ── help ──────────────────────────────────────────────────────────────────
  'help:dismiss': { description: 'Close help', contexts: ['Help'] },
  // ── attachments ───────────────────────────────────────────────────────────
  'attachments:next': { description: 'Next attachment', contexts: ['Attachments'] },
  'attachments:previous': { description: 'Previous attachment', contexts: ['Attachments'] },
  'attachments:remove': { description: 'Remove the selected attachment', contexts: ['Attachments'] },
  'attachments:exit': { description: 'Leave attachment navigation', contexts: ['Attachments'] },
  // ── footer indicators ─────────────────────────────────────────────────────
  'footer:up': { description: 'Move up the footer indicators', contexts: ['Footer'] },
  'footer:down': { description: 'Move down the footer indicators', contexts: ['Footer'] },
  'footer:next': { description: 'Next footer indicator', contexts: ['Footer'] },
  'footer:previous': { description: 'Previous footer indicator', contexts: ['Footer'] },
  'footer:openSelected': { description: 'Open the selected indicator', contexts: ['Footer'] },
  'footer:clearSelection': { description: 'Clear the footer selection', contexts: ['Footer'] },
  'footer:close': {
    description: 'Dismiss the selected footer task row',
    contexts: ['Footer'],
    rebindOnly: 'reached through the footer row actions; bind a chord for one-key dismissal',
  },
  // ── message selector (rewind) ─────────────────────────────────────────────
  'messageSelector:up': { description: 'Previous message', contexts: ['MessageSelector'] },
  'messageSelector:down': { description: 'Next message', contexts: ['MessageSelector'] },
  'messageSelector:top': { description: 'First message', contexts: ['MessageSelector'] },
  'messageSelector:bottom': { description: 'Last message', contexts: ['MessageSelector'] },
  'messageSelector:select': { description: 'Rewind to the selected message', contexts: ['MessageSelector'] },
  // The always-armed route home: the surface registers this for its WHOLE
  // life (every phase, the restoring wait and the error card included), so
  // escape can never strand the operator on the rewind surface.
  'messageSelector:close': { description: 'Close the rewind surface back to the chat', contexts: ['MessageSelector'] },
  // ── message actions cursor ────────────────────────────────────────────────
  'messageActions:prev': { description: 'Previous message row', contexts: ['MessageActions'] },
  'messageActions:next': { description: 'Next message row', contexts: ['MessageActions'] },
  'messageActions:top': { description: 'First message row', contexts: ['MessageActions'] },
  'messageActions:bottom': { description: 'Last message row', contexts: ['MessageActions'] },
  'messageActions:prevUser': { description: 'Previous user turn', contexts: ['MessageActions'] },
  'messageActions:nextUser': { description: 'Next user turn', contexts: ['MessageActions'] },
  'messageActions:escape': { description: 'Leave message actions', contexts: ['MessageActions'] },
  'messageActions:ctrlc': { description: 'Leave message actions (interrupt)', contexts: ['MessageActions'] },
  'messageActions:enter': { description: 'Open actions for the selected message', contexts: ['MessageActions'] },
  'messageActions:c': { description: 'Copy the selected message', contexts: ['MessageActions'] },
  'messageActions:p': { description: 'Pin the selected message', contexts: ['MessageActions'] },
  // ── diff workspace ────────────────────────────────────────────────────────
  'diff:dismiss': { description: 'Close the diff workspace', contexts: ['DiffDialog'] },
  'diff:previousSource': { description: 'Previous diff source', contexts: ['DiffDialog'] },
  'diff:nextSource': { description: 'Next diff source', contexts: ['DiffDialog'] },
  'diff:back': {
    description: 'Back out one diff level (detail → list)',
    contexts: ['DiffDialog'],
    rebindOnly: 'the workspace routes ← contextually in detail mode; bind a chord for an unconditional back',
  },
  'diff:viewDetails': { description: 'Open the selected file detail', contexts: ['DiffDialog'] },
  'diff:previousFile': { description: 'Previous changed file', contexts: ['DiffDialog'] },
  'diff:nextFile': { description: 'Next changed file', contexts: ['DiffDialog'] },
  'diff:previousHunk': { description: 'Previous hunk', contexts: ['DiffDialog'] },
  'diff:nextHunk': { description: 'Next hunk', contexts: ['DiffDialog'] },
  'diff:previousFileDetail': { description: 'Previous file, keeping detail view', contexts: ['DiffDialog'] },
  'diff:nextFileDetail': { description: 'Next file, keeping detail view', contexts: ['DiffDialog'] },
  'diff:copy': { description: 'Copy the current diff', contexts: ['DiffDialog'] },
  'diff:openFile': { description: 'Open the file in your editor', contexts: ['DiffDialog'] },
  'diff:annotate': { description: 'Comment on the current hunk', contexts: ['DiffDialog'] },
  'diff:nextFinding': { description: 'Next review finding', contexts: ['DiffDialog'] },
  'diff:resolveComments': { description: 'Resolve the selected comments', contexts: ['DiffDialog'] },
  'diff:sendComments': { description: 'Send the selected comments', contexts: ['DiffDialog'] },
  'diff:sendAllComments': { description: 'Send every pending comment', contexts: ['DiffDialog'] },
  // ── model picker ──────────────────────────────────────────────────────────
  // ── select lists ──────────────────────────────────────────────────────────
  'select:next': { description: 'Next row', contexts: ['Select', 'Settings'] },
  'select:previous': { description: 'Previous row', contexts: ['Select', 'Settings'] },
  'select:accept': { description: 'Choose the selected row', contexts: ['Select', 'Settings'] },
  'select:cancel': { description: 'Cancel the selection', contexts: ['Select'] },
  // ── extensions ────────────────────────────────────────────────────────────
  'extensions:toggle': { description: 'Turn the selected extension off or on', contexts: ['Extensions'] },
  'extensions:install': { description: 'Install or approve the selected extension (the approval card)', contexts: ['Extensions'] },
  'extensions:update': { description: 'Update the selected extension to the version its source lists', contexts: ['Extensions'] },
  'extensions:remove': { description: 'Uninstall the selected extension or remove the selected source', contexts: ['Extensions'] },
  'extensions:block': { description: 'Block or unblock the selected extension or source', contexts: ['Extensions'] },
  'extensions:options': { description: "Edit the selected extension's options", contexts: ['Extensions'] },
  'extensions:add-source': { description: 'Add a source (a git URL, a folder or an archive)', contexts: ['Extensions'] },
  'extensions:refresh': { description: 'Refresh the selected source', contexts: ['Extensions'] },
  'extensions:reload': { description: 'Reload the extensions into the running session', contexts: ['Extensions'] },
  'extensions:filter': { description: 'Filter the rows', contexts: ['Extensions'] },
  'extensions:previous': { description: "Swap back to the selected extension's previous version", contexts: ['Extensions'] },
  // ── permission dialog ─────────────────────────────────────────────────────
  'permission:toggleDebug': { description: 'Toggle permission debug detail', contexts: ['Confirmation'] },
  // ── settings panel ────────────────────────────────────────────────────────
  'settings:retry': { description: 'Retry loading usage data', contexts: ['Settings'] },
  // ── the /keys input atlas ─────────────────────────────────────────────────
  // The atlas's mode chords are REAL bindings in their own context, active
  // only while the atlas is open: an Atlas-block binding outranks the
  // Global claims on the same chords (ctrl+l app:redraw · ctrl+r
  // history:search), which is what makes the advertised keys reachable.
  'atlas:lookup': { description: 'Input atlas: capture one chord and explain what it does', contexts: ['Atlas'] },
  'atlas:rebind': { description: 'Input atlas: rebind the selected action', contexts: ['Atlas'] },
  // ── scroll & selection (fullscreen transcript) ────────────────────────────
  'scroll:pageUp': { description: 'Scroll a page up', contexts: ['Scroll'] },
  'scroll:pageDown': { description: 'Scroll a page down', contexts: ['Scroll'] },
  'scroll:lineUp': { description: 'Scroll a line up', contexts: ['Scroll'] },
  'scroll:lineDown': { description: 'Scroll a line down', contexts: ['Scroll'] },
  'scroll:top': { description: 'Jump to the top', contexts: ['Scroll'] },
  'scroll:bottom': { description: 'Jump to the bottom', contexts: ['Scroll'] },
  'selection:copy': { description: 'Copy the mouse selection', contexts: ['Scroll'] },

  // ── the prompts panel (/workbench — the WORK panel retired in place) ──
  // The panel rides the NavigablePanes grammar (tab/1-3 section · ↑↓ select ·
  // ↵/→ expand · esc close); its own verbs live on the SAVED PROMPTS tab and
  // are reached through the panes rowActions keys. Registered so the atlas
  // names what each key does; none is a chord of its own.
  'prompts:expand': {
    description: 'Expand the selected prompt, crew message or saved prompt — the detail pane shows the whole text (a long prompt is truncated honestly in the list)',
    contexts: ['Workbench'],
    rebindOnly: 'reached through the panes drill (↵/→) on any row of the prompts panel',
  },
  'prompts:new-saved': {
    description: 'Write a new saved prompt (the one-line composer opens; ↵ saves, esc cancels) — inert until sent',
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own a key (works on an empty list too)",
  },
  'prompts:edit-saved': {
    description: 'Edit the selected saved prompt in place (your edit is the only writer of its wording; a refinement beside the old wording is dropped)',
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own e key on a row",
  },
  'prompts:move-saved': {
    description: 'Reorder the selected saved prompt one slot up or down (the list order is the file order)',
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own [ and ] keys on a row",
  },
  'prompts:delete-saved': {
    description: 'Delete the selected saved prompt — a two-press confirm on the same key (d · d), never a dialog',
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own d key on a row",
  },
  'prompts:send-saved': {
    description: "Hand the selected saved prompt to the focused chat's composer — never submitted; you review first (r hands Minerva's refinement beside it instead)",
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own s key (r for the refinement) on a row",
  },
  'prompts:drop-refinement': {
    description: "Drop Minerva's refinement beside the selected saved prompt — your wording stays",
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own x key on a refined row",
  },
  'prompts:clear-saved': {
    description: 'Clear EVERY saved prompt — one in-place confirm first (↵ clears · esc keeps them), never bare; the list paints its honest empty state after',
    contexts: ['Workbench'],
    rebindOnly: "reached through the SAVED PROMPTS tab's own c key — advertised only while the tab has entries",
  },

  // ── the prompts panel route ──────────────────────────────────
  // Declared for the resolver (ctrl+x k); the route itself is the /workbench
  // command — the panel opens and closes exactly as the WORK panel did.
} as const satisfies Record<string, ActionMeta>

export type ActionGraph = typeof ACTION_GRAPH

/** Every action id, derived — the schema/type/help surfaces consume THIS,
 *  never a hand-maintained parallel list. */
export const KEYBINDING_ACTIONS = Object.keys(ACTION_GRAPH) as readonly (keyof ActionGraph)[]
