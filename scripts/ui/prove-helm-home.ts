#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(REPO, p), 'utf8')

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

const fullscreen = read('src/utils/fullscreen.ts')
const layout = read('src/components/FullscreenLayout.tsx')
const geometry = read('src/utils/helmGeometry.ts')
const lanes = read('src/components/HelmLanesRail.tsx')
const telemetry = read('src/components/HelmTelemetryRail.tsx')
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
check('FullscreenLayout size-gates the cockpit via chromeModeLive(columns, rows) — the hysteresis-latched entry',
  /chromeModeLive\(columns, terminalRows\)/.test(fnBody) && /chrome === 'cockpit'/.test(fnBody))
check('FullscreenLayout mounts rails off railPlan (center-first shed)',
  /railPlan\(columns\)/.test(fnBody) && /plan\.telemetry/.test(fnBody))
check('FullscreenLayout composes both rails inline (HelmHome absorbed)',
  /<HelmLanesRail/.test(fnBody) && /<HelmTelemetryRail/.test(fnBody))
check('FullscreenLayout keeps the deck-strip path (byte-identical OFF/narrow)',
  /chrome === 'deck-strip'/.test(fnBody) && /<DeckPane/.test(fnBody))
check('M3: cockpit + deck toggle as siblings, providers always mounted (stable root)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(fnBody) &&
  /TerminalSizeContext\.Provider value=\{sizeVal\}/.test(fnBody) &&
  /\{fullscreen && chrome === 'deck-strip' \? <DeckPane \/> : null\}/.test(fnBody))
check('M3: no separate <HelmHome> root (absorbed → no root-type flip)', !/<HelmHome/.test(fnBody))
check('P3-continuity: rails stay mounted under a modal (visual claim only)',
  /const cockpit = fullscreen && chrome === 'cockpit'\n/.test(fnBody) &&
  !/const cockpit = fullscreen && chrome === 'cockpit' && !modalUp/.test(fnBody))
check('M2: modal spans the full terminal in every chrome',
  /"▔"\.repeat\(Math\.max\(1, columns\)\)/.test(fnBody) &&
  /rows: terminalRows - modalPeek - 1,\s*columns,/.test(fnBody))
check('P3-continuity: rail input parks while a modal is up',
  /const reachable = cockpit && !modalUp\s*setHelmTelemetryAvailable\(reachable && plan\.telemetry\)\s*if \(!reachable\) setHelmFocus\('prompt'\)/.test(fnBody))
check('P3: surface claims full height (peek 0) in cockpit + deck-strip, default peek inline',
  /const modalPeek = chrome === 'inline' \? 2 : 0/.test(fnBody) &&
  /maxHeight=\{terminalRows - modalPeek\}/.test(fnBody))

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

check('SEAT uses getPresenceVersion as the sync snapshot (NOT getLivePresence)',
  /useSyncExternalStore\(subscribePresence, getPresenceVersion, getPresenceVersion\)/.test(lanes))
check('SEAT does NOT pass getLivePresence as a useSyncExternalStore arg (no infinite render)',
  !/useSyncExternalStore\([^)]*getLivePresence/.test(lanes))
check('CREW sources from app-store tasks, not a fleetGauge() call',
  /useAppState\(s => s\.tasks\)/.test(lanes) && !/fleetGauge\(/.test(lanes))
check('CREW rows keep .id (the drill-in key)', /id: t\.id/.test(lanes))
check('drill-in REUSES the existing nav state (viewingAgentTaskId), not a reinvented swap',
  /viewingAgentTaskId/.test(lanes) && !/setAppState\(\{ viewingAgentTaskId/.test(lanes))
check('S8: CREW sources panel agents (excludes main-session leak)', /\.filter\(isPanelAgentTask\)/.test(lanes))
check('M4: CREW is capped (slice CREW_ROWS) with a +N more overflow',
  /slice\(0, CREW_ROWS\)/.test(lanes) && /MoreRow/.test(lanes))
check('S2: SEAT peers are capped (slice PEER_ROWS)', /slice\(0, PEER_ROWS\)/.test(lanes))
check('S4: the dead selectedCaret/focus path is removed from the rail',
  !/selectedCaret/.test(lanes) && !/onCursorMax/.test(lanes))

check('RUNS: kind derives from the task shape (isLocalShellTask + kind monitor)',
  /isLocalShellTask\(t\)/.test(lanes) && /'monitor' \? 'monitor' : 'shell'/.test(lanes))
check('RUNS: agent tasks are excluded (they live in CREW)',
  /!isLocalAgentTask\(t\) && !isInProcessTeammateTask\(t\)/.test(lanes))
check('RUNS: running rows rotate (glyphLive → WorkingGlyph in RailRow)',
  /glyphLive=\{live\}/.test(lanes) && /glyphLive \? \(\s*<WorkingGlyph color=\{glyphColor\} active \/>/m.test(lanes))
check('RUNS: verb carries kind + live elapsed (formatSpan)',
  /\$\{r\.kind\} \$\{formatSpan\(Date\.now\(\) - r\.startedAtMs\)\}/.test(lanes))
check('RUNS: lane is capped (RUNS_ROWS) with a +N more overflow',
  /slice\(0, RUNS_ROWS\)/.test(lanes) && /runsMore/.test(lanes))
check('RUNS: rows drill to the SPECIFIC task card (/tasks <id>)',
  /command: `\/tasks \$\{r\.id\}`/.test(lanes))
check('RUNS: elapsed floors on a stamped start (never an epoch span)',
  /live && r\.startedAtMs > 0 \?/.test(lanes))
check('MoreRow has click parity (requestHelmRowActivation on click)',
  /function MoreRow\([\s\S]{0,900}requestHelmRowActivation\('lanes', rowIndex\)/.test(lanes))
check('RUNS: a live run is never "solo" (runsAll gates the empty-state)',
  /runsAll\.length === 0 &&/.test(lanes))
check('RUNS: elapsed stays honest while runs live (the 15s tick arms on runsLive; 1s while a MINERVA ask is in flight)',
  /useNowTick\(\s*getMinervaPending\(\) \? 1_000 : mergedTelemetry \|\| runsLive > 0 \? 15_000 : null,?\s*\)/.test(lanes))
check('CREW: running agent rows rotate too (one liveness grammar)',
  /glyphLive=\{c\.status === 'running'\}/.test(lanes))

check('telemetry rail renders the ctx-fill gauge (getLiveContextUsage)',
  /getLiveContextUsage/.test(telemetry) && /ctx /.test(telemetry))

check('MercuryHome sheds the fleet glance when the cockpit owns it', /helmHome \?/.test(welcome) || /!helmHome/.test(welcome))
check('the shed keys on CockpitActiveContext (decoupled from the overridden width)',
  /const helmHome = useContext\(CockpitActiveContext\)/.test(welcome))
check('FullscreenLayout overrides center width (TerminalSizeContext) so the transcript wraps in-column',
  /TerminalSizeContext\.Provider/.test(layout) && /plan\.centerCols/.test(layout))
check('FullscreenLayout provides CockpitActiveContext = cockpit (true only when rails show)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(layout))

for (const [name, src] of [['HelmLanesRail', lanes], ['HelmTelemetryRail', telemetry]] as const) {
  check(`${name}: no inline #E07A50 (token only)`, !/#E07A50/i.test(src))
  check(`${name}: no raw 6-digit hex literal`, !/#[0-9A-Fa-f]{6}\b/.test(src))
}

console.log('============================================================')
if (failures === 0) console.log('✅ HELM-HOME PROOF PASS')
else console.log(`❌ HELM-HOME PROOF: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
