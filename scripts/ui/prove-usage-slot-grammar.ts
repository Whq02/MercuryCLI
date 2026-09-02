#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-usage-slot-grammar.ts — one slot grammar for every
//  family on the usage tab.
//
//  The class: a family-specific rendering whose words differ by family with
//  no reason behind the difference. The usage tab's per-family sections
//  spelled the same two facts their own way — an absent slot read "none
//  connected", "none on this lane", "none discovered", "none attached"; a
//  present slot that is not the session's billing source read "attached —
//  not…", "connected — not…", or bare. One owner now spells both
//  (absentSlotLine · INACTIVE_SLOT_LINE); the family-specific route inside
//  the absent line is the reasoned part and stays.
//
//   §1  the composers (pure).
//   §2  every family section rides them; no per-family spelling survives.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-usage-slot-grammar.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  const usage = await import(join(ROOT, 'src/components/Settings/Usage.tsx'))
  check('an absent slot names its route in the one shape', usage.absentSlotLine('/logins openai adds a ChatGPT account') === 'none — /logins openai adds a ChatGPT account · n/a')
  check('a present slot that is not the billing source says exactly that', usage.INACTIVE_SLOT_LINE === 'not the active billing source this session')
}

console.log('§2 every family section rides the one grammar')
{
  const src = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  const sections: Array<[string, RegExp]> = [
    ['Anthropic subscription', /absentSlotLine\('\/logins anthropic connects a subscription account'\)/],
    ['OpenAI subscription', /absentSlotLine\('\/logins openai adds a ChatGPT account'\)/],
    ['OpenRouter OAuth key', /absentSlotLine\('\/logins openrouter mints a scoped key through the OpenRouter OAuth flow'\)/],
    ['Gemini Google account', /absentSlotLine\('\/logins gemini connects Google OAuth \(needs your own OAuth client\)'\)/],
    ['Hugging Face sign-in', /absentSlotLine\("\/logins huggingface signs in with the Hub's device-code flow"\)/],
    ['local servers', /absentSlotLine\(ENGINE_USAGE_PRESENTATION\.local!\.connect\)/],
    ['the generic key-only family', /absentSlotLine\('this family connects by API key'\)/],
    ['the API-key slot', /absentSlotLine\('a pasted key attaches one'\)/],
  ]
  for (const [name, needle] of sections) check(`${name}: the absent slot rides absentSlotLine`, needle.test(src))
  check('every inactive present slot rides INACTIVE_SLOT_LINE (four slots)', (src.match(/: INACTIVE_SLOT_LINE/g) ?? []).length === 4, String((src.match(/: INACTIVE_SLOT_LINE/g) ?? []).length))
  // The retired spellings — the JSX bodies carry none of them (the
  // composer's own doc line names them as history).
  const bodies = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  for (const stale of ['none connected —', 'none on this lane', 'none discovered —', 'none attached —', "'attached — not the active", "'connected — not the active", "'not the active billing source this session'"]) {
    check(`no section spells "${stale}" on its own`, !bodies.includes(stale))
  }
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ usage-slot-grammar — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ usage-slot-grammar — one absent-slot line and one inactive-slot line for every family')
