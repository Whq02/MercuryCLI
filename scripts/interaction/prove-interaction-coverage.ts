#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-interaction-coverage.ts — the CLOSED estate-wide
//  interaction inventory. Where prove-board-coverage closes the
//  NavigablePanes callers, THIS closes the whole estate: every file under
//  src/components + src/screens + src/commands + src/keybindings that handles
//  a pointer or key signal is classified, and an UNCLASSIFIED site fails.
//
//  Classes (the brief's taxonomy, §4):
//    kernel          — the shared interaction primitives themselves
//    board           — renders <NavigablePanes (mirrors prove-board-coverage)
//    shared-list     — rides InteractiveRow/useNavigablePanes/useFlatList
//    legacy-list     — rides useSpecimenNav / <SelectRow  (S5 SHRINKS → 0)
//    editor          — text editing owners (composer family)
//    scroll-owner    — viewport/scroll anchors
//    modal-form      — overlay/dialog key owners (esc + form keys)
//    ink-primitive   — low-level vendored/base primitives
//    direct-control  — justified single-purpose pointer targets (each carries
//                      a reason; new entries need a reason or the gate is red)
//    direct-legacy   — pointer sites that SHOULD ride the kernel (S5/S6
//                      targets; frozen — a NEW member fails immediately)
//
//  The ratchet direction: legacy-list and direct-legacy are FROZEN allowlists.
//  Migration removes rows (green); a new hand-rolled pointer/key site that
//  does not ride the kernel and is not registered fails the gate.
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// ── signal scan ─────────────────────────────────────────────────────────────
const SCAN_ROOTS = ['src/components', 'src/screens', 'src/commands', 'src/keybindings']
const SIGNALS: Array<[string, RegExp]> = [
  ['click', /onClick/],
  ['hover', /onMouseEnter/],
  ['key', /useInput\(/],
  ['specimen', /useSpecimenNav\(/],
  ['selectrow', /<SelectRow/],
  ['panes', /<NavigablePanes/],
  ['irow', /<InteractiveRow/],
  ['flat', /useFlatList\(/],
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

const found = new Map<string, string[]>() // repo-rel path → signals
for (const root of SCAN_ROOTS) {
  for (const p of walk(path.join(ROOT, root))) {
    const src = readFileSync(p, 'utf8')
    const sigs = SIGNALS.filter(([, re]) => re.test(src)).map(([n]) => n)
    if (sigs.length > 0) found.set(path.relative(ROOT, p), sigs)
  }
}

// ── the ratified registry ───────────────────────────────────────────────────
// Every entry: repo-rel path → { class, reason? }. Keep sorted within groups.
type Klass =
  | 'kernel'
  | 'board'
  | 'shared-list'
  | 'legacy-list'
  | 'editor'
  | 'scroll-owner'
  | 'modal-form'
  | 'ink-primitive'
  | 'direct-control'
  | 'direct-legacy'

const REGISTRY = new Map<string, { klass: Klass; reason?: string }>()
const reg = (files: string[], klass: Klass, reason?: string): void => {
  for (const f of files) REGISTRY.set(f, { klass, reason })
}

reg(
  [
    'src/components/mercury-ui/InteractiveRow.tsx',
    'src/components/mercury-ui/InteractiveDisclosure.tsx',
    'src/components/mercury-ui/NavigablePanes.tsx',
    'src/components/mercury-ui/useNavigablePanes.ts',
    'src/components/mercury-ui/useFlatList.ts',
    'src/components/mercury-ui/useInteractiveList.ts', // the ONE small-list owner (S5; replaced useSpecimenNav — deleted)
    'src/components/mercury-ui/components.tsx', // CommandCenter shell + SelectRow (S5/S7 rework)
    'src/keybindings/useKeybinding.ts',
    'src/components/SurfaceExitChord.tsx', // the ONE exit law's listener (ledger L22): mounted by the route host on every surface, counts ctrl+c WITHOUT consuming it, arms the notice — a law component beside the primitives, not a surface of its own
  ],
  'kernel',
)

reg(
  [
    'src/components/BootSaturnScreen.tsx', // /saturn + the Boot face's layer — SATURN's scheduler screen (useInteractiveList verbs x/n/p/r + pointer rows via InteractiveRow)
    'src/components/BootAgentsScreen.tsx', // the Boot face's agents layer — library/form/pick/trash ride useInteractiveList/InteractiveRow; the machine's prompt + modal states own their keys (useInput)
    'src/components/BootLoginsScreen.tsx', // the Boot face's logins layer — roster + picks ride useInteractiveList/InteractiveRow; the flow panes own masked-draft/copy/d-switch chords (useInput)
    'src/components/BootHealthScreen.tsx', // the Boot face's doctor layer — check rows + the fix confirm/run trail ride useInteractiveList/InteractiveRow; phase keys own their window (useInput)
    'src/components/BootResumeScreen.tsx', // the Boot face's continue layer — flat/crew session rows ride useInteractiveList/InteractiveRow; detail toggles own their keys (useInput)
    'src/components/KitMenuScreen.tsx', // the boot menu's kit screen — kit rows + the presets layer ride useInteractiveList/InteractiveRow; the save-as-preset name prompt owns its keys (useInput)
    'src/components/LedgerView.tsx',
    'src/components/RouterBoard.tsx', // /router — route plans (NavigablePanes)
 'src/components/concourse/ConcourseScreen.tsx', // the Session Concourse — the ONE semantic input owner over the dedicated ConcourseLayout compositor (rail/board/peek/strip regions; no NavigablePanes)
 'src/components/concourse/ConcourseLayout.tsx', // TORATION R2/R3: the Concourse compositor — board row/heading InteractiveRows + empty-card actions (paint + hit-region identity; keys owned by ConcourseScreen)
 'src/components/concourse/ConcourseHeader.tsx', // TORATION R3 (SR-014/046/047): destination crumbs + the coordinator control area (InteractiveRow directActivate; keys owned by ConcourseScreen)
 'src/components/concourse/ConcourseStrips.tsx', // TORATION R3 (SR-051/052): the new-session strip row + seed chips + the advanced affordance (InteractiveRow directActivate; keys owned by ConcourseScreen)
 'src/components/concourse/ConcourseRoute.tsx', // TORATION FN-008 §1: the ASSEMBLING/FAILING shell's own keys (esc → REPL · ⌃r retry) — the pre-snapshot surface ConcourseScreen cannot own because it is not mounted yet
    'src/components/concourse/SplitChatPane.tsx', // the split frame's chat side — the no-session New Session row (InteractiveRow directActivate; keys owned by ConcourseScreen's chat region)
    'src/components/concourse/CoordinatorPane.tsx', // the promoted coordinator pane — bounds-gated wheel + focused-only pgup/pgdn + the zero-state example walk (composer keys moved to the screen's strip)
    'src/components/extensions/ExtensionsBoard.tsx', // /extensions — installed · sources (NavigablePanes; sibling useInput = a/f/r board keys)
    'src/components/extensions/SourceView.tsx', // a source opened — its catalogue as rows (NavigablePanes)
    'src/components/tasks/WorkflowsBoard.tsx',
    'src/components/mercury-ui/screens/MonitorView.tsx',
 'src/components/prompts-panel/PromptsPanel.tsx', // /workbench — the prompts panel (NavigablePanes)
  ],
  'board',
)

reg(
  [
    'src/components/BootSplashScreen.tsx', // the CANONICAL in-process Boot face (phase-2 ruling 1): the shared splash core composes the helmet screen; keys ride useInteractiveList and the card's composed action lines mount InteractiveRow pointer targets — esc = leaveCurrentSurface; the settings projection nests one 's' inside
    'src/components/diff/DiffFileList.tsx',
    'src/components/HelmCenterHeader.tsx',
    'src/components/HelmTelemetryRail.tsx',
    'src/components/MercuryCommandPalette.tsx',
    'src/components/MercuryModelPicker.tsx',
    'src/components/Onboarding.tsx', // the owned first-run fitting: theme rows ride useInteractiveList
    'src/components/mercury-ui/RailPanel.tsx',
    'src/components/mercury-ui/ManagerView.tsx', // /surfaces (the old /manager name stays an alias) — the effective-catalogue index
    'src/components/mercury-ui/SupercodeModeView.tsx',
    'src/components/mercury-ui/parity/AccountView.tsx',
    'src/components/mercury-ui/parity/HarnessView.tsx', // /harness (useInteractiveList action rows)
    'src/components/mercury-ui/parity/RealmsView.tsx',
    'src/components/mercury-ui/screens/SettingsStatusView.tsx',
    'src/components/mercury-ui/SessionTabs.tsx', // tabs = directActivate kernel rows; hint slot parses the shared hover owner
  ],
  'shared-list',
)

// LEGACY-LIST IS EMPTY (S5): useSpecimenNav + SelectRow are
// DELETED; every former consumer rides useInteractiveList + InteractiveRow.
// The law below still fails any NEW consumer of the old grammar.

reg(
  [
    'src/components/BaseTextInput.tsx',
    'src/components/PromptInput/PromptInput.tsx',
    // (the pointer half): the coordinator strip's
    // composer window is a click-to-caret editor — the PromptInput idiom
    // (localCol/localRow → caret through the same paint window).
    'src/components/concourse/ConcourseStrips.tsx',
  ],
  'editor',
)

reg(
  [
    'src/components/ScrollKeybindingHandler.tsx',
    'src/components/VirtualMessageList.tsx',
  ],
  'scroll-owner',
)

reg(
  [
    'src/commands/appearance/appearance.tsx',
    'src/commands/caching/caching.tsx', // /caching — the provider-neutral cache view; a modal key-owner (useInput closes it), no pointer sites
    'src/commands/console/console.tsx',
    'src/commands/copy/copy.tsx', // rides useInteractiveList (design-system list owner) — modal picker surface
    'src/commands/health/HealthCertificate.tsx', // specimen keyword is a doctrine COMMENT — a modal key-owner
    'src/commands/effort/effort.tsx',
    'src/commands/effort/EffortSlider.tsx', // specimen keyword is a comment — a modal key-owner
    'src/commands/home/home.tsx',
    'src/commands/run/run.tsx',
 'src/components/BootSettingsScreen.tsx', // Boot Settings route surface: useInteractiveList + InteractiveRow rows (write-through profile saves + explicit-apply receipts view)
 'src/components/concourse/CoordinatorModelPicker.tsx', // the composed coordinator picker modal — useInteractiveList + InteractiveRow rows (mode cycle + model select + the e effort doorway; typed refusal rows unavailable)
 'src/components/concourse/RowPickModal.tsx', // the ONE row-pick modal (model/effort), moved to its own home for the coordinator effort doorway — useInput modal key-owner + InteractiveRow rows (was declared inside ConcourseScreen.tsx, classified there)
    'src/components/concourse/GroundPicker.tsx', // the repo selector opened from the rail's project segment — useInteractiveList rows over the known-folder memory
    'src/components/concourse/SessionMirror.tsx', // the live chat-text mirror — bounds/focus-gated wheel physics (computeWheelStep); enter rides the screen's list grammar
    'src/components/concourse/SessionWaitingRoom.tsx', // a recorded ruling: the queued session's waiting room — stack messages that deliver in order on admission; ⇧←/esc back; promotes in place
 'src/components/concourse/ManagerCards.tsx', // manager mode's three cards — their own useInput while the mode is up + InteractiveRow directActivate chips
 'src/components/concourse/NeedsYouRail.tsx', // obligation rows + action chips (InteractiveRow; keys owned by ConcourseScreen)
    'src/components/SwitchboardTagBar.tsx', // the attached tag row + leave menu (⌃g · e/k/esc; modal while open, overlay-registered)
    'src/components/ConsoleOAuthFlow.tsx', // S24 rewrite: login flow — waiting-screen 'c' copy chord + enter confirm/retry (useInput; select rows ride the kernel Select)
    'src/components/GeminiConnect.tsx', // the Gemini attach flow — device-wait 'c' copy chord + enter/esc (useInput; paste rides TextInput)
    'src/components/HuggingfaceConnect.tsx', // the Hugging Face attach flow — device-code wait 'c' copy chord + enter/esc (useInput; token paste rides TextInput)
    'src/components/RouterOpenrouterConnect.tsx', // the /router OpenRouter connect surface — PKCE wait + paste fallback (useInput; the RouterKeyEntry class)
    'src/components/KimiConnect.tsx', // the Kimi attach flow — device-wait 'c' copy chord + esc (useInput); choice/region ride the kernel Select; key paste rides TextInput
    'src/components/ZaiConnect.tsx', // the GLM (Z.AI) attach flow — plan choice rides the kernel Select; masked key TextInput; esc backs out (useInput)
    'src/components/DeepseekConnect.tsx', // the DeepSeek attach flow — masked key TextInput; esc backs out, gated while storing (useInput)
    'src/components/SubModelPicker.tsx', // the /submodels container picker — useInteractiveList rows + container tab/esc chords (useInput)
    'src/components/Feedback.tsx',
    'src/components/FleetMonitor.tsx',
    'src/components/MercuryConfig.tsx',
    'src/components/MercuryContentSearch.tsx',
    'src/components/MercuryExitConfirm.tsx',
    'src/components/MercuryFileOpen.tsx',
    'src/components/MercuryFleetChat.tsx',
 'src/components/MercuryInputAtlas.tsx', // /keys input atlas : mode-owner (browse/lookup/rebind/migrate) — chord entry rides claimKeyCapture; rows ride InteractiveRow
    'src/components/MercuryLanguagePicker.tsx',
    'src/components/MercuryMcpList.tsx',
    'src/components/MercuryMemorySelector.tsx',
    'src/components/ModelPicker.tsx', // S24 rewrite: effort ←→ cycle + extended-context 'c' toggle (useInput; list rides the kernel Select)
    'src/components/MercuryPermissionsPanel.tsx',
    'src/components/MercuryQuickOpen.tsx',
    'src/components/MercuryResume.tsx',
    'src/components/MercurySearch.tsx',
    'src/components/MercuryShowcase.tsx',
    'src/components/LogSelector.tsx',
    'src/components/mcp/ElicitationDialog.tsx',
    'src/components/mcp/MCPRemoteServerMenu.tsx',
 'src/components/agents/studio/AgentStudio.tsx', // agent studio: useFlatList (charKeys:false) + type-to-search + uppercase library verbs + inspector/trash/clone/test-drive modes (the MemoryCentre grammar)
 'src/components/agents/studio/StudioEditor.tsx', // create/edit: three views over one codec draft; guided steps + advanced field editors + raw external-editor round-trip
    'src/components/memory/MemoryCentreView.tsx', // the memory centre: useFlatList (charKeys:false) + raw type-to-search/correction capture + detail verbs
    'src/components/skills/SessionSkillsDial.tsx', // the session skills dial — rows ride useInteractiveList/InteractiveRow; its useInput owns the dial's own chords while it is up
    'src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx', // the interview card's FOOTER ordinals ("6. Chat about this" and the plan-mode skip): the select owns option ordinals first by mount order; this handler takes only the footer's own digits, never while the Other field is typing
    'src/components/permissions/rules/RecentDenialsTab.tsx',
    'src/components/tabula/MinervaRoom.tsx', // Minerva's room (/tabula): the one-line composer (TextInput, ↵ asks) + esc (aborts an exchange in flight, else closes)
    'src/components/extensions/ApprovalCardView.tsx', // the approval card — approvalCardLines verbatim; ↵/p/k/x exits (decodeNavKey esc)
    'src/components/extensions/ExtensionView.tsx', // one extension's page — kind-letter switches + row verbs (decodeNavKey esc)
    'src/components/tasks/AgentInspectorPane.tsx',
    'src/components/tasks/RunDetailPane.tsx',
    'src/components/teams/TeamsDialog.tsx',
    'src/components/mercury-ui/PaletteView.tsx',
    'src/components/mercury-ui/SpecimenGallery.tsx',
    'src/components/mercury-ui/parity/CapabilityManagerView.tsx',
    'src/components/mercury-ui/parity/DaemonSupervisorView.tsx',
    'src/components/mercury-ui/screens/TeammateChatsView.tsx',
    'src/components/RouterKeyEntry.tsx', // the hidden Z.AI key entry (masked TextInput; esc cancels)
    'src/components/RouterOpenaiConnect.tsx', // the /router connect surface (paste-fallback TextInput; esc cancels/stops watching) — the RouterKeyEntry class

    'src/components/TraceView.tsx',
    'src/keybindings/KeybindingProviderSetup.tsx',
    'src/screens/REPL.tsx',
    'src/screens/ResumeConversation.tsx', // the --resume session picker screen: the wait phases own esc (useInput + app:interrupt); the list itself rides the picker's own components
    // S27 rewrites: the tasks board + its detail cards own their keys
    // directly (raw useInput adapters over KeyboardEvent), and the settings
    // config tab owns search/list/revert keys.
    'src/components/Settings/Config.tsx',
    'src/components/tasks/AsyncAgentDetailDialog.tsx',
    'src/components/tasks/BackgroundTasksDialog.tsx',
    'src/components/tasks/DreamDetailDialog.tsx',
    'src/components/tasks/InProcessTeammateDetailDialog.tsx',
    'src/components/tasks/ShellDetailDialog.tsx',
  ],
  'modal-form',
)

reg(
  [
    'src/components/CustomSelect/select.tsx',
    'src/components/CustomSelect/SelectMulti.tsx',
    'src/components/CustomSelect/select-input-option.tsx',
    'src/components/CustomSelect/use-multi-select-state.ts',
    'src/components/CustomSelect/use-select-input.ts',
    'src/components/design-system/ThemedBox.tsx',
  ],
  'ink-primitive',
)

reg(
  ['src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx'],
  'direct-control',
  'the interview preview workspace (MERCURY INTERVIEW IN-25): option rows and footer rows are single-purpose click targets with Select-owner parity — a click selects the CLICKED row; keyboard is complete without the pointer (the input-graph journey prover)',
)
reg(
  ['src/components/CritterSelect.tsx'],
  'direct-control',
  'authored-art cards: border-paint hover via the ONE global owner (a bg fill shows through sprite holes); state/actions ride useInteractiveList; card click selects, the launch line activates',
)
reg(
  ['src/components/FullscreenLayout.tsx'],
  'direct-control',
  'NewMessagesPill jump-to-tail — one true single-purpose control',
)
reg(
  ['src/components/mercury-ui/MiniCritter.tsx'],
  'direct-control',
  'the compact critter berth (the deck dock and the session card): one click cycles the session critter at every size, the same single-purpose control the hero berth carries — no hover paint, no selection state',
)
reg(
  ['src/components/PromptInput/PromptInputFooterLeftSide.tsx'],
  'direct-control',
  'footer mode chips — single-purpose toggles',
)
reg(
  ['src/components/PromptInput/PromptInputFooterSuggestions.tsx'],
  'direct-control',
  'completion popup: hover PRESELECTS (drives the autocomplete selection, not a paint) and one click commits — the editor-domain convention; select-then-activate would break completion UX',
)

// DIRECT-LEGACY IS EMPTY (S9): every hand-rolled pointer site
// rides the kernel or a justified direct control. The law below still fails
// any NEW unregistered pointer site.
reg(
  [
    'src/components/CockpitView.tsx', // TabChip rides the kernel
    'src/components/messages/SystemTextMessage.tsx', // MemoryFileRow rides the kernel
    'src/components/tasks/BackgroundTaskStatus.tsx', // agent/summary pills ride the kernel
    'src/components/mercury-ui/screens/SessionManagerView.tsx', // live cards + crew rows + gated list all ride the kernel
    'src/components/HelmLanesRail.tsx', // RailRow/ChatRow/MoreRow ride the kernel (S9); select-then-activate matches TelemetryRow
  ],
  'shared-list',
)
reg(
  ['src/components/MercuryHome.tsx'],
  'direct-control',
  'hero critter-morph clicks on authored art (the animated-hero class); the glance rows AND the berth ride the kernel (home:row:* · berth:critter with hover-lit art)',
)

// ── the laws ────────────────────────────────────────────────────────────────
// 1. CLOSED: every discovered signal-bearing file is classified.
const unclassified = [...found.keys()].filter(f => !REGISTRY.has(f)).sort()
t('every interaction site is classified', unclassified.length === 0, unclassified.join(', '))

// 2. NO GHOSTS: every registered file still exists and still carries a signal.
const ghosts = [...REGISTRY.keys()].filter(f => !found.has(f)).sort()
t('no registered site has gone silent (delete leavers)', ghosts.length === 0, ghosts.join(', '))

// 3. LEGACY IS FROZEN: specimen/selectrow signals appear only on registered
//    legacy-list rows (+ the kernel). A new consumer of the OLD grammar fails.
const legacyViolations = [...found.entries()]
  .filter(([f, sigs]) => (sigs.includes('specimen') || sigs.includes('selectrow')))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return k !== 'legacy-list' && k !== 'kernel'
  })
  .map(([f]) => f)
t('the old list grammar gains no new consumers', legacyViolations.length === 0, legacyViolations.join(', '))

// 4. RAW POINTER SITES are kernel / primitives / registered direct controls —
//    never an unregistered hand-rolled row.
const pointerViolations = [...found.entries()]
  .filter(([, sigs]) => sigs.includes('click') || sigs.includes('hover'))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return !k || k === 'modal-form' || k === 'board'
  })
  .map(([f]) => f)
