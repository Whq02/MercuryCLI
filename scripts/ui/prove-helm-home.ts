#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-helm-home.ts — source proof for the A2.2 Helm cockpit home.
//  Joins the UI gate (scripts/ui/run-all.sh globs prove-*.ts). Locks the
//  load-bearing invariants so a later edit can't silently regress them. Each
//  assertion is mutation-meaningful: it fails under the obvious break.
//
//  Render-verify (the cockpit actually paints) is render-helm-home.ts; this is
//  the cheap source net.
// ============================================================================
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

// --- gate (Phase 2/3) -----------------------------------------------------
const gateFn = fullscreen.slice(fullscreen.indexOf('export function isHelmHomeEnabled'))
  .slice(0, 400)
check('isHelmHomeEnabled: =0 the only opt-out, default-ON ', /isEnvDefinedFalsy\(flagEnv\('MERCURY_HELM_HOME'\)\)\) return false/.test(gateFn) && /return true/.test(gateFn))
check('isHelmHomeEnabled gates on isFullscreenEnvEnabled()', /isFullscreenEnvEnabled\(\)/.test(gateFn))
check('isHelmHomeEnabled honors MERCURY_HELM_HOME=0 opt-out (legacy spelling via the registry alias)', /MERCURY_HELM_HOME/.test(gateFn) && /isEnvDefinedFalsy/.test(gateFn))
check('isHelmHomeEnabled is default-ON (returns true tail)', /return true/.test(gateFn))

