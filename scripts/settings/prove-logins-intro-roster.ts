#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'logins-intro-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.ts')
const { SIGN_IN_WORDS } = await import('../../src/components/Onboarding.tsx')

try {
  const intro = SIGN_IN_WORDS.intro
  const rows = loginFamilyRows({ engineLegs: true })
  const connect = rows.filter(row => row.value !== 'openai' && row.value !== 'claudeai' && row.value !== 'console')
  const names = connect.map(row => row.label.split(' — ')[0]!)
  console.log(`  intro: ${intro}`)
  check('the /logins opening sentence names every family the list below it carries, by the row\'s own name', names.every(name => intro.includes(name)), `missing: ${names.filter(name => !intro.includes(name)).join(', ') || 'none'}`)
  check('the last family on the list is the last named (OpenCode Zen, the box\'s missing one)', intro.includes(`or ${names[names.length - 1]}.`), names[names.length - 1])
  const named = intro.slice(intro.indexOf('or connect ') + 'or connect '.length, intro.indexOf('. To add an API key'))
  const spoken = named.split(/, | or /).map(s => s.trim()).filter(Boolean)
  check('the sentence names the families in the list\'s order and nothing the list does not carry', spoken.join('|') === names.join('|'), `${spoken.join('|')} vs ${names.join('|')}`)
  check('the three leading roads keep their words', intro.startsWith('Use a Claude or OpenAI subscription, usage-based billing, or connect ') && intro.endsWith('To add an API key from the terminal, run /router key <provider>.'), intro)
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures ? `\n❌ logins intro roster: ${failures} FAILED` : '\n✅ logins intro roster: ALL PASS')
process.exit(failures ? 1 : 0)
