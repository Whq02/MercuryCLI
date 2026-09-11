#!/usr/bin/env bun
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
  check('no remote refresh remains on the settle path (neither settings nor policy limits)', !loginSrc.includes('refreshRemoteManagedSettings') && !loginSrc.includes('refreshPolicyLimits'))
  check('the killswitch re-check is void-catch', loginSrc.includes('.catch(logError)') && loginSrc.includes('checkAndDisableBypassPermissionsIfNeeded'))
  const refreshBody = loginSrc.slice(loginSrc.indexOf('function runPostLoginRefresh'), loginSrc.indexOf('export function parseFamilyFocus'))
  check('credential cache refresh is synchronous', !refreshBody.includes('await ') && refreshBody.includes('resetUserCache()') && refreshBody.includes('resetCostState()'))
  check('login does not import configuration refresh plumbing', !loginSrc.includes('services/analytics/featureGates'))
}

section('§4 credential-change hygiene')
{
  check('the anthropic arm strips signature blocks (replay-refusal law)', loginSrc.includes('stripSignatureBlocks(prev)'))
  const engineArmAt = loginSrc.indexOf('const completeOpenai = ')
  const engineArm = engineArmAt === -1 ? '' : loginSrc.slice(engineArmAt, loginSrc.indexOf('return (', engineArmAt))
  check('the engine arm keeps the transcript and bumps authVersion', engineArm.includes("authVersion: (prev.authVersion ?? 0) + 1") && engineArm.includes('onDone(result.receipt, chain)') && !engineArm.includes('stripSignatureBlocks'))
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
