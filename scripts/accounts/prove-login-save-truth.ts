#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'login-save-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME

const { createAnthropicLoginMachine } = await import('../../src/screen/widgets/faces/anthropicLoginModel.ts')

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
  tokenAccount: { uuid: 'uuid_x', emailAddress: 'operator@example.test' },
} as never

type SaveResult = { success: boolean; warning?: string }

async function drive(save: () => SaveResult): Promise<{
  flows: string[]
  final: { name: string; warning?: string; message?: string }
  recorded: number
  notified: number
  stored: number
  label: string | null
}> {
  const flows: string[] = []
  let recorded = 0
  let notified = 0
  let stored = 0
  let label: string | null = null
  let final: { name: string; warning?: string; message?: string } = { name: 'idle' }
  const machine = createAnthropicLoginMachine(
    { onDone: () => {} },
    snap => {
      flows.push(snap.flow.name)
      final = snap.flow as typeof final
      label = snap.accountLabel
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
      storeAccount: () => {
        stored++
      },
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
  await new Promise(resolve => setTimeout(resolve, 20))
  return { flows, final, recorded, notified, stored, label }
}

{
  const r = await drive(() => ({ success: false, warning: 'Failed to save credentials to secure storage' }))
  t('§1 a failed save lands the error flow, never success', r.final.name === 'error' && !r.flows.includes('success'), `flows: ${r.flows.join('→')}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must throw to the error flow when saveTokens answers success false`)
  t('§1 …recording nothing', r.recorded === 0, `recorded ${r.recorded}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.recordSignIn only after the save succeeds`)
  t('§1 …announcing nothing', r.notified === 0, `notified ${r.notified}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.notify only after the save succeeds`)
  t('§1 …storing no account and naming nobody', r.stored === 0 && r.label === null, `stored ${r.stored}, label ${String(r.label)}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.storeAccount and set accountLabel only after the save succeeds`)
  t('§1 …and the error names the storage refusal', (r.final.message ?? '').includes('secure storage'), `${r.final.message ?? ''}; the error flow's message in succeed (src/screen/widgets/faces/anthropicLoginModel.ts) must carry the save's warning`)
}

{
  const r = await drive(() => ({ success: true, warning: 'saved to the plaintext fallback — the keychain refused' }))
  t('§2 a degraded save still succeeds', r.final.name === 'success', `flow ${r.final.name}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must treat success true with a warning as a success`)
  t('§2 …with the warning on the flow', (r.final.warning ?? '').includes('plaintext fallback'), `${JSON.stringify(r.final)}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must pass saved.warning into the success flow`)
  t('§2 …and records + notifies', r.recorded === 1 && r.notified === 1, `recorded ${r.recorded}, notified ${r.notified}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.recordSignIn and deps.notify once on a degraded save`)
}

{
  const r = await drive(() => ({ success: true }))
  t('§3 a clean save succeeds with no warning', r.final.name === 'success' && r.final.warning === undefined, `${JSON.stringify(r.final)}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must add no warning to a clean save`)
  t('§3 …and records + notifies exactly once', r.recorded === 1 && r.notified === 1, `recorded ${r.recorded}, notified ${r.notified}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.recordSignIn and deps.notify once`)
  t('§3 …storing the account the sign-in landed once and naming it on the pane', r.stored === 1 && r.label === 'operator@example.test', `stored ${r.stored}, label ${String(r.label)}; succeed in src/screen/widgets/faces/anthropicLoginModel.ts must call deps.storeAccount once and set accountLabel from the token account email`)
}


console.log(failures === 0 ? 'LOGIN SAVE TRUTH: ALL PASS' : 'LOGIN SAVE TRUTH: RED')
process.exit(failures)
