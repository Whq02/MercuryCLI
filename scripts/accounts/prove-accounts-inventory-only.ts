#!/usr/bin/env bun
// ============================================================================
//  prove-accounts-inventory-only — /accounts hosts no sign-in flow.
//
//  OPERATOR-SIGHTED: the accounts board's per-row "↵ re-login"
//  started an OAuth flow FROM THE BOARD — the browser opened while the
//  board's own paste panel rendered at the very bottom of a view spanning
//  up to ten family sections, below the fold at ordinary heights: a link
//  with nowhere visible to finish. The ruled design: /accounts is
//  INVENTORY ONLY — removal (⌫) keeps working exactly as before, and every
//  login/re-login choice REROUTES to the Logins screen (the one owner of
//  sign-in flows and their code entry), with that row's family pre-focused
//  via the command chain (/logins <family>). A non-current scope's row is
//  the one deliberate exception: rerouting it would sign the CURRENT home
//  in — the wrong credential store — so its ↵ names the honest road (run
//  under that home) and starts nothing.
//
//  §1 the board hosts no flow machinery
//  §2 login choices reroute through the command chain, family-focused
//  §3 the affordance copy says where the gesture goes
//  §4 removal stays whole
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const board = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('§1 the board hosts no flow machinery')
check('no scoped-reauth flow imports', !board.includes('startScopedReauth') && !board.includes('completeScopedReauth'))
check('no in-place OpenAI connect flow', !board.includes('beginOpenaiBrowserConnect'))
check('no code-entry field on the board', !board.includes('TextInput') && !board.includes('paste code') && !board.includes('paste redirected URL'))
check('no browser-opening promise in the copy', !board.includes('opens the browser'))

console.log('§2 login choices reroute through the command chain')
check('the reroute rides onClose with a submitted next input', /nextInput: `\/logins \$\{[^}]+\}`/.test(board) && board.includes('submitNextInput: true'))
check('the current Anthropic scope pre-focuses its family', board.includes("rerouteToLogins('anthropic'"))
check('the OpenAI rows pre-focus their family', board.includes("rerouteToLogins('openai'"))
check('a non-current scope names the honest road instead (never the wrong store)', board.includes('MERCURY_CONFIG_DIR='))

console.log('§3 the affordance copy says where the gesture goes')
check('the verified tail: ↵ opens Logins', board.includes('↵ opens Logins to re-login'))
check('the expired tail: ↵ opens Logins', board.includes('↵ opens Logins to reauth'))
check('the signed-out tail: ↵ opens Logins', board.includes('↵ opens Logins to sign in'))
check('the action hint matches', board.includes('opens Logins'))

console.log('§4 removal stays whole')
check('the removal action routes to the owning store', board.includes('executeSlotRemoval'))
check('the backspace hint stands', board.includes("key: 'backspace'"))

console.log(failures === 0 ? '\n ✅ ACCOUNTS IS INVENTORY ONLY' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