// --- FullscreenLayout: hand-written + width-gated branch -------------------
// Bound the slice at the pill helper that follows the function so we don't catch
// the OTHER (still-compiled) helpers below. Assert against CODE, not the doc
// comment (which legitimately MENTIONS `_c(47)` / `$[]` while explaining the
// conversion) — the real memo signal is the `const $ = _c(` decl + `$[<digit>]`.
const fnStart = layout.indexOf('export function FullscreenLayout')
const fnBody = layout.slice(fnStart)
check('FullscreenLayout is DE-MEMOIZED (no `const $ = _c(` decl)', !/const \$ = _c\(/.test(fnBody))
check('FullscreenLayout body has no $[<n>] cache slot reads', !/\$\[\d/.test(fnBody))
// Phase 3d: the chrome decision moved to computeChromeMode (useLayoutTier),
// which width-gates the cockpit on LAYOUT_BREAKPOINTS.cockpitMin (=
// HELM_HOME_MIN_COLS) and reads the gates LIVE per render.
// the gate became SIZE-aware (columns AND rows — the 90×18
// prompt-clip class) and the rails mount off the center-first railPlan.
check('FullscreenLayout size-gates the cockpit via chromeModeLive(columns, rows) — the hysteresis-latched entry',
  /chromeModeLive\(columns, terminalRows\)/.test(fnBody) && /chrome === 'cockpit'/.test(fnBody))
check('FullscreenLayout mounts rails off railPlan (center-first shed)',
  /railPlan\(columns\)/.test(fnBody) && /plan\.telemetry/.test(fnBody))
check('FullscreenLayout composes both rails inline (HelmHome absorbed)',
  /<HelmLanesRail/.test(fnBody) && /<HelmTelemetryRail/.test(fnBody))
check('FullscreenLayout keeps the deck-strip path (byte-identical OFF/narrow)',
  /chrome === 'deck-strip'/.test(fnBody) && /<DeckPane/.test(fnBody))
// M3: ONE stable root — no per-width `return <X>` that flips the root element TYPE
// (which would remount the transcript on resize). The rails/deck toggle as siblings
// and the providers are always mounted, switching values. Since
// continuity pass the provider value is railsShown = cockpit — an open command
// surface claims the screen VISUALLY (opaque root pane) while the cockpit
// stays mounted beneath it.
check('M3: cockpit + deck toggle as siblings, providers always mounted (stable root)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(fnBody) &&
  /TerminalSizeContext\.Provider value=\{sizeVal\}/.test(fnBody) &&
  /\{fullscreen && chrome === 'deck-strip' \? <DeckPane \/> : null\}/.test(fnBody))
check('M3: no separate <HelmHome> root (absorbed → no root-type flip)', !/<HelmHome/.test(fnBody))
// M2/P3: the surface claim is VISUAL,
// not structural — the modal is an opaque root-anchored full-screen pane, so
// the cockpit subtree behind it stays MOUNTED (rails keep state + identity,
// the transcript keeps its center width; closing is a pure overlay removal).
// The modal itself always spans the FULL terminal. Rail INPUT parks: the
// Tab-availability stamp goes false and focus returns to the prompt.
check('P3-continuity: rails stay mounted under a modal (visual claim only)',
  /const cockpit = fullscreen && chrome === 'cockpit'\n/.test(fnBody) &&
  !/const cockpit = fullscreen && chrome === 'cockpit' && !modalUp/.test(fnBody))
check('M2: modal spans the full terminal in every chrome',
  /"▔"\.repeat\(Math\.max\(1, columns\)\)/.test(fnBody) &&
  /rows: terminalRows - modalPeek - 1,\s*columns,/.test(fnBody))
check('P3-continuity: rail input parks while a modal is up',
  /const reachable = cockpit && !modalUp\s*setHelmTelemetryAvailable\(reachable && plan\.telemetry\)\s*if \(!reachable\) setHelmFocus\('prompt'\)/.test(fnBody))
// P3+C1: the claimed surface takes the full height in cockpit AND deck-strip
// chrome (a root-anchored modal with a 2-row peek would slice DeckPane
// mid-border — audit C1); the classic inline home keeps the transcript peek.
check('P3: surface claims full height (peek 0) in cockpit + deck-strip, default peek inline',
  /const modalPeek = chrome === 'inline' \? 2 : 0/.test(fnBody) &&
  /maxHeight=\{terminalRows - modalPeek\}/.test(fnBody))

// --- geometry: single locked source ---------------------------------------
check('helmGeometry exports HELM_HOME_MIN_COLS = 100', /export const HELM_HOME_MIN_COLS\s*=\s*100/.test(geometry))
check('helmGeometry exports helmCenterCols + HELM_RAIL_W (one source for the math)',
  /export function helmCenterCols/.test(geometry) && /export const HELM_RAIL_W/.test(geometry))

// --- M1: MercuryFrame keeps model/cost/branch/scribe in the cockpit ---------
check('M1: MercuryFrame keys vital-shed on CockpitActiveContext (not the overridden width; RB-01: never beneath a route surface)',
  /const helmActive = useContext\(CockpitActiveContext\) && !routeSurface/.test(frame))
check('M1: deck-owned shed is false in cockpit (model/cost/branch kept; RB-01 route-surface guard)',
  /const deckPresent = !routeSurface && isDeckPaneActive\(\) && !helmActive/.test(frame))
check('M1: usage shed under a vital-PAINTING deck OR the cockpit (width-aware: a deck below the cockpit threshold paints no vitals and owns none; RB-01 route-surface guard)',
  /usageOwnedElsewhere = !routeSurface && \(deckOwnsVitals \|\| helmActive\)/.test(frame) &&
  /deckOwnsVitals = deckPresent && cols >= LAYOUT_BREAKPOINTS\.cockpitMin/.test(frame) &&
  /!usageOwnedElsewhere \? usageNode/.test(frame))

// --- HelmLanesRail: presence snapshot + CREW source + drill-in reuse ------
check('SEAT uses getPresenceVersion as the sync snapshot (NOT getLivePresence)',
  /useSyncExternalStore\(subscribePresence, getPresenceVersion, getPresenceVersion\)/.test(lanes))
check('SEAT does NOT pass getLivePresence as a useSyncExternalStore arg (no infinite render)',
  !/useSyncExternalStore\([^)]*getLivePresence/.test(lanes))
check('CREW sources from app-store tasks, not a fleetGauge() call',
  /useAppState\(s => s\.tasks\)/.test(lanes) && !/fleetGauge\(/.test(lanes))
check('CREW rows keep .id (the drill-in key)', /id: t\.id/.test(lanes))
check('drill-in REUSES the existing nav state (viewingAgentTaskId), not a reinvented swap',
  /viewingAgentTaskId/.test(lanes) && !/setAppState\(\{ viewingAgentTaskId/.test(lanes))
// S8: CREW excludes the backgrounded main session (isPanelAgentTask, not isLocalAgentTask).
check('S8: CREW sources panel agents (excludes main-session leak)', /\.filter\(isPanelAgentTask\)/.test(lanes))
// M4/S2: CREW and peers are CAPPED so they cannot clip TASKS off the rail.
check('M4: CREW is capped (slice CREW_ROWS) with a +N more overflow',
  /slice\(0, CREW_ROWS\)/.test(lanes) && /MoreRow/.test(lanes))
check('S2: SEAT peers are capped (slice PEER_ROWS)', /slice\(0, PEER_ROWS\)/.test(lanes))
// S4: your own SEAT row is IVORY, not the dead-cursor FAINT dim (the vestigial
// focus/cursor prop path that left self permanently dim is removed).
check('S4: the dead selectedCaret/focus path is removed from the rail',
  !/selectedCaret/.test(lanes) && !/onCursorMax/.test(lanes))

// --- RUNS lane: live background processes in the cockpit -----
// Shells/monitors/workflows/cloud runs surface as first-class rows: kind
// derives from the task SHAPE (a Monitor is local_bash kind:'monitor'),
// running rows rotate (WorkingGlyph — the liveness grammar), the verb is
// kind + live elapsed (formatSpan), the lane is capped with honest overflow,
// and ↵ routes to /tasks. Render-verify: render-helm-runs.ts (UI_RENDER tier,
// a REAL bang shell backgrounded in the PTY).
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

// --- the telemetry rail carries ctx (the deck would otherwise own it) -------------
check('telemetry rail renders the ctx-fill gauge (getLiveContextUsage)',
  /getLiveContextUsage/.test(telemetry) && /ctx /.test(telemetry))

// --- dedup: MercuryHome sheds the duplicated glance, context-keyed ---------
check('MercuryHome sheds the fleet glance when the cockpit owns it', /helmHome \?/.test(welcome) || /!helmHome/.test(welcome))
check('the shed keys on CockpitActiveContext (decoupled from the overridden width)',
  /const helmHome = useContext\(CockpitActiveContext\)/.test(welcome))
check('FullscreenLayout overrides center width (TerminalSizeContext) so the transcript wraps in-column',
  /TerminalSizeContext\.Provider/.test(layout) && /plan\.centerCols/.test(layout))
check('FullscreenLayout provides CockpitActiveContext = cockpit (true only when rails show)',
  /CockpitActiveContext\.Provider value=\{cockpit\}/.test(layout))

// --- token discipline (no raw hex / no banned accent) ---------------------
for (const [name, src] of [['HelmLanesRail', lanes], ['HelmTelemetryRail', telemetry]] as const) {
  check(`${name}: no inline #E07A50 (token only)`, !/#E07A50/i.test(src))
  check(`${name}: no raw 6-digit hex literal`, !/#[0-9A-Fa-f]{6}\b/.test(src))
}

console.log('============================================================')
if (failures === 0) console.log('✅ HELM-HOME PROOF PASS')
else console.log(`❌ HELM-HOME PROOF: ${failures} failure(s)`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
