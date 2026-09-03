#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

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

const found = new Map<string, string[]>()
for (const root of SCAN_ROOTS) {
  for (const p of walk(path.join(ROOT, root))) {
    const src = readFileSync(p, 'utf8')
    const sigs = SIGNALS.filter(([, re]) => re.test(src)).map(([n]) => n)
    if (sigs.length > 0) found.set(path.relative(ROOT, p), sigs)
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
    'src/components/mercury-ui/InteractiveRow.tsx',
    'src/components/mercury-ui/InteractiveDisclosure.tsx',
    'src/components/mercury-ui/NavigablePanes.tsx',
    'src/components/mercury-ui/useNavigablePanes.ts',
    'src/components/mercury-ui/useFlatList.ts',
    'src/components/mercury-ui/useInteractiveList.ts',
    'src/components/mercury-ui/components.tsx',
    'src/keybindings/useKeybinding.ts',
    'src/components/SurfaceExitChord.tsx',
  ],
  'kernel',
)

reg(
  [
    'src/components/BootSaturnScreen.tsx',
    'src/components/BootAgentsScreen.tsx',
    'src/components/BootLoginsScreen.tsx',
    'src/components/BootHealthScreen.tsx',
    'src/components/BootResumeScreen.tsx',
    'src/components/KitMenuScreen.tsx',
    'src/components/LedgerView.tsx',
    'src/components/RouterBoard.tsx',
 'src/components/concourse/ConcourseScreen.tsx',
 'src/components/concourse/ConcourseLayout.tsx',
 'src/components/concourse/ConcourseHeader.tsx',
 'src/components/concourse/ConcourseStrips.tsx',
 'src/components/concourse/ConcourseRoute.tsx',
    'src/components/concourse/SplitChatPane.tsx',
    'src/components/concourse/CoordinatorPane.tsx',
    'src/components/extensions/ExtensionsBoard.tsx',
    'src/components/extensions/SourceView.tsx',
    'src/components/tasks/WorkflowsBoard.tsx',
    'src/components/mercury-ui/screens/MonitorView.tsx',
 'src/components/prompts-panel/PromptsPanel.tsx',
  ],
  'board',
)

reg(
  [
    'src/components/BootSplashScreen.tsx',
    'src/components/diff/DiffFileList.tsx',
    'src/components/HelmCenterHeader.tsx',
    'src/components/HelmTelemetryRail.tsx',
    'src/components/MercuryCommandPalette.tsx',
    'src/components/MercuryModelPicker.tsx',
    'src/components/Onboarding.tsx',
    'src/components/mercury-ui/RailPanel.tsx',
    'src/components/mercury-ui/ManagerView.tsx',
    'src/components/mercury-ui/SupercodeModeView.tsx',
    'src/components/mercury-ui/parity/AccountView.tsx',
    'src/components/mercury-ui/parity/HarnessView.tsx',
    'src/components/mercury-ui/parity/RealmsView.tsx',
    'src/components/mercury-ui/screens/SettingsStatusView.tsx',
    'src/components/mercury-ui/SessionTabs.tsx',
  ],
  'shared-list',
)


