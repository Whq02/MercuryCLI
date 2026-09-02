#!/usr/bin/env bun
// ============================================================================
//  prove-login-save-truth — "Login successful" only over a landed credential.
//
//  The lie: saveOAuthTokensIfNeeded reports {success,warning} — false when
//  BOTH storage legs (keychain and the plaintext fallback) refused — but the
//  login machine's deps typed saveTokens as void and the settle fell
//  straight through to recordSignIn + the success notice. The operator
//  was told they were signed in over a credential that never landed, and
//  found out at the next authenticated action or the next boot. Two sibling
//  call sites (the scoped reauth, the IdP command) already check the shape
//  — the product's own convention, broken at the primary door.
//
//  The law, driven through the REAL machine with injected deps:
//    §1 a save that failed both legs lands the ERROR flow — never success,
//       never recordSignIn, never the success notice — and the error
//       names the storage refusal.
//    §2 a save that landed degraded (success with a warning) still succeeds
//       and CARRIES the warning on the success flow for the skins to paint.
//    §3 a clean save records, notifies and succeeds exactly as before.
//    §4 the headless door (installOAuthTokens) throws on a failed save.
// ============================================================================
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'login-save-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const { createAnthropicLoginMachine } = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const FAKE_TOKENS = {
  accessToken: 'at_x',
  refreshToken: 'rt_x',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference'],
  subscriptionType: null,
  rateLimitTier: null,
} as never

type SaveResult = { success: boolean; warning?: string }

async function drive(save: () => SaveResult): Promise<{
  flows: string[]
  final: { name: string; warning?: string; message?: string }
  recorded: number
  notified: number
}> {
  const flows: string[] = []
  let recorded = 0
  let notified = 0
  let final: { name: string; warning?: string; message?: string } = { name: 'idle' }
  const machine = createAnthropicLoginMachine(
    { onDone: () => {} },
    snap => {
      flows.push(snap.flow.name)
      final = snap.flow as typeof final
    },
    {
      createService: () => ({
        startOAuthFlow: async (urlCallback: (url: string) => void) => {
          urlCallback('https://sign-in.example/x')
          return FAKE_TOKENS
        },
        handleManualAuthCodeInput: () => {},
        cleanup: () => {},
      }),
      saveTokens: save as never,
      usesClaudeAiAuth: () => true,
      recordSignIn: () => {
        recorded++
      },
      notify: () => {
        notified++
      },
      settings: () => ({}),
      shadowWarning: () => null,
      accountInfo: () => null,
      clipboard: async () => null,
      writeStdout: () => {},
      log: () => {},
      mintApiKey: async () => ({}),
      validateOrg: async () => ({ valid: true }),
      setTimer: (fn: () => void) => setTimeout(fn, 0),
      clearTimer: (handle: unknown) => clearTimeout(handle as never),
    } as never,
  )
  machine.start(true)
  // The token promise settles on the microtask queue; give it two beats.
  await new Promise(resolve => setTimeout(resolve, 20))
  return { flows, final, recorded, notified }
}

// §1 the failed save refuses
{
  const r = await drive(() => ({ success: false, warning: 'Failed to save credentials to secure storage' }))
  t('§1 a failed save lands the error flow, never success', r.final.name === 'error' && !r.flows.includes('success'), `flows: ${r.flows.join('→')}`)
  t('§1 …recording nothing', r.recorded === 0)
  t('§1 …announcing nothing', r.notified === 0)
  t('§1 …and the error names the storage refusal', (r.final.message ?? '').includes('secure storage'), r.final.message ?? '')
}

// §2 the degraded save succeeds with the warning carried
{
  const r = await drive(() => ({ success: true, warning: 'saved to the plaintext fallback — the keychain refused' }))
  t('§2 a degraded save still succeeds', r.final.name === 'success')
  t('§2 …with the warning on the flow', (r.final.warning ?? '').includes('plaintext fallback'), JSON.stringify(r.final))
  t('§2 …and records + notifies', r.recorded === 1 && r.notified === 1)
}

// §3 the clean save is unchanged
{
  const r = await drive(() => ({ success: true }))
  t('§3 a clean save succeeds with no warning', r.final.name === 'success' && r.final.warning === undefined)
  t('§3 …and records + notifies exactly once', r.recorded === 1 && r.notified === 1)
}

// §4 the headless door
{
  const authSrc = await import('node:fs').then(m =>
    m.readFileSync(join(import.meta.dir, '../../src/cli/handlers/auth.ts'), 'utf8'),
  )
  t('§4 installOAuthTokens gates its save on the result', /const saved = saveOAuthTokensIfNeeded\(tokens\)/.test(authSrc) && /if \(!saved\.success\)/.test(authSrc))
}

console.log(failures === 0 ? 'LOGIN SAVE TRUTH: ALL PASS' : 'LOGIN SAVE TRUTH: RED')
process.exit(failures)
