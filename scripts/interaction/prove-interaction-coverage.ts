#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

let fail = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) fail = 1
}

const SCAN_ROOTS = ['src/screen', 'src/commands', 'src/permissions/cards', 'src/models/sign-in', 'src/models/usage', 'src/boot', 'src/engine/user-input', 'src/tools/crewmate', 'src/tools/edit', 'src/tools/kit', 'src/tools/notebook-edit', 'src/tools/write']
const NOT_SCANNED = ['src/screen/renderer/', 'src/screen/composer/text-input/useSearchInput.ts', 'src/screen/composer/typeahead/useTypeahead.tsx']
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

const found = new Map<string, string[]>()
for (const root of SCAN_ROOTS) {
  for (const p of walk(path.join(ROOT, root))) {
    const file = path.relative(ROOT, p)
    if (NOT_SCANNED.some(skip => file.startsWith(skip))) continue
    const src = readFileSync(p, 'utf8')
    const sigs = SIGNALS.filter(([, re]) => re.test(src)).map(([n]) => n)
    if (sigs.length > 0) found.set(file, sigs)
  }
}

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
    'src/screen/select/popup-list.tsx',
    'src/screen/widgets/InteractiveRow.tsx',
    'src/screen/widgets/InteractiveDisclosure.tsx',
    'src/screen/widgets/NavigablePanes.tsx',
    'src/screen/widgets/navigable-panes/views.tsx',
    'src/screen/widgets/useNavigablePanes.ts',
    'src/screen/widgets/useFlatList.ts',
    'src/screen/widgets/useInteractiveList.ts',
    'src/screen/widgets/components.tsx',
    'src/screen/keys/useKeybinding.ts',
    'src/screen/routes/SurfaceExitChord.tsx',
  ],
  'kernel',
)

reg(
  [
    'src/screen/boot-face/BootSaturnScreen.tsx',
    'src/screen/boot-face/saturn/menu.tsx',
    'src/screen/boot-face/BootAgentsScreen.tsx',
    'src/screen/boot-face/agents/rows.tsx',
    'src/screen/boot-face/BootLoginsScreen.tsx',
    'src/screen/boot-face/BootHealthScreen.tsx',
    'src/screen/boot-face/BootResumeScreen.tsx',
    'src/screen/boot-face/resume/resumeView.tsx',
    'src/screen/boot-face/KitMenuScreen.tsx',
    'src/screen/boot-face/BootProfilesScreen.tsx',
    'src/screen/kit-menu/kitMenuView.tsx',
    'src/screen/concourse/CompactConcourse.tsx',
 'src/screen/concourse/screen/fullTree.tsx',
 'src/screen/concourse/screen/modals.tsx',
 'src/screen/concourse/screen/useConcourseKeys.ts',
 'src/screen/concourse/ConcourseLayout.tsx',
 'src/screen/concourse/layout/listPane.tsx',
 'src/screen/concourse/ConcourseStrips.tsx',
 'src/screen/concourse/route/Assembling.tsx',
    'src/screen/concourse/SplitChatPane.tsx',
    'src/screen/extensions/ExtensionsBoard.tsx',
    'src/screen/extensions/SourceView.tsx',
 'src/screen/prompts-panel/PromptsPanel.tsx',
 'src/screen/prompts-panel/panelParts.tsx',
 'src/screen/prompts-panel/CrewChatPanel.tsx',
  ],
  'board',
)

reg(
  [
    'src/screen/boot-face/splash/face.tsx',
    'src/screen/diff/DiffFileList.tsx',
    'src/screen/fullscreen-layout/HelmVitalsRail.tsx',
    'src/screen/composer/MercuryCommandPalette.tsx',
    'src/commands/model/picker/MercuryModelPicker.tsx',
    'src/screen/model-picker/renderLine.tsx',
    'src/boot/first-run/Onboarding.tsx',
    'src/screen/widgets/RailPanel.tsx',
    'src/screen/widgets/parity/accountRows.tsx',
    'src/screen/samples/SamplesListView.tsx',
  ],
  'shared-list',
)


