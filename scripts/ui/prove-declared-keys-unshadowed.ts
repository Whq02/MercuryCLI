#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-declared-keys-unshadowed.ts — NO KEY BELONGS TO TWO
//  FOCUS STATES: a single key a surface advertises either fires where it is
//  advertised or is not advertised there, and a text capture takes
//  printables only under its own explicit focus — the chrome follows the
//  capture. The sibling of prove-exit-reachability (every way out stands):
//  here every declared way IN stands too.
//
//  The law, per capturing state:
//    · REGISTRY contexts that bind a bare printable (k/j/space/r, y/n, q,
//      the diff and extensions letters…) declare their capture rule — no
//      text field can be live under them, or every host that keeps such an
//      action live gates it off while a field has focus, with needles in
//      the host: a mounted hook whose action matches consumes the printable
//      before the field ever sees it (useKeybinding's match arm), and the
//      text input never consumes a key itself;
//    · RAW-INPUT captures (a useInput of their own inserting printables) sit
//      on a CLOSED roster naming the guard that scopes the capture and the
//      legend that swaps while the capture is live;
//    · TEXT-FIELD HOSTS that also compare raw single letters gate those
//      letters off while the field has focus, and their footers say so;
//    · the Session Concourse board's own law, pure: the rows print the same
//      letter verbs in every list state, no 'type to message' row exists,
//      the header's n follows the list focus and the filter, and the atlas
//      key follows the focused composer's draft.
//
//  The find this closes: with a board row ARMED, n typed an n into the live
//  composer — whose own hint read "tab or click to type" — instead of
//  starting the session the pane header advertised. Rows another owner
//  holds are NOTED with their verdict, never failed here.
//
//  Run: bun scripts/ui/prove-declared-keys-unshadowed.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')
const manifest = await import('../../src/components/concourse/controlManifest.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const has = (src: string, needle: string | RegExp): boolean =>
  typeof needle === 'string' ? src.includes(needle) : needle.test(src)
const missingIn = (rel: string, needles: Array<string | RegExp>): string[] =>
  needles.filter(n => !has(read(rel), n)).map(String)
/** Code only — a comment that mentions a key is not a guard. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) out.push(rel)
  }
  return out
}
const SURFACE_TREES = ['src/components', 'src/screens', 'src/commands']
const files = SURFACE_TREES.flatMap(t => walk(t))
const hostsTextField = (src: string): boolean => /BaseTextInput|<TextInput\b|from '(?:\.\.\/)+TextInput\.js'/.test(src)

// ── §1 THE REGISTRY ───────────────────────────────────────────────────────
type Gate = { file: string; needles: Array<string | RegExp> }
type Rule =
  | { rule: 'no-field'; reason: string; hosts: string[] }
  | { rule: 'gated'; reason: string; gates: Gate[] }
const CAPTURE_RULES: Record<string, Rule> = {
  Settings: {
    rule: 'gated',
    reason: 'k/j/space/r are bound, and text fields live under this context (the search-first settings panel, the rule editors, the elicitation form) — but the only handlers that keep those actions live are the Select engine (its own context, dropped in input mode) and the usage retry (an error state with no field); every field host registers only its esc here, where n is unbound',
    gates: [
      { file: 'src/components/CustomSelect/use-select-input.ts', needles: ["{ context: 'Select', isActive: !isDisabled && !state.isInInput }"] },
      { file: 'src/components/Settings/Usage.tsx', needles: ["{ context: 'Settings', isActive: showingError }"] },
      { file: 'src/components/permissions/rules/PermissionRuleList.tsx', needles: ['isActive: subDialog === null && !searchMode'] },
    ],
  },
  Confirmation: {
    rule: 'gated',
    reason: 'y/n are bound; the design-system Dialog keeps its cancel behind isCancelActive so a host with a text field turns it off while the field has focus, or registers its esc under Settings instead',
    gates: [
      { file: 'src/components/design-system/Dialog.tsx', needles: ["{ context: 'Confirmation', isActive: isCancelActive }"] },
      { file: 'src/components/mcp/ElicitationDialog.tsx', needles: ['isCancelActive={(!fieldFocused || buttonFocused) && !accordionOpen}'] },
      { file: 'src/components/permissions/rules/AddWorkspaceDirectory.tsx', needles: ['isCancelActive={false}'] },
      { file: 'src/components/ExportDialog.tsx', needles: ["context: 'Settings',", "isActive: screen === 'filename',"] },
      { file: 'src/components/LogSelector.tsx', needles: ["context: 'Settings',", 'isActive: inRename,'] },
      // The remote-server auth phase: its redirect-URL paste field turns the
      // Dialog's cancel off while it shows (a typed n used to cancel the
      // sign-in mid-URL) and re-homes esc under Settings.
      { file: 'src/components/mcp/MCPRemoteServerMenu.tsx', needles: ['isCancelActive={pasteSubmit === null}', "{ context: 'Settings', isActive: phase.id === 'auth' && pasteSubmit !== null }"] },
    ],
  },
  Transcript: {
    rule: 'gated',
    reason: 'q is bound; the pager owns q / g G n N raw and stands every one down while the search bar captures, and the bar replaces the hints row while open',
    gates: [
      {
        file: 'src/screens/REPL.tsx',
        needles: ["if (input === 'q' && !searchBarOpen)", "if (input === '/' && !searchBarOpen)", "if (input === 'g' && !searchBarOpen)", /searchBarOpen \? \(\s*\n\s*<TranscriptSearchBar/],
      },
    ],
  },
  MessageSelector: {
    rule: 'gated',
    reason: 'k/j are bound; the summarise phase hosts a text field and the pick-phase bindings are inactive off the pick phase',
    gates: [{ file: 'src/components/MessageSelector.tsx', needles: ["phase === 'pick' && !restoring && errorText === null && entries.length > 0", "{ context: 'MessageSelector', isActive: active }"] }],
  },
  MessageActions: { rule: 'no-field', reason: 'the message-actions menu hosts no text field', hosts: ['src/components/messageActions.tsx'] },
  DiffDialog: {
    rule: 'gated',
    reason: 'n/p/c/o/a/f/r/s/x are bound; the comment composer turns every binding off while open and the footer says so',
    gates: [{ file: 'src/components/diff/DiffDialog.tsx', needles: ['const bindingsActive = !composer.open', "if (composer.open) return 'enter save · esc discard'"] }],
  },
  Select: {
    rule: 'gated',
    reason: 'k/j/space are bound; the engine drops navigation and accept while the focused option is a text input (only the cancel stays, and it is escape)',
    gates: [{ file: 'src/components/CustomSelect/use-select-input.ts', needles: ["{ context: 'Select', isActive: !isDisabled && !state.isInInput }", "{ context: 'Select', isActive: !isDisabled && Boolean(onCancel) }"] }],
  },
  Extensions: {
    rule: 'gated',
    reason: 'the board letters are bound; the add/filter slot owns input, the board keys stand down while it does, and the panes engine drops its single-char actions and swaps the footer to the slot',
    gates: [
      { file: 'src/components/extensions/ExtensionsBoard.tsx', needles: ["{ isActive: view.kind === 'board' && slot === null }"] },
      { file: 'src/components/mercury-ui/NavigablePanes.tsx', needles: ['!composerSlot?.active &&', /composerSlot\?\.active\s*\n\s*\? 'esc composer'/] },
    ],
  },
}

section('§1 the registry — every context that binds a bare printable declares its capture rule')
{
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const bound = new Map<string, Set<string>>()
  for (const b of bindings) {
    if (b.action === null || b.chord.length !== 1) continue
    const k = b.chord[0]!
    if (k.ctrl || k.meta || k.alt || k.super || k.key.length !== 1) continue
    if (!bound.has(b.context)) bound.set(b.context, new Set())
    bound.get(b.context)!.add(`${k.shift ? 'shift+' : ''}${k.key === ' ' ? 'space' : k.key}`)
  }
  const undeclared = [...bound.keys()].filter(c => !(c in CAPTURE_RULES))
  check('every context that binds a bare printable has a capture rule', undeclared.length === 0, undeclared.join(', '))
  const stale = Object.keys(CAPTURE_RULES).filter(c => !bound.has(c))
  check('the table names no context without a bare printable', stale.length === 0, stale.join(', '))
  check('the census is populated (≥ 8 contexts bind bare printables)', bound.size >= 8, `${bound.size}`)
  for (const [ctx, rule] of Object.entries(CAPTURE_RULES)) {
    const keys = [...(bound.get(ctx) ?? [])].join(' ')
    if (rule.rule === 'no-field') {
      for (const host of rule.hosts) {
        check(`${ctx} (${keys}): ${host} hosts no text field — ${rule.reason}`, !hostsTextField(read(host)) && !/input\.length > 0 &&|insertAt\(/.test(read(host)))
      }
      continue
    }
    for (const gate of rule.gates) {
      const miss = missingIn(gate.file, gate.needles)
      check(`${ctx} (${keys}): gated in ${gate.file}`, miss.length === 0, miss.join(' · '))
    }
  }
}

section('§1b a design-system Dialog that hosts a text field turns its cancel off while the field has focus')
{
  // The n → confirm:no trap: the Dialog's cancel hook is registered in the
  // Confirmation context, the text input never consumes a printable, so a
  // typed n reaches the hook and cancels the dialog unless the host gates
  // it (isCancelActive) or re-homes its esc under Settings.
  // Rows another owner holds are noted here with their verdict; a host that
  // gains its gate leaves the roster (the closure check below reds a stale
  // row). Empty today: the last open host (the remote-server auth paste
  // field) gates its cancel.
  const DIALOG_FIELD_NOTES: Record<string, string> = {}
  const dialogHosts = files.filter(rel => hostsTextField(read(rel)) && /<Dialog\b/.test(read(rel)))
  check('the census is populated (≥ 3 Dialog text hosts)', dialogHosts.length >= 3, dialogHosts.join(' · '))
  for (const rel of dialogHosts) {
    const src = read(rel)
    if (src.includes('isCancelActive=')) {
      check(`${rel}: gates the Dialog cancel (isCancelActive)`, true)
      continue
    }
    if (rel in DIALOG_FIELD_NOTES) {
      note(`${rel}: ${DIALOG_FIELD_NOTES[rel]}`)
      continue
    }
    check(`${rel}: a Dialog text host must gate its cancel (isCancelActive) — the n key otherwise cancels mid-word`, false)
  }
  const staleNotes = Object.keys(DIALOG_FIELD_NOTES).filter(rel => !dialogHosts.includes(rel) || read(rel).includes('isCancelActive='))
  check('the note roster is current (a fixed host leaves it)', staleNotes.length === 0, staleNotes.join(' · '))
}

// ── §2 RAW-INPUT CAPTURES ────────────────────────────────────────────────
section('§2 raw-input captures — a closed roster: the guard that scopes the capture, the legend that follows it')
{
  type Row = {
    /** The guard(s) that scope the capture to its explicit focus. */
    guard: Array<string | RegExp>
    /** The legend/footer that swaps while the capture is live (needles in
     *  `legendIn` when the chrome paints elsewhere). */
    legend: Array<string | RegExp>
    legendIn?: string
    /** A surface that advertises no single key beside its field. */
    commands?: 'none'
    reason: string
  }
  const CAPTURE_ROSTER: Record<string, Row> = {
    'src/components/concourse/ConcourseScreen.tsx': {
      guard: ["if (region !== 'coordinator' && region !== 'live') {", 'if (filtering) {'],
      legendIn: 'src/components/concourse/ConcourseLayout.tsx',
      legend: ["'type to filter · ↵ apply · esc clear'", '{newSessionTabLabel({ region, filtering })}', "helpKeyFiresFor(region, region === 'coordinator' ? coordinatorDraftEmpty : liveDraftEmpty)"],
      reason: 'the board: printables reach a composer only under its own focus (the composer-focus gate), the / filter captures modally; the header’s n and the atlas key follow the state',
    },
    'src/components/KitMenuScreen.tsx': {
      guard: ['{ isActive: preset.open }'],
      legend: ['legend: preset.open ? KIT_LEGEND_PROMPT : KIT_LEGEND_PRESET,'],
      reason: 'the preset-name prompt owns the keys only while open; the legend swaps to its own three moves',
    },
    'src/components/BootAgentsScreen.tsx': {
      guard: ['{ isActive: !suspended && form !== null && formPrompt !== null }'],
      legend: ['legend: promptOpen ? AGENT_FACE_LEGEND_PROMPT : AGENT_FACE_LEGEND_FORM,'],
      reason: 'the field prompt owns the keys only while open; the form legend (g generate · s save) yields to the prompt legend',
    },
    'src/components/BootSaturnScreen.tsx': {
      guard: ['{ isActive: formPrompt !== null }'],
      legend: ['saturnFormLegendOf({ prompt: formPrompt !== null, pick: false })', "if (state.prompt) return 'type · ↵ set · esc cancel'"],
      reason: 'the schedule prompt owns the keys only while open; the form legend (s schedule it) yields to the prompt legend',
    },
    'src/components/concourse/CoordinatorModelPicker.tsx': {
      guard: ["!(input === 'e' && query.length === 0 && effortDoorArmedRef.current)"],
      legend: [/list\.selectedRow\?\.kind === 'model' && query\.length === 0\s*\n?\s*\? \[\{ text: 'e effort'/],
      reason: 'the type-to-filter search takes every printable except the one e the effort doorway fires (empty query, model row); the legend advertises e exactly then',
    },
    'src/components/concourse/SessionWaitingRoom.tsx': {
      guard: ['if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {'],
      legend: ['add a message — it delivers when the session starts'],
      commands: 'none',
      reason: 'one composer that owns the whole card; it advertises no single key',
    },
    'src/components/mercury-ui/ManagerView.tsx': {
      guard: ['if (!pastOpenEvent()) return'],
      legend: ['esc clears the filter'],
      commands: 'none',
      reason: 'the surfaces search feeds every printable to the query and advertises no single key',
    },
  }
  /** Captures another owner holds — their verdict is printed, never failed. */
  const CAPTURE_NOTES: Record<string, { guardHolds: Array<string | RegExp>; verdict: string }> = {
    'src/components/BootLoginsScreen.tsx': {
      guardHolds: ["if (input === 'c' && !key.ctrl && !key.meta && h.phase === 'waiting' && draftRef.current === '' && h.authorizeUrl !== undefined) {", "if (input === 'd' && !key.ctrl && !key.meta && h.leg === 'openai-browser' && h.phase === 'waiting' && draftRef.current === '') {"],
      verdict:
        "the paste prompts capture correctly (c/d fire only on an EMPTY draft), but the browser-login pane's legend ('↵ submit paste · c copy · d device · esc cancel') and its body line ('c copy · d device · esc cancel') keep advertising c/d after the first typed character — the sign-in pane at anthropicFlowLegendOf already hides 'c copy url' once draftLen > 0; loginsFlowLegendOf('handles') and the pane lines need the same draftLen gate — an accounts surface, another owner's file",
    },
  }
  const captureFiles = files.filter(rel => {
    const src = read(rel)
    return /\buseInput\(/.test(src) && /input\.length > 0 &&|insertAt\(/.test(src)
  })
  check('the census is populated (≥ 7 raw captures)', captureFiles.length >= 7, `${captureFiles.length}`)
  const unrostered = captureFiles.filter(rel => !(rel in CAPTURE_ROSTER) && !(rel in CAPTURE_NOTES))
  check('every raw capture is rostered (or noted for its owner)', unrostered.length === 0, unrostered.join(' · '))
  const staleRows = [...Object.keys(CAPTURE_ROSTER), ...Object.keys(CAPTURE_NOTES)].filter(rel => !captureFiles.includes(rel))
  check('the roster is closed and current (no row without a capture)', staleRows.length === 0, staleRows.join(' · '))
  for (const [rel, row] of Object.entries(CAPTURE_ROSTER)) {
    const miss = missingIn(rel, row.guard)
    check(`${rel}: the capture is scoped to its explicit focus — ${row.reason}`, miss.length === 0, miss.join(' · '))
    const legendFile = row.legendIn ?? rel
    const missL = missingIn(legendFile, row.legend)
    check(`${rel}: the chrome follows the capture (${legendFile})`, missL.length === 0, missL.join(' · '))
    if (row.commands === 'none') {
      const letters = stripComments(read(rel)).match(/(?:^|[^.\w])_?input === '[a-zA-Z]'/g) ?? []
      check(`${rel}: advertises no single letter beside its field (none compared raw)`, letters.length === 0, letters.join(' · '))
    }
  }
  for (const [rel, row] of Object.entries(CAPTURE_NOTES)) {
    const miss = missingIn(rel, row.guardHolds)
    note(`${rel}: guards ${miss.length === 0 ? 'hold' : `DRIFTED (${miss.join(' · ')})`} — ${row.verdict}`)
  }
}

// ── §2b TEXT-FIELD HOSTS WITH RAW LETTER VERBS ───────────────────────────
section('§2b text-field hosts that compare raw single letters gate them off while the field has focus')
{
  type Host = { gate: Array<string | RegExp>; legend: Array<string | RegExp>; legendIn?: string; reason: string }
  const HOST_ROSTER: Record<string, Host> = {
    'src/components/tabula/MinervaRoom.tsx': {
      gate: ['if (!listFocus) {', "if ((_input === 'm' || _input === 'M') && !key.ctrl && !key.meta) {"],
      legend: [/↵ send to minerva\$\{modelSet[^`]*· tab prompt list · esc/],
      reason: 'm and s fire only while the prompt list holds focus (the handler leaves before them otherwise); the box footer names ↵ · tab · esc and neither letter',
    },
    'src/components/agents/studio/AgentStudio.tsx': {
      gate: ["{ isActive: mode.kind === 'library' }", "{ isActive: mode.kind === 'inspect' }"],
      legend: ["'↵ clone under the new identifier · esc back'", "'↵ stage in composer · esc cancel'"],
      reason: 'the library letters (N/U/R) and the inspect verbs fire only in their modes; the clone and test-drive fields print their own two moves instead of the library legend',
    },
    'src/components/agents/studio/StudioEditor.tsx': {
      gate: ['if (recoverOffer) {', "if (view.kind === 'review') {"],
      legend: ['y / ↵ recover it · n discard it'],
      reason: 'y/n/l/s live inside modal and review arms that show no focused field; the advanced view edits through Select input options (the engine drops nav/accept in input mode)',
    },
    'src/components/prompts-panel/PromptsPanel.tsx': {
      gate: ["{ isActive: section === 'saved' && editor === null }"],
      legendIn: 'src/components/mercury-ui/NavigablePanes.tsx',
      legend: [/composerSlot\?\.active\s*\n\s*\? 'esc composer'/],
      reason: 'a adds only while no editor is open; the panes engine swaps the footer to the slot while the editor captures',
    },
    'src/components/mcp/MCPRemoteServerMenu.tsx': {
      gate: ["if (input === 'c' && !key.ctrl && !key.meta && authUrl && pasteText === '') {", 'event.stopImmediatePropagation()'],
      legend: ["pasteText === '' ? 'Press c to copy the URL.' : '↵ submits the pasted URL.'"],
      reason: 'c copies the authorisation URL only on an empty paste draft and is consumed ahead of the field (mounted later, so it listens after); once the URL is being typed, c is a letter and the hint names the submit instead',
    },
  }
  /** Accounts surfaces — another owner's files: the guard line is printed as the verdict. */
  const ACCOUNTS_HOSTS = new Set([
    'src/components/KimiConnect.tsx',
    'src/components/HuggingfaceConnect.tsx',
    'src/components/RouterOpenrouterConnect.tsx',
    'src/components/GeminiConnect.tsx',
    'src/components/RouterOpenaiConnect.tsx',
    'src/components/ConsoleOAuthFlow.tsx',
  ])
  const letterHosts = files.filter(rel => {
    const src = read(rel)
    if (!hostsTextField(src)) return false
    const code = stripComments(src)
    // A ctrl chord is not a bare letter.
    return code.split('\n').some(line => /(?:^|[^.\w])_?input === '[a-zA-Z]'/.test(line) && !/key\.ctrl &&/.test(line))
  })
  check('the census is populated (≥ 8 text hosts compare a raw letter)', letterHosts.length >= 8, `${letterHosts.length}`)
  const unrostered = letterHosts.filter(rel => !(rel in HOST_ROSTER) && !ACCOUNTS_HOSTS.has(rel))
  check('every such host is rostered (or an accounts surface, noted)', unrostered.length === 0, unrostered.join(' · '))
  const stale = Object.keys(HOST_ROSTER).filter(rel => !letterHosts.includes(rel))
  check('the host roster is closed and current', stale.length === 0, stale.join(' · '))
  for (const [rel, host] of Object.entries(HOST_ROSTER)) {
    const miss = missingIn(rel, host.gate)
    check(`${rel}: the letters are gated off the field — ${host.reason}`, miss.length === 0, miss.join(' · '))
    const missL = missingIn(host.legendIn ?? rel, host.legend)
    check(`${rel}: the footer follows (${host.legendIn ?? rel})`, missL.length === 0, missL.join(' · '))
  }
  for (const rel of letterHosts.filter(r => ACCOUNTS_HOSTS.has(r))) {
    const line = stripComments(read(rel)).split('\n').find(l => /(?:^|[^.\w])input === '[a-zA-Z]'/.test(l) && !/key\.ctrl &&/.test(l)) ?? ''
    note(`${rel}: accounts surface (another owner) — the letter guard reads: ${line.trim().slice(0, 120)}`)
  }
}

// ── §3 THE BOARD'S OWN LAW ───────────────────────────────────────────────
section('§3 the Session Concourse board — the rows own their letters in every state (pure)')
{
  const { regionKeysFor, newSessionTabLabel, helpKeyFiresFor } = manifest
  const classes = ['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door', 'none'] as const
  const isLetterVerb = (keys: string): boolean => /^[a-z\/]$/.test(keys) || keys === 'space'
  const shadowed: string[] = []
  for (const selection of classes) {
    const plain = regionKeysFor('list', { newSession: true, selection })
    const armed = new Set(regionKeysFor('list', { newSession: true, selection, armed: true }).map(k => k.keys))
    const held = new Set(regionKeysFor('list', { newSession: true, selection, liveDraftHeld: true }).map(k => k.keys))
    for (const k of plain.map(r => r.keys).filter(isLetterVerb)) {
      if (!armed.has(k)) shadowed.push(`${selection}/armed/${k}`)
      if (!held.has(k)) shadowed.push(`${selection}/draft/${k}`)
    }
  }
  check('no list letter verb disappears under the arm or a held draft (the legend never advertises a key typing would eat)', shadowed.length === 0, shadowed.join(' · '))
  check("no 'type to message' row exists in any list state", classes.every(s => !regionKeysFor('list', { newSession: true, selection: s, armed: true }).some(k => k.keys === 'type')))
  check("the header's n prints on the rows only, never under the filter or a composer", newSessionTabLabel({ region: 'list', filtering: false }) === '+ new session · n' && newSessionTabLabel({ region: 'list', filtering: true }) === '+ new session' && newSessionTabLabel({ region: 'live', filtering: false }) === '+ new session' && newSessionTabLabel({ region: 'coordinator', filtering: false }) === '+ new session')
  check('the atlas key follows the focused composer’s draft', helpKeyFiresFor('list', false) && helpKeyFiresFor('live', true) && !helpKeyFiresFor('live', false) && !helpKeyFiresFor('coordinator', false))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the screen keeps no yield and no implicit focus move', !screen.includes('verbsYield') && !screen.includes('if (region !== side.focus) setRegion(side.focus)') && screen.includes("if (region !== 'coordinator' && region !== 'live') {"))
}

console.log(failures === 0 ? '\nprove-declared-keys-unshadowed: EVERY DECLARED KEY STANDS' : `\nprove-declared-keys-unshadowed: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
