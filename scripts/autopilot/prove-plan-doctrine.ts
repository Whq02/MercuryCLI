#!/usr/bin/env bun
// ============================================================================
//  scripts/autopilot/prove-plan-doctrine.ts
//  PROOF: the plan-mode doctrine — Mercury-doctrine prompt sharpening
//  is present and behavior-preserving (same flow), and the
//  autopilot×plan integration exists exactly where the spec put it.
//
//   §1 ENTER prompt: base body intact (flow-preserving pin) + the Mercury
//      doctrine appendix (render-verify · gate exit-code · off-dist diff-read)
//      + the autopilot bullet ONLY when MERCURY_AUTOPILOT is armed.
//   §2 EXIT prompt: base body intact + the "a plan names its proof" appendix.
//   §3 APPENDIX: getAutopilotModeSections — [] unless (flag ∧
//      mode==='autopilot'); content pins (doctrine + cache economics).
//   §4 INTEGRATION (structural): plan-entry effort raise (autopilot only,
//      raise-only, surfaced, tool-entry only) + the ExitPlanMode downshift
//      nudge (restoring to autopilot only).
//
//  Run:  ~/.bun/bin/bun run scripts/autopilot/prove-plan-doctrine.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Plan-mode doctrine — appendices + autopilot legs')
console.log('============================================================')

delete process.env.MERCURY_AUTOPILOT

const { getEnterPlanModeToolPrompt } = await import(
  '../../src/tools/EnterPlanModeTool/prompt.js'
)
const { EXIT_PLAN_MODE_V2_TOOL_PROMPT } = await import(
  '../../src/tools/ExitPlanModeTool/prompt.js'
)
const { getAutopilotModeSections } = await import(
  '../../src/utils/autopilot/autopilotPrompt.js'
)

section('§1 EnterPlanMode prompt — base body + Mercury doctrine appendix')
const enterOff = getEnterPlanModeToolPrompt()
check('base body intact (flow-preserving)', enterOff.includes('## When to Use This Tool') && enterOff.includes('REQUIRES user approval'))
check('Mercury doctrine appendix present', enterOff.includes('## Mercury doctrine (this harness)'))
check('names render-verification', enterOff.includes('render_tui') && enterOff.includes('80+120'))
check('names the gate by EXIT CODE', enterOff.includes('EXIT CODE'))
check('names the off-distribution core diff-read', enterOff.includes('off-distribution core') && enterOff.includes('diff-read'))
check('autopilot bullet ABSENT while flag off', !enterOff.includes('SetTier'))
process.env.MERCURY_AUTOPILOT = '1'
const enterOn = getEnterPlanModeToolPrompt()
check('autopilot bullet present ONLY when armed', enterOn.includes('downshift via SetTier'))
delete process.env.MERCURY_AUTOPILOT

section('§2 ExitPlanMode prompt — "a plan names its proof"')
const exitP = EXIT_PLAN_MODE_V2_TOOL_PROMPT
check('base body intact', exitP.includes('## How This Tool Works') && exitP.includes('plan file holds your finished plan'))
check('doctrine appendix present', exitP.includes('a plan is ready when it names its proof'))
check('verification per surface (renders + exit code)', exitP.includes('80+120') && exitP.includes('EXIT CODE'))
check('off-dist callout expectation', exitP.includes('off-distribution core'))
check('green→commit→push directive named', exitP.includes('green→commit→push'))

section('§3 the autopilot appendix — mode-scoped, fork+flag-gated')
check('flag off ⇒ [] (any mode)', getAutopilotModeSections('autopilot' as never).length === 0)
process.env.MERCURY_AUTOPILOT = '1'
check("mode undefined (headless/service callers) ⇒ []", getAutopilotModeSections(undefined).length === 0)
check("mode 'default' ⇒ []", getAutopilotModeSections('default' as never).length === 0)
check("mode 'sovereign' ⇒ [] (bypass alone gets NO tier doctrine)", getAutopilotModeSections('sovereign' as never).length === 0)
const appendix = getAutopilotModeSections('autopilot' as never)
check("mode 'autopilot' ⇒ ONE section", appendix.length === 1)
check('appendix carries the doctrine (upshift/downshift)', appendix[0]!.includes('Upshift') && appendix[0]!.includes('Downshift'))
check('appendix carries the cache economics', appendix[0]!.includes('prompt cache'))
check('appendix names the rails', appendix[0]!.includes('cooldown') && appendix[0]!.includes('8-switch'))
check('never-switch-on-a-hunch doctrine (spec pin)', appendix[0]!.includes('hunch'))
delete process.env.MERCURY_AUTOPILOT

section('§4 autopilot×plan integration (structural)')
const enterSrc = src('tools', 'EnterPlanModeTool', 'EnterPlanModeTool.ts')
check('plan-entry raise gated on autopilot mode ', enterSrc.includes("appState.toolPermissionContext.mode === 'autopilot'"))
check('raise-only (levels below high only; numeric pins untouched)', enterSrc.includes("EFFORT_LEVELS.indexOf(current) < EFFORT_LEVELS.indexOf('high')"))
check('raise is SURFACED (notification)', enterSrc.includes('autopilot-plan-effort-raise'))
const exitSrc = src('tools', 'ExitPlanModeTool', 'ExitPlanModeV2Tool.ts')
check("nudge computed from prePlanMode === 'autopilot'", exitSrc.includes("prePlanMode === 'autopilot'"))
check('nudge appended to the approval result', exitSrc.includes('downshift via SetTier'))
check('nudge rides the output schema (SDK-visible, optional)', exitSrc.includes('autopilotDownshiftNudge'))

console.log(`\n${failures === 0 ? 'GREEN' : `RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