reg(
  [
    'src/screen/composer/composerView.tsx',
    'src/screen/composer/text-input/BaseTextInput.tsx',
    'src/screen/composer/useComposerRawKeys.ts',
    'src/screen/concourse/ConcourseStrips.tsx',
  ],
  'editor',
)

reg(
  [
    'src/screen/scroll-keys/ScrollKeybindingHandler.tsx',
    'src/screen/virtual-message-list/VirtualMessageList.tsx',
    'src/screen/settings/Usage.tsx',
    'src/screen/settings/usage/compact.tsx',
    'src/screen/settings/usage/sections.tsx',
    'src/screen/overlays/PopupForm.tsx',
  ],
  'scroll-owner',
)

reg(
  [
    'src/permissions/cards/rule-manager/PermissionRuleList.tsx',
    'src/commands/appearance/appearance.tsx',
    'src/commands/caching/caching.tsx',
    'src/commands/context/context.tsx',
    'src/commands/health/HealthCertificate.tsx',
    'src/commands/effort/EffortPopup.tsx',
    'src/commands/run/run.tsx',
 'src/screen/boot-face/BootSettingsScreen.tsx',
 'src/screen/boot-face/settings/rows.tsx',
 'src/screen/concourse/RowPickModal.tsx',
    'src/screen/concourse/GroundPicker.tsx',
    'src/screen/concourse/SessionMirror.tsx',
    'src/screen/concourse/session-mirror/sessionMirrorView.tsx',
    'src/screen/concourse/SessionWaitingRoom.tsx',
 'src/screen/concourse/NeedsYouRail.tsx',
    'src/screen/chat/SwitchboardTagBar.tsx',
    'src/models/sign-in/flow-cards/CompatConnect.tsx',
    'src/models/sign-in/flow-cards/SignInFlow.tsx',
    'src/models/sign-in/flow-cards/enterKeys.tsx',
    'src/models/sign-in/flow-cards/openaiLegs.tsx',
    'src/models/sign-in/flow-cards/GeminiConnect.tsx',
    'src/models/sign-in/flow-cards/HuggingfaceConnect.tsx',
    'src/models/sign-in/flow-cards/OpenrouterConnect.tsx',
    'src/models/sign-in/flow-cards/KimiConnect.tsx',
    'src/models/sign-in/flow-cards/XaiConnect.tsx',
    'src/models/sign-in/flow-cards/MetaConnect.tsx',
    'src/models/sign-in/flow-cards/MistralConnect.tsx',
    'src/models/sign-in/flow-cards/NousConnect.tsx',
    'src/models/sign-in/flow-cards/ZenConnect.tsx',
    'src/models/sign-in/flow-cards/CohereConnect.tsx',
    'src/models/sign-in/flow-cards/MinimaxConnect.tsx',
    'src/models/sign-in/flow-cards/TogetherConnect.tsx',
    'src/commands/logins/login.tsx',
    'src/screen/boot-face/logins/DevinCliCard.tsx',
    'src/models/sign-in/flow-cards/LoginAccountCard.tsx',
    'src/models/sign-in/flow-cards/ZaiConnect.tsx',
    'src/models/sign-in/flow-cards/DeepseekConnect.tsx',
    'src/commands/submodels/SubModelPicker.tsx',
    'src/commands/feedback/BugReport.tsx',
    'src/screen/composer/MercuryContentSearch.tsx',
    'src/commands/exit/MercuryExitConfirm.tsx',
    'src/screen/composer/MercuryFileOpen.tsx',
    'src/screen/fullscreen-layout/MercuryFilesMenu.tsx',
    'src/screen/widgets/menuFold.tsx',
 'src/screen/input-atlas/MercuryInputAtlas.tsx',
 'src/screen/input-atlas/atlasView.tsx',
    'src/screen/model-picker/ModelPicker.tsx',
    'src/screen/session-chooser/SessionBrowser.tsx',
    'src/screen/mcp/ElicitationDialog.tsx',
    'src/commands/critter/CritterSelect.tsx',
    'src/commands/mcp/McpPopup.tsx',
 'src/screen/agents/studio/AgentStudio.tsx',
 'src/screen/agents/studio/StudioEditor.tsx',
    'src/screen/memory/MemoryCentreView.tsx',
    'src/screen/skills/SessionSkillsDial.tsx',
    'src/permissions/cards/ask-user-question/QuestionView.tsx',
    'src/screen/extensions/ApprovalCardView.tsx',
    'src/screen/extensions/ExtensionView.tsx',
    'src/screen/widgets/PaletteView.tsx',
    'src/screen/widgets/parity/CapabilityManagerView.tsx',
    'src/screen/widgets/parity/DaemonView.tsx',
    'src/screen/widgets/faces/CrewView.tsx',
    'src/models/sign-in/flow-cards/OpenaiConnect.tsx',

    'src/commands/trace/TraceView.tsx',
    'src/screen/keys/KeybindingProviderSetup.tsx',
    'src/screen/chat/useChatSearch.tsx',
    'src/screen/chat/ResumeSession.tsx',
    'src/screen/settings/config/ConfigViews.tsx',
    'src/screen/settings/config/useConfigKeys.ts',
    'src/screen/help/Commands.tsx',
    'src/screen/help/Help.tsx',
    'src/screen/settings/Jev.tsx',
    'src/screen/settings/LocalServer.tsx',
    'src/commands/llmhost/LlmHostDialog.tsx',
    'src/commands/localsetup/LocalSetupDialog.tsx',
    'src/screen/tasks/CrewmateDetailDialog.tsx',
    'src/screen/tasks/BackgroundTasksDialog.tsx',
    'src/screen/tasks/ShellDetailDialog.tsx',
    'src/commands/imagesetup/imagesetup.tsx',
    'src/models/sign-in/flow-cards/AnthropicKeyLeg.tsx',
    'src/screen/settings/Media.tsx',
  ],
  'modal-form',
)

