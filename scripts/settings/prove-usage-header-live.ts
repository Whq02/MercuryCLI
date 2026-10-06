#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-usage-header-live')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const limits = await import('../../src/services/anthropicLimits.js')
const owner = await import('../../src/services/providers/providerUsage.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const auth = await import('../../src/utils/auth.js')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.js')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.js')
storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-0000000000cc', emailAddress: 'header@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token-header',
  refreshToken: 'fixture-refresh-token-header',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')
const lineModule = await import('../../src/components/Settings/usageLine.ts').catch(() => null) as { usagePopupLine: () => string } | null
const usagePopupLine = (): string => lineModule?.usagePopupLine() ?? '(no one reader on this tree)'
const usageCommand = await import('../../src/commands/usage/usage.tsx')

const HOUR = 3_600_000
const fold = (weekPct: number, sessionPct: number): void => {
  const iso = new Date(Date.now() + HOUR).toISOString()
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: sessionPct, resets_at: iso }, seven_day: { utilization: weekPct, resets_at: iso } }, undefined, Date.now())
}
const weekOf = (line: string): string => /(?:week|7d) (\d+)%/.exec(line)?.[1] ?? '(no week)'
const blockWeek = (): string => {
  const w = owner.anthropicWindowViews().find(v => v.key === '7d')
  return w?.usedPct === undefined ? '(none)' : String(Math.floor(w.usedPct))
}

section('§1 one reader: the header line and the block floor the same window')
{
  limits.resetLimitsForCredentialSwitch()
  fold(56.4, 4.2)
  const first = usagePopupLine()
  check('the line names the week the record holds (56.4 → 56%)', weekOf(first) === '56' && first.includes('session 4%'), first)
  check('the block\'s own reader floors the same window to the same figure', blockWeek() === '56')
  fold(57.2, 4.9)
  const second = usagePopupLine()
  check('a fresh observation moves both readers together (57.2 → 57%)', weekOf(second) === '57' && blockWeek() === '57', second)
  const command = readFileSync(join(REPO, 'src/commands/usage/usage.tsx'), 'utf8')
  check('the command opens the popup with that one reader, never a line of its own', command.includes('line: usagePopupLine()') && !command.includes('Math.floor'))
}

section('§2 the open popup: the header follows the body\'s refresh instead of the figure it opened with')
{
  limits.resetLimitsForCredentialSwitch()
  fold(56.4, 4.2)
  const COLS = 178
  const ROWS = 51
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  await usageCommand.call('', {} as never)
  const headerUp = await waitFor(() => /week 56%/.test(m.screen()), 6000)
  check('the popup opened with the header meters of the record at open time (week 56%)', headerUp, m.lines().find(l => /session on ·/.test(l))?.trim() ?? m.screen().slice(0, 200))
  check('the request carried the same line', weekOf(store.settingsPopupRequest()?.line ?? '') === '56')
  fold(57.2, 4.9)
  const moved = await waitFor(() => /(?:week|7d) 57%/.test(m.screen()), 6000)
  const header = m.lines().find(l => /session on ·/.test(l))?.trim() ?? ''
  check('RED ON THE BASE: the endpoint answers while the popup stands and the header reads the new week (57%) — the figure the block paints', moved && !/56%/.test(header), header)
  check('the header and the block\'s reader agree', weekOf(header) === blockWeek(), `${weekOf(header)} vs ${blockWeek()}`)
  store.closeSettingsPopup()
  await settle(60)
  m.unmount()
}

await releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? '✅ prove-usage-header-live: one window, one reading — the header follows the body' : `❌ prove-usage-header-live: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
