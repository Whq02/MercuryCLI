#!/usr/bin/env bun
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
  /signal\.aborted\) \{[\s\S]{0,1400}?steer \? null : createUserInterruptionMessage\(\{ toolUse: false, reason: cutReason \}\)[\s\S]{0,300}?aborted_streaming/.test(machine),
)
check(
  'the tools abort branch appends the tool-use interruption line (steer excepted)',
  /signal\.aborted\) \{[\s\S]{0,700}?phase: 'tools',\s*steer,\s*message: steer \? null : createUserInterruptionMessage\(\{ toolUse: true, reason: cutReason \}\),[\s\S]{0,1500}?const terminal: Terminal = \{ reason: 'aborted_tools' \}/.test(machine),
)
check(
  'the streaming abort branch settles every announced tool_use synthetically first, in the typed cut\'s words',
  /signal\.aborted\) \{[\s\S]{0,600}?const cutReason = toolUseContext\.abortController\.signal\.reason\s*\n\s*yield\* emitSyntheticSettlements\([\s\S]{0,200}?turnCutResultText\(turnCutOf\(cutReason\)\)/.test(machine),
)
check(
  'the interruption line is TEXT content (never a tool_result the success arm could accept)',
  /createUserInterruptionMessage\(\{[\s\S]{0,240}?content: \[\s*\{\s*type: 'text',\s*text: turnCutLine\(turnCutOf\(reason\), toolUse\),/.test(factories),
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
  /await ports\.executeTurn\(command, batch\.length > 1 \? batchUuids : \[\], message => \{[\s\S]{0,1500}?\}\)\s*for \(const uuid of batchUuids\) \{\s*ports\.notifyLifecycle\(uuid, 'completed'\)\s*\}[\s\S]{0,300}?ports\.onTurnSettled\(command\)/.test(driver),
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
