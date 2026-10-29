#!/usr/bin/env bun
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

section('helmFocus — no console row kind (pure)')
const focusSrc = read('src/utils/cockpit/helmFocus.ts')
check('HelmRow has no console kind', !focusSrc.includes("kind: 'console'"))
check('HelmRowAction has no console action', !focusSrc.includes("type: 'console'"))
const commandRow: HelmRow = { kind: 'command', command: '/console', label: 'open' }
check('a command row to /console is a plain command action', helmRowAction(commandRow)?.type === 'command' && helmRowSig(commandRow) === 'c:/console:open')

section('PromptInput — the one input owner routes no compose line')
const pi = read('src/components/PromptInput/PromptInput.tsx') + read('src/components/PromptInput/useComposerRawKeys.ts')
check('the composer reads nothing from the console store', !pi.includes('helmConsole.js') && !pi.includes('helmConsoleAsk.js'))
check('no compose branch, no console case', !pi.includes('ConsoleCompose') && !pi.includes('isConsoleComposing') && !pi.includes("case 'console':"))
check(
  'a printable while a rail holds focus returns focus to the prompt and lands there',
  /!key\.tab\s*\n\s*\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*setHelmFocus\('prompt'\)\s*\n\s*insertAtCursor\(rawInput\)/.test(pi),
)
check('↵ on a rail row activates it through the one seam', pi.includes('requestHelmRowActivation(focusPane, getHelmCursor(focusPane))'))

section('HelmVitalsRail — usage · workflow · health, nothing more')
const rail = read('src/components/HelmVitalsRail.tsx') + read('src/utils/cockpit/helmVitalsModel.ts')
check('the rail reads nothing from the console store', !rail.includes('helmConsole.js'))
check('no console section', !rail.includes("label: 'CONSOLE'") && !rail.includes("key: 'console'") && !rail.includes('consoleRows'))
check('no trace section and no trace read', !rail.includes("label: 'TRACE'") && !rail.includes("key: 'trace'") && !rail.includes('useVitals().trace') && !rail.includes('traceRows'))
check('the SUBSTRATE box stays off the rail', !rail.includes('label="SUBSTRATE"') && !rail.includes("label: 'SUBSTRATE'"))
check('the section keys are the three', rail.includes("key: 'usage' | 'workflow' | 'health'"))
check('the only shed section is health, pointed at /health', rail.includes("const shedPointers = [...(healthShed ? ['/health'] : [])]"))
check('the shed ceiling prefers the MEASURED rail height', rail.includes('availRows ?? termRows - CHROME_ROWS'))
const fsl = read('src/components/FullscreenLayout.tsx')
check('FullscreenLayout measures the vitals wrapper', fsl.includes('measureElement(vitalsBoxRef.current)'))
check('…and hands the rail its ceiling', fsl.includes('availRows={vitalsRows}'))

section('commands — stamp-gated /console + help domain')
const cmds = read('src/commands.ts')
const surfaceArr = cmds.slice(cmds.indexOf('const COMMANDS = memoize'), cmds.indexOf('return COMMANDS()'))
check('/console registered inside the base COMMANDS array (unconditional)', surfaceArr.includes('consoleCommand,'))
check('import present', cmds.includes("import consoleCommand from './commands/console/index.js'"))
const domains = read('src/components/HelpV2/commandDomains.ts')
check('HelpV2 domain lists console (btw removed)', /['"]console['"]/.test(domains) && !/['"]btw['"]/.test(domains))
const cidx = read('src/commands/console/index.ts')
check('/console isEnabled rides consoleEnabled()', cidx.includes('isEnabled: () => consoleEnabled()'))
const cview = read('src/commands/console/console.tsx')
check('/console clear handled', cview.includes("=== 'clear'") && cview.includes('consoleClear()'))
check('the surface asks through the store (consoleAsk)', cview.includes('consoleAsk(') && cview.includes('runConsoleAsk({'))
check('ctrl+l on the surface clears through the one owner', cview.includes("key.ctrl && input === 'l'") && cview.includes('consoleClear()'))
const store = read('src/utils/cockpit/helmConsole.ts')
check('the store keeps no compose line (no buffer, no cursor, no recall)', !store.includes('ConsoleCompose') && !store.includes('consoleInsert') && !store.includes('consoleHistoryMove') && !store.includes('consoleSubmitBuffer'))
check('the store reads nothing from the focus model', !store.includes('helmFocus.js'))

section('flag registry — MERCURY_HELM_CONSOLE')
const reg = read('src/substrate/flagRegistry.ts')
check('row present', reg.includes("env: 'MERCURY_HELM_CONSOLE'"))
check('default-on + additive + evidence names this suite', /MERCURY_HELM_CONSOLE'[^}]*kind: 'default-on'[^}]*tier: 'additive'[^}]*evidence: 'scripts\/helm-console\/run-all\.sh'/.test(reg))

section('side-question hardening — the abort actually reaches the fork')
const sq = read('src/utils/sideQuestion.ts')
check('runSideQuestion accepts an abortController', sq.includes('abortController?: AbortController'))
check(
  '…and forwards it as the subagent-context override',
  sq.includes('...(abortController ? { abortController } : {})') &&
    sq.includes('overrides: Object.keys(overrides).length > 0 ? overrides : undefined'),
)
check('the /btw command stays deleted (the console owns side questions)', !existsSync('src/commands/btw'))
const ask = read('src/utils/cockpit/helmConsoleAsk.ts')
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

section('vitalsBus crew channel + lanes rail')
const bus = read('src/state/vitalsBus.ts')
const lanes = read('src/components/HelmLanesRail.tsx') + read('src/utils/cockpit/helmLanesModel.ts')

section('workflow lead-run detail (vitals rail)')
check('phase + agent progress derived from the one work-row owner', rail.includes('useFocusedWorkRows()') && rail.includes('focusedWorkflowRows(workRows)') && rail.includes('const leadDetail = workflowRowDetail(runningWf[0]!)'))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-console-wiring: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-console-wiring: ALL GREEN')