t('every raw pointer site is a kernel/primitive/registered control', pointerViolations.length === 0, pointerViolations.join(', '))

// 5. Direct controls carry reasons.
const unreasoned = [...REGISTRY.entries()]
  .filter(([, v]) => v.klass === 'direct-control' && !v.reason)
  .map(([f]) => f)
t('every direct control carries its justification', unreasoned.length === 0, unreasoned.join(', '))

// 5b. STABLE INTERACTION IDENTITY: a kernel row's
//     hover/hit claim must be minted from the ROW'S IDENTITY, never its list
//     position — an async refresh that reorders the model retargets every
//     position-derived claim (hover fill, selection, a pending click) onto a
//     DIFFERENT item. The scan is textual and deliberately narrow: an
//     InteractiveRow/TelemetryRow `id=`/`label=` template whose LAST
//     interpolation is a bare loop counter (i · idx · index · wi · ci ·
//     rowIndex). Composite ids that merely INCLUDE an ordinal dedup suffix
//     don't match (the counter must be the whole hole). Frozen at ZERO —
//     the estate was sweep-fixed (helm rails · session cards ·
//     trace ring); a new positional claim fails here with its file:line.
const POSITIONAL_ID = /(?:\bid|label)=\{`[^`]*\$\{(?:i|idx|index|wi|ci|rowIndex)\}`\}/
const positionalIdViolations: string[] = []
for (const [f] of found) {
  const src = readFileSync(path.join(ROOT, f), 'utf8')
  const lines = src.split('\n')
  for (let ln = 0; ln < lines.length; ln++) {
    if (POSITIONAL_ID.test(lines[ln]!)) positionalIdViolations.push(`${f}:${ln + 1}`)
  }
}
t(
  'no kernel row mints a position-derived hover/hit id (identity law)',
  positionalIdViolations.length === 0,
  positionalIdViolations.join(', '),
)

// 6. Honest counts — the migration dashboard the ledger tracks.
const counts = new Map<Klass, number>()
for (const [f] of found) {
  const k = REGISTRY.get(f)?.klass
  if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
}
console.log('\n  estate:', [...counts.entries()].map(([k, n]) => `${k}=${n}`).sort().join(' · '))

process.exit(fail)