reg(
  [
    'src/screen/select/Select.tsx',
    'src/screen/select/selectView.tsx',
    'src/screen/select/SelectMulti.tsx',
    'src/screen/select/SelectInputOption.tsx',
    'src/screen/select/useMultiSelectState.ts',
    'src/screen/select/useSelectInput.ts',
    'src/screen/theme/ThemedBox.tsx',
  ],
  'ink-primitive',
)

reg(
  [
    'src/permissions/cards/ask-user-question/PreviewQuestionView.tsx',
    'src/permissions/cards/ask-user-question/previewQuestionBody.tsx',
  ],
  'direct-control',
  'the interview preview workspace (MERCURY INTERVIEW IN-25): option rows and footer rows are single-purpose click targets with Select-owner parity — a click selects the CLICKED row; keyboard is complete without the pointer (the input-graph journey prover)',
)
reg(
  ['src/screen/fullscreen-layout/frame.tsx', 'src/screen/fullscreen-layout/panes.tsx'],
  'direct-control',
  'NewMessagesPill jump-to-tail — one true single-purpose control',
)
reg(
  ['src/commands/exit/ExitHandoff.tsx'],
  'direct-control',
  'the exit handoff notice while the note for the next session is written: one ctrl-c chord aborts the ask (useInput), no pointer, no selection, nothing else to own',
)
reg(
  ['src/screen/fullscreen-layout/CompactIdentityBand.tsx', 'src/screen/widgets/MiniCritter.tsx'],
  'direct-control',
  'the compact critter berth (the deck dock and the session card): one click cycles the session critter at every size, the same single-purpose control the hero berth carries — no hover paint, no selection state',
)
reg(
  ['src/screen/tasks/CompactWorkSummary.tsx'],
  'direct-control',
  'one click focuses the compact work summary; the task-toggle binding reaches the same focus gate without a pointer',
)
reg(
  [
    'src/screen/composer/ComposerFooterLeftSide.tsx',
    'src/screen/composer/footerLeftSideView.tsx',
  ],
  'direct-control',
  'footer mode chips — single-purpose toggles',
)
reg(
  ['src/screen/composer/ComposerFooterSuggestions.tsx'],
  'direct-control',
  'completion popup: hover PRESELECTS (drives the autocomplete selection, not a paint) and one click commits — the editor-domain convention; select-then-activate would break completion UX',
)

