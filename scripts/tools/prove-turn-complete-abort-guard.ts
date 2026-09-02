#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-turn-complete-abort-guard.ts
//  PROOF for HB-0096 at its present owner: a cancelled turn must never settle
//  as a phantom completion. The query loop lives in the SESSION RUNNER
//  (QueryEngine.submitMessage over run-core/turn-machine, driven by
//  cli/headless/turnDriver) — the law re-homes there:
//
//    A. REACHABILITY — the turn machine returns CLEANLY on cancel (typed
//       aborted_* terminals, no throw), so the engine's settlement always
//       runs and the driver's cycle survives an interrupt (a thrown abort
//       would hit the cycle's error band: error envelope + shutdown(1) —
//       a dead session on every Esc).
//    B. THE DISCRIMINATOR — each abort branch appends the user interruption
//       line (steer excepted: the queued user message right behind a
//       submit-interrupt says everything), and that message is TEXT content,
//       which isResultSuccessful can never accept — so the settlement
//       classifies an interrupted turn as error_during_execution, never as
//       the success envelope. The success yield stands only past that gate.
//    C. THE SETTLE TAIL — the driver settles every turn exactly once
//       (lifecycle 'completed' + onTurnSettled after executeTurn, one call
//       site each): the turn boundary fires per settled turn, never twice,
//       never from a second path.
//
//  The heavy modules are bun-unloadable in isolation (the tool graph +
//  feature() macros), so this stays a source-text proof.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-turn-complete-abort-guard.ts
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
const root = join(import.meta.dir, '..', '..')
const machine = readFileSync(join(root, 'src', 'run-core', 'turn-machine.ts'), 'utf-8')
const engine = readFileSync(join(root, 'src', 'QueryEngine.ts'), 'utf-8')
const helpers = readFileSync(join(root, 'src', 'utils', 'queryHelpers.ts'), 'utf-8')
const factories = readFileSync(join(root, 'src', 'utils', 'messages', 'factories.ts'), 'utf-8')
const driver = readFileSync(join(root, 'src', 'cli', 'headless', 'turnDriver.ts'), 'utf-8')

console.log('============================================================')
console.log(' cancelled turns never settle as phantom completions (HB-0096, runner-homed)')
console.log('============================================================')

section('A. reachability: the turn machine RETURNS clean typed terminals on cancel')
check(
  "abort during streaming returns the aborted_streaming terminal (no throw)",
  /const terminal: Terminal = \{ reason: 'aborted_streaming' \}[\s\S]{0,120}?return terminal/.test(machine),
)
check(
  "abort during tools returns the aborted_tools terminal (no throw)",
  /const terminal: Terminal = \{ reason: 'aborted_tools' \}[\s\S]{0,120}?return terminal/.test(machine),
)
check(
  'no abort branch throws (neither aborted terminal shares its block with a throw)',
  !/signal\.aborted\)\s*\{[\s\S]{0,600}?throw new/.test(machine),
)

section('B. the discriminator: the interruption line forces an honest settlement')
check(
  'the streaming abort branch appends the user interruption line (steer excepted)',
  /signal\.aborted\) \{[\s\S]{0,700}?steer \? null : createUserInterruptionMessage\(\{ toolUse: false \}\)[\s\S]{0,300}?aborted_streaming/.test(machine),
)
check(
  'the tools abort branch appends the tool-use interruption line (steer excepted)',
  /steer \? null : createUserInterruptionMessage\(\{ toolUse: true \}\)[\s\S]{0,600}?aborted_tools/.test(machine),
)
check(
  'the streaming abort branch settles every announced tool_use synthetically first',
  /signal\.aborted\) \{\s*yield\* emitSyntheticSettlements\([\s\S]{0,120}?'aborted',/.test(machine),
)
check(
  'the interruption line is TEXT content (never a tool_result the success arm could accept)',
  /createUserInterruptionMessage\(\{[\s\S]{0,200}?content: \[\s*\{\s*type: 'text',\s*text: toolUse \? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE,/.test(factories),
)
check(
  "isResultSuccessful's user arm demands ALL-tool_result content and its fallback demands the end_turn stop — a text interruption line satisfies neither",
  /content\.every\(block => \(block as \{ type\?: string \}\)\.type === 'tool_result'\)/.test(helpers) &&
    /return stopReason === 'end_turn'/.test(helpers),
)
check(
  'the settlement gates the outcome on isResultSuccessful + the end-turn carve-out before any success yield',
  /const endTurnCarveOut = !terminalMessage && capturedStopReason === 'end_turn'\s*if \(\(!terminalMessage \|\| !isResultSuccessful\(terminalMessage\)\) && !endTurnCarveOut\) \{[\s\S]{0,400}?subtype: 'error_during_execution',[\s\S]{0,400}?return/.test(engine),
)
// The engine's success envelopes are a closed list of three deliberate
// settles: the local-command turn (no query loop ran), the cycle_handoff
// attachment (an evidence-backed settle), and the gated turn settlement.
// A fourth is a new unreviewed path for a cancelled turn to slip through.
check(
  'the success envelopes are the closed three (local command · cycle_handoff · the gated settlement)',
  (engine.match(/subtype: 'success',/g) ?? []).length === 3,
)
check(
  'the turn settlement’s success yield is the LAST envelope, past the gate',
  engine.lastIndexOf("subtype: 'success',") > engine.indexOf('const endTurnCarveOut'),
)

section('C. the settle tail: exactly once per turn, after the turn, one call site')
check(
  "runOneTurn settles in order: executeTurn → lifecycle 'completed' → onTurnSettled",
  /await ports\.executeTurn\(command, message => \{[\s\S]{0,900}?\}\)\s*for \(const uuid of batchUuids\) \{\s*ports\.notifyLifecycle\(uuid, 'completed'\)\s*\}[\s\S]{0,300}?ports\.onTurnSettled\(command\)/.test(driver),
)
check(
  'onTurnSettled has exactly one call site in the driver',
  (driver.match(/ports\.onTurnSettled\(/g) ?? []).length === 1,
)
check(
  'the error band (envelope + shutdown) is reserved for a THROWN cycle — the clean abort return never reaches it',
  /catch \(error\) \{[\s\S]{0,400}?await ports\.writeDirect\(ports\.onCycleError\(error\)\)[\s\S]{0,200}?ports\.shutdown\(1\)/.test(driver),
)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0096 — cancelled turns settle honestly at the runner (law re-homed)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0096 — ${failures} check(s) failed`)
  process.exit(1)
}