reg(
  [
    'src/components/BaseTextInput.tsx',
    'src/components/PromptInput/PromptInput.tsx',
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
    'src/commands/caching/caching.tsx',
    'src/commands/console/console.tsx',
    'src/commands/copy/copy.tsx',
    'src/commands/health/HealthCertificate.tsx',
    'src/commands/effort/EffortSlider.tsx',
    'src/commands/home/home.tsx',
    'src/commands/run/run.tsx',
 'src/components/BootSettingsScreen.tsx',
 'src/components/concourse/CoordinatorModelPicker.tsx',
 'src/components/concourse/RowPickModal.tsx',
    'src/components/concourse/GroundPicker.tsx',
    'src/components/concourse/SessionMirror.tsx',
    'src/components/concourse/SessionWaitingRoom.tsx',
 'src/components/concourse/ManagerCards.tsx',
 'src/components/concourse/NeedsYouRail.tsx',
    'src/components/SwitchboardTagBar.tsx',
    'src/components/ConsoleOAuthFlow.tsx',
    'src/components/GeminiConnect.tsx',
    'src/components/HuggingfaceConnect.tsx',
    'src/components/RouterOpenrouterConnect.tsx',
    'src/components/KimiConnect.tsx',
    'src/components/ZaiConnect.tsx',
    'src/components/DeepseekConnect.tsx',
    'src/components/SubModelPicker.tsx',
    'src/components/Feedback.tsx',
    'src/components/FleetMonitor.tsx',
    'src/components/MercuryConfig.tsx',
    'src/components/MercuryContentSearch.tsx',
    'src/components/MercuryExitConfirm.tsx',
    'src/components/MercuryFileOpen.tsx',
    'src/components/MercuryFleetChat.tsx',
 'src/components/MercuryInputAtlas.tsx',
    'src/components/MercuryLanguagePicker.tsx',
    'src/components/MercuryMcpList.tsx',
    'src/components/MercuryMemorySelector.tsx',
    'src/components/ModelPicker.tsx',
    'src/components/MercuryPermissionsPanel.tsx',
    'src/components/MercuryQuickOpen.tsx',
    'src/components/MercuryResume.tsx',
    'src/components/MercurySearch.tsx',
    'src/components/MercuryShowcase.tsx',
    'src/components/LogSelector.tsx',
    'src/components/mcp/ElicitationDialog.tsx',
    'src/components/mcp/MCPRemoteServerMenu.tsx',
 'src/components/agents/studio/AgentStudio.tsx',
 'src/components/agents/studio/StudioEditor.tsx',
    'src/components/memory/MemoryCentreView.tsx',
    'src/components/skills/SessionSkillsDial.tsx',
    'src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx',
    'src/components/permissions/rules/RecentDenialsTab.tsx',
    'src/components/tabula/MinervaRoom.tsx',
    'src/components/extensions/ApprovalCardView.tsx',
    'src/components/extensions/ExtensionView.tsx',
    'src/components/tasks/AgentInspectorPane.tsx',
    'src/components/tasks/RunDetailPane.tsx',
    'src/components/teams/TeamsDialog.tsx',
    'src/components/mercury-ui/PaletteView.tsx',
    'src/components/mercury-ui/SpecimenGallery.tsx',
    'src/components/mercury-ui/parity/CapabilityManagerView.tsx',
    'src/components/mercury-ui/parity/DaemonSupervisorView.tsx',
    'src/components/mercury-ui/screens/TeammateChatsView.tsx',
    'src/components/mercury-ui/screens/CrewView.tsx',
    'src/components/RouterKeyEntry.tsx',
    'src/components/RouterOpenaiConnect.tsx',

    'src/components/TraceView.tsx',
    'src/keybindings/KeybindingProviderSetup.tsx',
    'src/screens/REPL.tsx',
    'src/screens/ResumeConversation.tsx',
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

reg(
  [
    'src/components/CockpitView.tsx',
    'src/components/messages/SystemTextMessage.tsx',
    'src/components/tasks/BackgroundTaskStatus.tsx',
    'src/components/mercury-ui/screens/SessionManagerView.tsx',
    'src/components/HelmLanesRail.tsx',
  ],
  'shared-list',
)
reg(
  ['src/components/MercuryHome.tsx'],
  'direct-control',
  'hero critter-morph clicks on authored art (the animated-hero class); the glance rows AND the berth ride the kernel (home:row:* · berth:critter with hover-lit art)',
)

const unclassified = [...found.keys()].filter(f => !REGISTRY.has(f)).sort()
t('every interaction site is classified', unclassified.length === 0, unclassified.join(', '))

const ghosts = [...REGISTRY.keys()].filter(f => !found.has(f)).sort()
t('no registered site has gone silent (delete leavers)', ghosts.length === 0, ghosts.join(', '))

const legacyViolations = [...found.entries()]
  .filter(([f, sigs]) => (sigs.includes('specimen') || sigs.includes('selectrow')))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return k !== 'legacy-list' && k !== 'kernel'
  })
  .map(([f]) => f)
t('the old list grammar gains no new consumers', legacyViolations.length === 0, legacyViolations.join(', '))

const pointerViolations = [...found.entries()]
  .filter(([, sigs]) => sigs.includes('click') || sigs.includes('hover'))
  .filter(([f]) => {
    const k = REGISTRY.get(f)?.klass
    return !k || k === 'modal-form' || k === 'board'
  })
  .map(([f]) => f)
t('every raw pointer site is a kernel/primitive/registered control', pointerViolations.length === 0, pointerViolations.join(', '))

const unreasoned = [...REGISTRY.entries()]
  .filter(([, v]) => v.klass === 'direct-control' && !v.reason)
  .map(([f]) => f)
t('every direct control carries its justification', unreasoned.length === 0, unreasoned.join(', '))

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

const counts = new Map<Klass, number>()
for (const [f] of found) {
  const k = REGISTRY.get(f)?.klass
  if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
}
console.log('\n  estate:', [...counts.entries()].map(([k, n]) => `${k}=${n}`).sort().join(' · '))

process.exit(fail)
