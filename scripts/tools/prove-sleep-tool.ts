#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-sleep-tool.ts
//  PROOF that Mercury ships the Sleep tool unconditionally — no feature
//  gate, no dark catalog arm: a session always
//  carries it, and the model can always see it. This locks:
//
//  (1) the catalog inclusion in tools.ts, (2) the owned SleepTool.tsx
//  contract — concurrency-safe,
//  read-only, INTERRUPTIBLE via the turn abort signal, capped duration, honest
//  interrupted-flag result.
//
//  Source-text (the Tool import graph isn't reliably bun-run loadable).
//  Run: ~/.bun/bin/bun run scripts/tools/prove-sleep-tool.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOLS = readFileSync(join(root, 'src/tools.ts'), 'utf-8')
const SLEEP = readFileSync(join(root, 'src/tools/SleepTool/SleepTool.tsx'), 'utf-8')

let failures = 0
const check = (label: string, cond: boolean): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' Sleep tool — stamp-gated + interruptible contract')
console.log('============================================================')

// — catalog wiring: stamped build now loads + lists Sleep —
// Pin over the catalogue: the require form
// became a static import wrapped in the cycle-tolerant accessor — same law
// (Sleep loads unconditionally, cycle-safe), Mercury spellings.
check('SleepTool const loads unconditionally ',
  /import \{ SleepTool \} from '\.\/tools\/SleepTool\/SleepTool\.js'/.test(TOOLS) &&
  /const SLEEP_TOOL = cycleTolerant\(\(\) => SleepTool\)/.test(TOOLS))
check('Sleep joins the tool catalog array (the cycle-tolerant row)',
  /SLEEP_TOOL,/.test(TOOLS))

// — the owned Tool contract —
check('built via buildTool against the prompt name', /buildTool\(\{[\s\S]*name:\s*SLEEP_TOOL_NAME/.test(SLEEP))
check('concurrency-safe (isConcurrencySafe → true)',
  /isConcurrencySafe\(\)\s*\{[\s\S]*?return true/.test(SLEEP))
check('read-only (isReadOnly → true)', /isReadOnly\(\)\s*\{[\s\S]*?return true/.test(SLEEP))
check('INTERRUPTIBLE: listens to abortController.signal',
  /abortController/.test(SLEEP) && /signal\.addEventListener\('abort'/.test(SLEEP))
check('resolves early on abort and flags interrupted', /interrupted\s*=\s*true/.test(SLEEP))
check('honest result reports interrupted + slept_seconds',
  /interrupted,/.test(SLEEP) && /slept_seconds:/.test(SLEEP))
check('duration is capped (MAX_SLEEP_SECONDS)', /Math\.min\(seconds,\s*MAX_SLEEP_SECONDS\)/.test(SLEEP))
check('cleans up the timer + listener (no leak)',
  /clearTimeout\(timer\)/.test(SLEEP) && /removeEventListener\('abort'/.test(SLEEP))
// security: a benign wait explicitly opts OUT of the auto-mode classifier
check('explicit (unmarked) classifier opt-out — toAutoClassifierInput → ""',
  /toAutoClassifierInput\(\)\s*\{[\s\S]*?return ''/.test(SLEEP))

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Sleep tool — stamp-gated, concurrency-safe, interruptible, honest')
  process.exit(0)
} else {
  console.log(` ❌ Sleep tool — ${failures} invariant(s) broken`)
  process.exit(1)
}