reg(
  [
    'src/screen/messages/SystemTextMessage.tsx',
    'src/screen/tasks/BackgroundTaskStatus.tsx',
    'src/screen/widgets/faces/SessionManagerView.tsx',
    'src/screen/widgets/faces/session-manager/views.tsx',
    'src/screen/fullscreen-layout/HelmLanesRail.tsx',
  ],
  'shared-list',
)
reg(
  ['src/screen/fullscreen-layout/MercuryHome.tsx'],
  'direct-control',
  'hero critter-morph clicks on authored art (the animated-hero class); the glance rows AND the berth ride the kernel (home:row:* · berth:critter with hover-lit art)',
)

const unclassified = [...found.keys()].filter(f => !REGISTRY.has(f)).sort()
t(
  'every interaction site is classified',
  unclassified.length === 0,
  unclassified.join(', '),
  'add each listed file to a reg([...], klass) call in scripts/interaction/prove-interaction-coverage.ts, choosing the class that matches how it handles pointer and keys',
)

const ghosts = [...REGISTRY.keys()].filter(f => !found.has(f)).sort()
t(
  'no registered site has gone silent (delete leavers)',
  ghosts.length === 0,
  ghosts.join(', '),
  'remove each listed path from its reg([...]) call in scripts/interaction/prove-interaction-coverage.ts (the file no longer exists or no longer matches a SIGNALS pattern)',
)

const legacyViolations = [...found.entries()]
  .filter(([f, sigs]) => (sigs.includes('specimen') || sigs.includes('selectrow')))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return k !== 'legacy-list' && k !== 'kernel'
  })
  .map(([f]) => f)
t(
  'the old list grammar gains no new consumers',
  legacyViolations.length === 0,
  legacyViolations.join(', '),
  'move each listed file off useSpecimenNav/<SelectRow onto the shared list kernel (InteractiveRow, NavigablePanes or useFlatList under src/screen/widgets)',
)

const pointerViolations = [...found.entries()]
  .filter(([, sigs]) => sigs.includes('click') || sigs.includes('hover'))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return !k || k === 'modal-form' || k === 'board'
  })
  .map(([f]) => f)
t(
  'every raw pointer site is a kernel/primitive/registered control',
  pointerViolations.length === 0,
  pointerViolations.join(', '),
  'each listed file uses onClick/onMouseEnter outside the kernel: render its rows with InteractiveRow (src/screen/widgets/InteractiveRow.tsx), or register it as a direct-control with a reason in scripts/interaction/prove-interaction-coverage.ts',
)

const unreasoned = [...REGISTRY.entries()]
  .filter(([, v]) => v.klass === 'direct-control' && !v.reason)
  .map(([f]) => f)
t(
  'every direct control carries its justification',
  unreasoned.length === 0,
  unreasoned.join(', '),
  "pass a reason string as the third argument of each listed file's reg(..., 'direct-control', reason) call in scripts/interaction/prove-interaction-coverage.ts",
)

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
  'at each listed file:line, derive the id/label from the row key (a stable id) instead of the loop index',
)

const counts = new Map<Klass, number>()
for (const [f] of found) {
  const k = REGISTRY.get(f)?.klass
  if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
}
console.log('\n  estate:', [...counts.entries()].map(([k, n]) => `${k}=${n}`).sort().join(' · '))

process.exit(fail)
