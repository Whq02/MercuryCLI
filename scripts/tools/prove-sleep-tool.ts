#!/usr/bin/env bun
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

check('SleepTool const loads unconditionally ',
  /import \{ SleepTool \} from '\.\/tools\/SleepTool\/SleepTool\.js'/.test(TOOLS) &&
  /const SLEEP_TOOL = cycleTolerant\(\(\) => SleepTool\)/.test(TOOLS))
check('Sleep joins the tool catalog array (the cycle-tolerant row)',
  /SLEEP_TOOL,/.test(TOOLS))

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
