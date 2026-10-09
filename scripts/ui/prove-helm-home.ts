#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')
const readIf = (p: string) => (existsSync(join(REPO, p)) ? read(p) : '')

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

const fullscreen = read('src/utils/fullscreen.ts')
const layout = read('src/components/FullscreenLayout.tsx')
const geometry = read('src/utils/helmGeometry.ts')
const lanes = read('src/components/HelmLanesRail.tsx') + read('src/utils/cockpit/helmLanesModel.ts')
const vitals = read('src/components/HelmVitalsRail.tsx')
const welcome = read('src/components/MercuryHome.tsx')
const frame = read('src/components/MercuryFrame.tsx')

console.log('============================================================')
console.log(' prove-helm-home — A2.2 cockpit invariants')
console.log('============================================================')

const gateFn = fullscreen.slice(fullscreen.indexOf('export function isHelmHomeEnabled'))
  .slice(0, 400)
check('isHelmHomeEnabled: =0 the only opt-out, default-ON ', /isEnvDefinedFalsy\(flagEnv\('MERCURY_HELM_HOME'\)\)\) return false/.test(gateFn) && /return true/.test(gateFn))
check('isHelmHomeEnabled gates on isFullscreenEnvEnabled()', /isFullscreenEnvEnabled\(\)/.test(gateFn))
check('isHelmHomeEnabled honors MERCURY_HELM_HOME=0 opt-out (legacy spelling via the registry alias)', /MERCURY_HELM_HOME/.test(gateFn) && /isEnvDefinedFalsy/.test(gateFn))
check('isHelmHomeEnabled is default-ON (returns true tail)', /return true/.test(gateFn))

