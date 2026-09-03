#!/usr/bin/env bun
// ============================================================================
//  scripts/helm-console/prove-console-wiring.ts
//  PROOF: the console's cockpit + command wiring holds together — the pure
//  focus-model pieces are exercised directly; the component-layer seams are
//  pinned as source-text invariants (the glyph-migration lesson: source
//  pins keep a cross-file contract from drifting suite-silently).
//    · helmFocus: the console row kind exists, maps to a console action,
//      signs distinctly (helmRowSig), and never collides with command rows;
//    · PromptInput: compose routing branch + ctrl+l clear + printable
//      auto-compose on the console row + click-parity console handling;
//    · HelmTelemetryRail: the section renders LAST (under TRACE), gated on
//      consoleEnabled(), with the ↵-full receipt row wired to /console;
//    · commands.ts: /console registered inside the base COMMANDS array
//      (unconditional) + HelpV2 domain entry;
//    · flagRegistry: MERCURY_HELM_CONSOLE row with evidence = this suite;
//    · the /btw abort fix: btw.tsx threads a controller into the fork and
//      runSideQuestion forwards it as the subagent-context override;
//    · telemetryBus crew channel: default-clear + crewEnabled gate;
//    · HelmLanesRail: daemon-crew branch + solo gate includes daemon crew.
//  Run:  ~/.bun/bin/bun run scripts/helm-console/prove-console-wiring.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, readFileSync } from 'node:fs'
import {
  helmRowAction,
  helmRowSig,
  type HelmRow,
} from '../../src/utils/cockpit/helmFocus.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const read = (p: string) => readFileSync(p, 'utf8')

console.log('============================================================')
console.log(' helm console wiring — focus model · input owner · surfaces')
console.log('============================================================')

section('helmFocus — the console row kind (pure)')
const consoleRow: HelmRow = { kind: 'console', label: 'console:input' }
const act = helmRowAction(consoleRow)
check('console row → console action', act?.type === 'console')
check('console sig is distinct', helmRowSig(consoleRow) === 'k:console:console:input')
check(
  'no collision with a command row of the same label',
  helmRowSig(consoleRow) !== helmRowSig({ kind: 'command', command: '/console', label: 'console:input' }),
)

section('PromptInput — the one input owner routes compose')
const pi = read('src/components/PromptInput/PromptInput.tsx')
check('compose branch gated on telemetry pane', pi.includes("focusPane === 'telemetry' && isConsoleComposing()"))
check('↵ submits through the store (single usage seam)', pi.includes('consoleSubmitBuffer((question, controller) =>') && pi.includes('runConsoleAsk({'))
// esc tries the abort FIRST: consoleAbortAsk() answers true when a pending
// ask was cancelled (compose stays); only a no-pending esc exits compose.
check('esc aborts a pending ask first', pi.includes('if (!consoleAbortAsk()) exitConsoleCompose()'))
check('Tab always escapes compose (never a trap)', pi.includes('if (isConsole) exitConsoleCompose()') && pi.includes('setHelmFocus(nextHelmPane(focusPane))'))
check('ctrl+l clears', pi.includes("isConsole && key.ctrl && rawInput === 'l'") && pi.includes('consoleClear()'))
// Row activation is ONE seam: ↵ publishes the focused row
// (requestHelmRowActivation) and the consume effect's console case focuses
// telemetry + opens compose — the same channel a rail click feeds.
check(
  '↵ on the console row enters compose in place',
  pi.includes('requestHelmRowActivation(focusPane, getHelmCursor(focusPane))') &&
    pi.includes("case 'console':") &&
    pi.includes('beginConsoleCompose()'),
)
check(
  'printable on the console row auto-composes (gated on consoleEnabled)',
  pi.includes("focusPane === 'telemetry' && consoleEnabled()") && pi.includes('beginConsoleCompose(rawInput)'),
)
check(
  'click parity: console action focuses telemetry + composes',
  read('src/components/HelmTelemetryRail.tsx').includes("requestHelmRowActivationByLabel('telemetry', label)") &&
    read('src/utils/cockpit/helmFocus.ts').includes('requestHelmRowActivation(pane, i)') &&
    pi.includes("setHelmFocus('telemetry')"),
)

section('HelmTelemetryRail — the last section (under TRACE)')
const rail = read('src/components/HelmTelemetryRail.tsx')
check('section gated on consoleEnabled()', rail.includes('const consoleOn = consoleEnabled()'))
const traceIdx = rail.indexOf('label="TRACE"')
const conIdx = rail.indexOf('label="CONSOLE"')
check('console section renders AFTER trace (the last panel)', traceIdx > 0 && conIdx > traceIdx)
check('the SUBSTRATE box stays off the rail', !rail.includes('label="SUBSTRATE"'))
check('input row published as a console-kind row', rail.includes("{ kind: 'console', label: 'console:input' }"))
check('receipt row opens /console', rail.includes("command: '/console', label: 'console:full'"))
check('compose cursor uses the caretBlock glyph', rail.includes('GLYPH.caretBlock'))
// console-clip fix: the budget ceiling is the MEASURED rail height
// (FullscreenLayout measureElement → availRows prop), falling back to the
// legacy terminal-rows estimate only for the pre-measurement frame. Floor 0:
// the `↵ full` receipt row must never be the row that clips.
check('answer budget ceiling prefers the MEASURED rail height', rail.includes('availRows ?? termRows - CHROME_ROWS'))
check('answer budget floors at 0 (receipt row is un-loseable)', rail.includes('Math.max(0, Math.min(9, ceiling - rowsAbove))'))
const fsl = read('src/components/FullscreenLayout.tsx')
check('FullscreenLayout measures the telemetry wrapper', fsl.includes('measureElement(telemetryBoxRef.current)'))
check('…and hands the rail its ceiling', fsl.includes('availRows={telemetryRows}'))
check('asking state uses the liveness grammar (WorkingGlyph)', /consolePending[\s\S]{0,400}WorkingGlyph/.test(rail))

