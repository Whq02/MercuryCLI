#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'usage-slot-grammar-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const ROOT = process.cwd()
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

console.log('§1 the composers')
{
  const usage = await import(join(ROOT, 'src/screen/settings/Usage.tsx'))
  check('an absent slot names its route in the one shape', usage.absentSlotLine('/logins openai adds a ChatGPT account') === 'none — /logins openai adds a ChatGPT account · n/a', `got ${JSON.stringify(usage.absentSlotLine('/logins openai adds a ChatGPT account'))}; change absentSlotLine in src/screen/settings/usage/ (re-exported by src/screen/settings/Usage.tsx) to return "none — <route> · n/a"`)
  check('a present slot that is not the billing source says exactly that', usage.INACTIVE_SLOT_LINE === 'not the active billing source this session', `got ${JSON.stringify(usage.INACTIVE_SLOT_LINE)}; change INACTIVE_SLOT_LINE in src/screen/settings/usage/ (re-exported by src/screen/settings/Usage.tsx)`)
}

console.log('§2 every family section rides the one grammar')
{
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ usage-slot-grammar — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ usage-slot-grammar — one absent-slot line and one inactive-slot line for every family')