const fnStart = layout.indexOf('export function FullscreenLayout')
const fnBody = layout.slice(fnStart)
check('FullscreenLayout is DE-MEMOIZED (no `const $ = _c(` decl)', !/const \$ = _c\(/.test(fnBody))
check('FullscreenLayout body has no $[<n>] cache slot reads', !/\$\[\d/.test(fnBody))
check('FullscreenLayout reads the shared physical-geometry decision for the cockpit',
  /useLayoutChrome\(\)/.test(fnBody) && /chrome === 'cockpit'/.test(fnBody))
check('FullscreenLayout mounts rails off railPlan (center-first shed)',
  /railPlan\(columns\)/.test(fnBody) && /plan\.vitals/.test(fnBody))
check('FullscreenLayout composes both rails inline (HelmHome absorbed)',
  /<HelmLanesRail/.test(fnBody) && /<HelmVitalsRail/.test(fnBody))
check('FullscreenLayout keeps the deck-strip path (byte-identical OFF/narrow)',
  /chrome === 'deck-strip'/.test(fnBody) && /<DeckPane/.test(fnBody))
check('M3: cockpit + deck toggle as siblings, providers always mounted (stable root)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(fnBody) &&
  /TerminalSizeContext\.Provider value=\{sizeVal\}/.test(fnBody) &&
  /\{fullscreen && !isCompact && chrome === 'deck-strip' \? <DeckPane \/> : null\}/.test(fnBody))
check('M3: no separate <HelmHome> root (absorbed → no root-type flip)', !/<HelmHome/.test(fnBody))
check('P3-continuity: rails stay mounted under a modal (visual claim only)',
  /const cockpit = fullscreen && chrome === 'cockpit'\n/.test(fnBody) &&
  !/const cockpit = fullscreen && chrome === 'cockpit' && !modalUp/.test(fnBody))
check('M2: modal spans the full terminal in every chrome',
  /"▔"\.repeat\(Math\.max\(1, columns\)\)/.test(fnBody) &&
  /rows: Math\.max\(0, terminalRows - modalPeek - modalSeparatorRows\),\s*columns,/.test(fnBody))
check('P3-continuity: rail input parks while a modal is up',
  /const reachable = cockpit && !modalUp\s*setHelmVitalsAvailable\(reachable && plan\.vitals\)\s*if \(!reachable\) setHelmFocus\('prompt'\)/.test(fnBody))
check('P3: surface claims full height (peek 0) in cockpit + deck-strip, default peek inline',
  /const modalPeek = isCompact \? 0 : chrome === 'inline' \? 2 : 0/.test(fnBody) &&
  /maxHeight=\{Math\.max\(0, terminalRows - modalPeek\)\}/.test(fnBody))

check('helmGeometry exports HELM_HOME_MIN_COLS = 100', /export const HELM_HOME_MIN_COLS\s*=\s*100/.test(geometry))
check('helmGeometry exports helmCenterCols + HELM_RAIL_W (one source for the math)',
  /export function helmCenterCols/.test(geometry) && /export const HELM_RAIL_W/.test(geometry))

check('M1: MercuryFrame keys vital-shed on CockpitActiveContext (not the overridden width; RB-01: never beneath a route surface)',
  /const helmActive = useContext\(CockpitActiveContext\) && !routeSurface/.test(frame))
check('M1: deck-owned shed is false in cockpit (model/cost/branch kept; RB-01 route-surface guard)',
  /const deckPresent = !routeSurface && isDeckPaneActive\(\) && !helmActive/.test(frame))
check('M1: usage shed under a vital-PAINTING deck OR the cockpit (width-aware: a deck below the cockpit threshold paints no vitals and owns none; RB-01 route-surface guard)',
  /usageOwnedElsewhere = !routeSurface && \(deckOwnsVitals \|\| helmActive\)/.test(frame) &&
  /deckOwnsVitals = deckPresent && cols >= LAYOUT_BREAKPOINTS\.cockpitMin/.test(frame) &&
  /!usageOwnedElsewhere \? usageNode/.test(frame))

check('the rail paints no SEAT section (no seat key, label, self row or peer cap)',
  !/section\('seat'/.test(lanes) && !/'SEAT'/.test(lanes) && !/\(you\)/.test(lanes) && !/PEER_ROWS/.test(lanes) && !/peerWord/.test(lanes))
check('the rail imports nothing from presence (no presence store, seat type or operator name)',
  !/presenceLive/.test(lanes) && !/getLivePresence|subscribePresence|getPresenceVersion|PresenceSeat|getOperatorName/.test(lanes))
check('the presence estate is gone (no module, no cockpit re-export, no DeckPane seats row, no MCP heartbeat)',
  !existsSync(join(REPO, 'src/utils/cockpit/presenceLive.ts')) &&
    !/presenceLive/.test(read('src/utils/cockpit/index.ts')) &&
    !/getLivePresence|subscribePresence|seats\.length/.test(read('src/components/DeckPane.tsx')) &&
    !/recordSelfPresence|startPresenceTail|PRESENCE_HEARTBEAT_MS/.test(read('src/services/mcp/useManageMCPConnections.ts')) &&
    !/collectPresenceSeats|presence-seats/.test(read('src/substrate/stateLifecycle.ts')))
check("the operator's display name lives in its own identity module and the flag registry names it",
  /export function getOperatorName\(\): string/.test(readIf('src/substrate/identity/operatorDisplayName.ts')) &&
    /consumer: 'src\/substrate\/identity\/operatorDisplayName\.ts'/.test(read('src/substrate/flagRegistry.ts')) &&
    !/presenceLive/.test(read('src/substrate/flagRegistry.ts')))
check("'seat' left the density floor", !/'seat'/.test(read('src/utils/helmDensity.ts')))
check('CREW sources from app-store tasks, not a fleetGauge() call',
  /useAppState\(s => s\.tasks\)/.test(lanes) && !/fleetGauge\(/.test(lanes))
check('CREW rows keep .id (the drill-in key)', /id: t\.id/.test(lanes))
check('drill-in REUSES the existing nav state (viewingAgentTaskId), not a reinvented swap',
  /viewingAgentTaskId/.test(lanes) && !/setAppState\(\{ viewingAgentTaskId/.test(lanes))
const workRosterSrc = read('src/utils/task/workRoster.ts')
const crewFactsSrc = read('src/services/engine-connector/crewFacts.ts')
const crewLedgerSrc = read('src/state/crewLedger.ts')
check('S8: CREW sources the projected roster through the crew predicate (the projector leaves the main session out), through the session crew ledger',
  /useSessionCrew\(\)/.test(lanes) &&
    /crewAgentsOf\(projectWorkRoster\(kept\), sessionId\)/.test(crewLedgerSrc) &&
    workRosterSrc.includes("if (task.agentType === 'main-session') continue") &&
    /return row\.kind === 'agent'$/m.test(crewFactsSrc))
check("CREW joins the focused session's hosted agents from the work roster (one owner; the counting law's predicate), keeps every crewmate the session has had — never filtered to the running ones — and pulls the viewed or pinned row into the cap",
  /crewAgentsOf\(roster\.rows, sessionId\)/.test(crewLedgerSrc) && !/\.filter\(f => f\.running/.test(lanes) && /keptIds\.includes\(c\.id\)/.test(lanes) && /running: workRowRuns\(row\)/.test(crewFactsSrc))
check('a hosted CREW row opens the agent in the view (the crewmate road), never a /runs command',
  /\{ kind: 'crewmate', id: c\.id, label: c\.hosted \? `crew:h:\$\{c\.id\}` : c\.label \}/.test(lanes) && !/command: `\/(runs|tasks) \$\{c\.id\}`/.test(lanes))
check('M4: CREW is capped (slice CREW_ROWS) with a +N more overflow',
  /slice\(0, CREW_ROWS\)/.test(lanes) && /MoreRow/.test(lanes))
check('no TASKS card: the rail builds no ledger section or rows of its own',
  !/section\('tasks'/.test(lanes) && !/missionNodes/.test(lanes) && !/'TASKS'/.test(lanes) && !/no open tasks/.test(lanes))
check('RUNS is the one rail door to the /runs board (header opens /runs)',
  /key: 'runs', glyph: GLYPH\.turns, label: 'RUNS', count: `\$\{runsLive\} live`, open: '\/runs', rows/.test(lanes))
check('a ledger alone never forces the busy layout (the solo gate reads crew, the viewed or pinned crewmate and runs only — no peers term)',
  /return input\.sessionCrew\.length === 0 && keptIds\.length === 0 && runsOf\(input\.tasks, input\.roster\)\.length === 0/.test(lanes) && !/ledgerOpen/.test(lanes) && !/peers\.length/.test(lanes))
check('S4: the dead selectedCaret/focus path is removed from the rail',
  !/selectedCaret/.test(lanes) && !/onCursorMax/.test(lanes))

check('RUNS: kind derives from the task shape (isLocalShellTask + kind monitor)',
  /isLocalShellTask\(t\)/.test(lanes) && /'monitor' \? 'monitor' : 'shell'/.test(lanes))
check('RUNS: agent tasks are excluded (they live in CREW)',
  /!isLocalAgentTask\(t\)/.test(lanes))
check('RUNS: running rows rotate (glyphLive → WorkingGlyph in RailRow)',
  /glyphLive: live,/.test(lanes) && /glyphLive=\{spec\.glyphLive\}/.test(lanes) && /glyphLive \? \(\s*<WorkingGlyph color=\{glyphColor\} active \/>/m.test(lanes))
check('RUNS: verb carries kind + live elapsed (formatSpan)',
  /\$\{r\.kind\} \$\{formatSpan\(nowMs - r\.startedAtMs\)\}/.test(lanes) && /const nowMs = Date\.now\(\)/.test(lanes))
check('RUNS: lane is capped (RUNS_ROWS) with a +N more overflow',
  /slice\(0, RUNS_ROWS\)/.test(lanes) && /runsMore/.test(lanes))
check('RUNS: rows drill to the SPECIFIC task card (/runs <id>)',
  /command: `\/runs \$\{r\.id\}`/.test(lanes))
check('RUNS: elapsed floors on a stamped start (never an epoch span)',
  /live && r\.startedAtMs > 0 \?/.test(lanes))
check('MoreRow has click parity (requestHelmRowActivation on click)',
  /function MoreRow\([\s\S]{0,900}requestHelmRowActivation\('lanes', rowIndex\)/.test(lanes))
check('RUNS: a live run is never "solo" (runsAll gates the empty-state)',
  /runsOf\(input\.tasks, input\.roster\)\.length === 0/.test(lanes))
check('RUNS: elapsed stays honest while runs live (the 15s tick arms on runsLive)',
  /useNowTick\(\s*mergedVitals \|\| model\.runsLive > 0 \? 15_000 : null,?\s*\)/.test(lanes))
check('CREW: running agent rows rotate too (one liveness grammar; an idle crewmate, the viewed ◉ and main-chat ★ marks stand still)',
  /const live = c\.status === 'running' && !idle\n/.test(lanes) && /glyphLive: live && !isViewing && !isMainChat,/.test(lanes))

check('vitals rail renders the ctx-fill gauge (getLiveContextUsage)',
  /getLiveContextUsage/.test(vitals) && /ctx /.test(vitals))

check('MercuryHome sheds the fleet glance when the cockpit owns it', /helmHome \?/.test(welcome) || /!helmHome/.test(welcome))
check('the shed keys on CockpitActiveContext (decoupled from the overridden width)',
  /const helmHome = useContext\(CockpitActiveContext\)/.test(welcome))
check('FullscreenLayout overrides center width (TerminalSizeContext) so the transcript wraps in-column',
  /TerminalSizeContext\.Provider/.test(layout) && /plan\.centerCols/.test(layout))
check('FullscreenLayout provides CockpitActiveContext = cockpit (true only when rails show)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(layout))

for (const [name, src] of [['HelmLanesRail', lanes], ['HelmVitalsRail', vitals]] as const) {
  check(`${name}: no inline #E07A50 (token only)`, !/#E07A50/i.test(src))
  check(`${name}: no raw 6-digit hex literal`, !/#[0-9A-Fa-f]{6}\b/.test(src))
}

console.log('============================================================')
if (failures === 0) console.log('✅ HELM-HOME PROOF PASS')
else console.log(`❌ HELM-HOME PROOF: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
