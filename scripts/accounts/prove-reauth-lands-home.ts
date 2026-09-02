#!/usr/bin/env bun
// ============================================================================
// prove-reauth-lands-home — an OAuth re-login
//  mid-work returns the operator to the session they left. The road is the
//  LANDED machinery, verified and pinned here so a refactor cannot quietly
//  strand a re-auth: /logins is a chat-overlay command that ALWAYS settles
//  back into the chat (settle-once; no rejectable await on the settle
//  path), the `--return=/cmd` chain rides EVERY settle, and every wall
//  sentence's reconnect door pre-focuses a real row on the Logins menu.
//
//    §1 the family-focus vocabulary (pure): every household spelling lands
//       its row; unknown words open the menu unfocused, never crash
//    §2 the settle contract (structural): one settle guard; both arms call
//       onDone; the chain rides success, deliberate close, and the engine
//       receipt alike; --return accepts slash commands only
//    §3 nothing on the settle path can reject: the one awaited member is
//       the static-table gate refresh; the rest is void-catch or sync —
//       a network fault can never leave the command unsettled (stranded)
//    §4 credential-change hygiene: the anthropic arm strips signature
//       blocks (replay under a new credential is refused otherwise); the
//       engine arm keeps them and bumps authVersion
//    §5 every wall's reconnect door lands focused: reconnectDoorFor's
//       `/logins <family>` spellings all parse through parseFamilyFocus
//       (cross-owner: the wall line and the menu share one vocabulary);
//       the /accounts reroute submits the same road
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-reauth-lands-home.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
const { reconnectDoorFor } = await import('../../src/services/providers/credentialWall.ts')

section('§1 the family-focus vocabulary (pure)')
{
  const rows: Array<[string, string]> = [
    ['anthropic', 'claudeai'],
    ['claude', 'claudeai'],
    ['console', 'console'],
    ['openai', 'openai'],
    ['chatgpt', 'openai'],
    ['gpt', 'openai'],
    ['openrouter', 'openrouter'],
    ['gemini', 'gemini'],
    ['google', 'gemini'],
    ['huggingface', 'huggingface'],
    ['hf', 'huggingface'],
    ['moonshot', 'moonshot'],
    ['kimi', 'moonshot'],
    ['zai', 'zai'],
    ['glm', 'zai'],
    ['deepseek', 'deepseek'],
  ]
  for (const [word, focus] of rows) {
    check(`'${word}' pre-focuses ${focus}`, parseFamilyFocus(word) === focus)
  }
  check('an unknown word opens the menu unfocused (never a crash)', parseFamilyFocus('galactica') === undefined && parseFamilyFocus(undefined) === undefined)
}

const loginSrc = readFileSync(join(ROOT, 'src/commands/login/login.tsx'), 'utf8')

section('§2 the settle contract (structural)')
{
  check('one settle guard (settledRef) fences double settles', loginSrc.includes('if (settledRef.current) return') && loginSrc.includes('settledRef.current = true'))
  check('success and deliberate close BOTH reach onDone with the chain', loginSrc.includes("onDone(shadow ? `Login successful\\n${shadow}` : 'Login successful', chain)") && loginSrc.includes("onDone('Login closed — no credential changed', chain)"))
  check('the engine receipt settles with the SAME chain', loginSrc.includes('onDone(result.receipt, chain)'))
  check('--return accepts slash commands only (no arbitrary exec road)', loginSrc.includes("returnCommand.startsWith('/')"))
}

section('§3 nothing on the settle path can reject')
{
  check('the two remote refreshes are void-catch (never awaited bare)', loginSrc.includes('void refreshRemoteManagedSettings().catch(logError)') && loginSrc.includes('void refreshPolicyLimits().catch(logError)'))
  check('the killswitch re-check is void-catch', loginSrc.includes('.catch(logError)') && loginSrc.includes('checkAndDisableBypassPermissionsIfNeeded'))
  const gates = readFileSync(join(ROOT, 'src/services/analytics/featureGates.ts'), 'utf8')
  const refreshBody = gates.slice(gates.indexOf('export async function refreshFeatureGates'), gates.indexOf('export function setupPeriodicFeatureGateRefresh'))
  check('the ONE awaited member (refreshFeatureGates) is the static table — cannot reject', refreshBody.includes('Static table') && !refreshBody.includes('fetch') && !refreshBody.includes('throw'))
}

section('§4 credential-change hygiene')
{
  check('the anthropic arm strips signature blocks (replay-refusal law)', loginSrc.includes('stripSignatureBlocks(prev)'))
  check('the engine arm keeps the transcript and bumps authVersion', loginSrc.includes('The engine legs') && loginSrc.includes("authVersion: (prev.authVersion ?? 0) + 1"))
}

section('§5 every wall reconnect door lands focused; the /accounts reroute rides it')
{
  const families = ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'openai-compat', 'local', 'unknown-future-family']
  for (const family of families) {
    const door = reconnectDoorFor(family)
    if (door.startsWith('/logins ')) {
      const word = door.slice('/logins '.length).trim()
      check(`the ${family} wall door ('${door}') pre-focuses a real row`, parseFamilyFocus(word) !== undefined)
    } else {
      check(`the ${family} door is its own named road ('${door}')`, door.startsWith('/'))
    }
  }
  const board = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('the /accounts reroute closes the board INTO the logins road (chat kept)', board.includes('nextInput: `/logins ${family}`') && board.includes('submitNextInput: true'))
  const model = readFileSync(join(ROOT, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('the /model connect row rides --return (the pick site restores)', model.includes("'/logins anthropic --return=/model'"))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('REAUTH LANDS HOME: ALL GREEN')
else console.log(`❌ ${failures} REAUTH-ROAD LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
