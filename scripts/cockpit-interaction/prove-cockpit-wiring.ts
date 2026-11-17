#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
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
console.log(' cockpit wiring — focus model · input owner · vitals rail')
console.log('============================================================')

section('helmFocus — no console row kind (pure)')
const focusSrc = read('src/utils/cockpit/helmFocus.ts')
check('HelmRow has no console kind', !focusSrc.includes("kind: 'console'"))
check('HelmRowAction has no console action', !focusSrc.includes("type: 'console'"))
const commandRow: HelmRow = { kind: 'command', command: '/health', label: 'open' }
check('a command row is a plain command action', helmRowAction(commandRow)?.type === 'command' && helmRowSig(commandRow) === 'c:/health:open')

section('PromptInput — the one input owner routes no compose line')
const pi = read('src/components/PromptInput/PromptInput.tsx') + read('src/components/PromptInput/useComposerRawKeys.ts')
check('the composer reads nothing from the console store', !pi.includes('helmConsole.js') && !pi.includes('helmConsoleAsk.js'))
check('no compose branch, no console case', !pi.includes('ConsoleCompose') && !pi.includes('isConsoleComposing') && !pi.includes("case 'console':"))
check(
  'a printable while a rail holds focus returns focus to the prompt and lands there',
  /!key\.tab\s*\n\s*\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*setHelmFocus\('prompt'\)\s*\n\s*insertAtCursor\(rawInput\)/.test(pi),
)
check('↵ on a rail row activates it through the one seam', pi.includes('requestHelmRowActivation(focusPane, getHelmCursor(focusPane))'))

section('HelmVitalsRail — usage · health, nothing more')
const rail = read('src/components/HelmVitalsRail.tsx') + read('src/utils/cockpit/helmVitalsModel.ts')
check('the rail reads nothing from the console store', !rail.includes('helmConsole.js'))
check('no console section', !rail.includes("label: 'CONSOLE'") && !rail.includes("key: 'console'") && !rail.includes('consoleRows'))
check('no trace section and no trace read', !rail.includes("label: 'TRACE'") && !rail.includes("key: 'trace'") && !rail.includes('useVitals().trace') && !rail.includes('traceRows'))
check('the SUBSTRATE box stays off the rail', !rail.includes('label="SUBSTRATE"') && !rail.includes("label: 'SUBSTRATE'"))
check('the section keys are the two', rail.includes("key: 'usage' | 'health'"))
check('the only shed section is health, pointed at /health', rail.includes("const shedPointers = [...(healthShed ? ['/health'] : [])]"))
check('the shed ceiling prefers the MEASURED rail height', rail.includes('availRows ?? termRows - CHROME_ROWS'))
const fsl = read('src/components/FullscreenLayout.tsx')
check('FullscreenLayout measures the vitals wrapper', fsl.includes('measureElement(vitalsBoxRef.current)'))
check('…and hands the rail its ceiling', fsl.includes('availRows={vitalsRows}'))

console.log('')
if (failures > 0) {
  console.log(`❌ prove-cockpit-wiring: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ prove-cockpit-wiring: ALL GREEN')