section('commands — stamp-gated /console + help domain')
const cmds = read('src/commands.ts')
const surfaceArr = cmds.slice(cmds.indexOf('const COMMANDS = memoize'), cmds.indexOf('return COMMANDS()'))
check('/console registered inside the base COMMANDS array (unconditional)', surfaceArr.includes('consoleCommand,'))
check('import present', cmds.includes("import consoleCommand from './commands/console/index.js'"))
const domains = read('src/components/HelpV2/commandDomains.ts')
// /btw was REMOVED (operator directive — the console owns side
// questions); the domain now lists console without it.
check('HelpV2 domain lists console (btw removed)', /['"]console['"]/.test(domains) && !/['"]btw['"]/.test(domains))
const cidx = read('src/commands/console/index.ts')
check('/console isEnabled rides consoleEnabled()', cidx.includes('isEnabled: () => consoleEnabled()'))
const cview = read('src/commands/console/console.tsx')
check('/console clear handled', cview.includes("=== 'clear'") && cview.includes('consoleClear()'))
check('overlay asks through the same store (consoleAsk)', cview.includes('consoleAsk(') && cview.includes('runConsoleAsk({'))

section('flag registry — MERCURY_HELM_CONSOLE')
const reg = read('src/substrate/flagRegistry.ts')
check('row present', reg.includes("env: 'MERCURY_HELM_CONSOLE'"))
check('default-on + additive + evidence names this suite', /MERCURY_HELM_CONSOLE'[^}]*kind: 'default-on'[^}]*tier: 'additive'[^}]*evidence: 'scripts\/helm-console\/run-all\.sh'/.test(reg))

section('side-question hardening — the abort actually reaches the fork')
// (/btw itself was removed; the ENGINE + its abort threading
// survive under the console ask.)
const sq = read('src/utils/sideQuestion.ts')
check('runSideQuestion accepts an abortController', sq.includes('abortController?: AbortController'))
check(
  '…and forwards it as the subagent-context override',
  sq.includes('...(abortController ? { abortController } : {})') &&
    sq.includes('overrides: Object.keys(overrides).length > 0 ? overrides : undefined'),
)
check('the /btw command stays deleted (the console owns side questions)', !existsSync('src/commands/btw'))
const ask = read('src/utils/cockpit/helmConsoleAsk.ts')
// A wire/API failure arrives from the engine as answer TEXT; the console
// routes it to its ERROR state (the entry paints ✗ + the reason, the row
// reads 'err', the registry records failed) — never an answer with a 0→0
// receipt. The decision seam is pure; the run path throws on it.
{
  const seam = await import('../../src/utils/cockpit/helmConsoleAsk.js').catch(() => null)
  if (seam !== null) {
    check('a wire failure text is a console FAILURE', seam.consoleAskFailure('API Error: OpenAI stream failed (fetch-failed) — fetch failed') !== null)
    check('an engine api_error line is a console FAILURE', seam.consoleAskFailure('An API error occurred: 529 overloaded') !== null)
    check('a real answer is not', seam.consoleAskFailure('The repo builds a terminal harness.') === null && seam.consoleAskFailure(null) === null)
  } else {
    check('consoleAskFailure seam present (structural)', ask.includes('export function consoleAskFailure('))
  }
  check('runConsoleAsk throws the named failure into the store\'s error path', ask.includes('const failure = consoleAskFailure(result.response)') && ask.includes('if (failure !== null) throw new Error(failure)'))
}
check('console ask reuses the saved cache-safe prefix', ask.includes('getLastCacheSafeParams()'))
check('console ask strips a streaming tail (mid-turn safety)', ask.includes('stripInProgressAssistantMessage'))
check('fallback prefix builders are DYNAMIC imports (cycle rule)', ask.includes("import('../../constants/prompts.js')"))

section('telemetryBus crew channel + lanes rail')
const bus = read('src/state/telemetryBus.ts')
check('crew leg gated on crewEnabled()', bus.includes('crewEnabled()'))
check('crew default-clears each refresh (no stale retention)', bus.includes('next.crew = null'))
const lanes = read('src/components/HelmLanesRail.tsx')
check('daemon-crew rows render in CREW', lanes.includes("entry.kind === 'daemon'"))
check('daemon rows open the named agent\'s chat', lanes.includes("command: `/teammates ${entry.name}`, label: `crew:d:${entry.name}`"))
check('unread breathes (AttentionPulse via verbPulse)', lanes.includes('verbPulse={entry.unread > 0}'))
check('solo gate counts daemon crew', lanes.includes('daemonCrew.length === 0'))

section('workflow lead-run detail (telemetry rail)')
check('phase + agent progress derived from workflowProgress', rail.includes("e.type === 'workflow_agent'") && rail.includes('leadDetail'))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-wiring: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-wiring: ALL GREEN')
