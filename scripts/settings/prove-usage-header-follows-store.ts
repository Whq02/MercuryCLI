#!/usr/bin/env bun
import { mock } from 'bun:test'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('usage-header-follows-store')
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name)) delete process.env[name]
}
delete process.env.MERCURY_USAGE_SEED
delete process.env.MERCURY_MOCK_LIMITS
Object.assign(process.env, {
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_EVOLUTION_LEDGER: '0',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
})
const fetches: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetches.push(String(input))
  throw new Error('this fixture has no network')
}) as typeof fetch

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  const shown = detail.replace(/\s+/g, ' ').trim()
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && shown ? ` — ${shown.length > 320 ? `${shown.slice(0, 320)}…` : shown}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

async function stub(path: string, overrides: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...overrides }))
}
let held: Promise<void> = Promise.resolve()
let asks = 0
await stub('../../src/utils/auth.js', { isClaudeAISubscriber: () => true })
await stub('../../src/services/providers/providerUsage.js', {
  refreshProviderUsage: async (id: string): Promise<void> => {
    if (id !== 'anthropic') return
    asks += 1
    await held
  },
})

const React = await import('react')
const h = React.createElement
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const records = await import('../../src/services/anthropicLimits.js')
const { call } = await import('../../src/commands/usage/usage.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const auth = await import('../../src/utils/auth.js')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.js')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.js')
storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-0000000000dd', emailAddress: 'follows@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token-follows',
  refreshToken: 'fixture-refresh-token-follows',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')

const COLS = 178
const ROWS = 51
const RESET_5H = new Date(Date.now() + 4 * 3_600_000).toISOString()
const RESET_7D = new Date(Date.now() + 4 * 86_400_000).toISOString()
const fold = (session: number, week: number): void =>
  records.foldUtilizationFromEndpoint({
    five_hour: { utilization: session, resets_at: RESET_5H },
    seven_day: { utilization: week, resets_at: RESET_7D },
  })

const HEADER = /session on · \d+ subscription/
const headerRow = (m: Mounted): string => m.lines().find(line => HEADER.test(line)) ?? ''
const figure = (text: string, pattern: RegExp): string | undefined => pattern.exec(text)?.[1]
const headerFigures = (m: Mounted): { session?: string; week?: string } => {
  const row = headerRow(m)
  return { session: figure(row, /session (\d+)%/), week: figure(row, /(?:week|7d) (\d+)%/) }
}
const blockFigures = (m: Mounted): { session?: string; week?: string } => {
  const screen = m.screen()
  return { session: figure(screen, /Current session · (\d+)%/), week: figure(screen, /Current week \(all models\) · (\d+)%/) }
}
const sameFigures = (m: Mounted, session: string, week: string): boolean => {
  const header = headerFigures(m)
  const block = blockFigures(m)
  return header.session === session && block.session === session && header.week === week && block.week === week
}
const seen = (m: Mounted): string => `header ${JSON.stringify(headerFigures(m))} · block ${JSON.stringify(blockFigures(m))}`

section('§1 a popup opened on the stored 5% session and 53% week, its first read still pending')
let release: () => void = () => {}
held = new Promise<void>(resolve => {
  release = resolve
})
fold(5.5, 53.5)
const shell = await mountOffscreen(
  h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(Box, { flexDirection: 'column', width: COLS, height: ROWS }, h(SettingsPopupSlot, { overlay: true })))),
  COLS,
  ROWS,
)
await call('', {} as never)
const request = store.settingsPopupRequest()
const body = request?.body
const lead = (request?.line ?? '').replace(/ · session .*$/, '').replace(/ · (?:5h|week) .*$/, '')
check('the popup paints its header and the block is waiting on the first read', await waitFor(() => HEADER.test(headerRow(shell)) && shell.screen().includes('loading usage…'), 8000), shell.screen())
check('the header opens on the stored figures: session 5% · week 53%', headerFigures(shell).session === '5' && headerFigures(shell).week === '53', seen(shell))
check('the request line is the session lead with the stored figures', /^.* session on · \d+ subscriptions? signed in · session 5% · week 53%$/.test(request?.line ?? ''), request?.line ?? 'no request')
check('with no read landed, the painted header carries the request line byte for byte', headerRow(shell).includes(request?.line ?? '\0'), headerRow(shell))
const askedAtOpen = asks

section('§2 the first read lands: the store moves to 6% session, the block settles')
fold(6.5, 53.5)
release()
check('the block reads Current session · 6%', await waitFor(() => blockFigures(shell).session === '6', 6000), seen(shell))
check('the header reads the same session figure as the block (6%)', await waitFor(() => headerFigures(shell).session === '6', 4000), seen(shell))
check('the header and the block read the same week figure (53%)', headerFigures(shell).week === '53' && blockFigures(shell).week === '53', seen(shell))
check('the header keeps its other words: the same lead and subscriptions, then the new figures', headerRow(shell).includes(`${lead} · session 6% · week 53%`), headerRow(shell))

section('§3 a later read moves both windows; the floor of the figure is what both surfaces say')
fold(7.9, 54.9)
check('header and block both read session 7% and week 54% (floor of 7.9 and 54.9, never rounded up)', await waitFor(() => sameFigures(shell, '7', '54'), 4000), seen(shell))

section('§4 a read that moves neither floor leaves the painted header byte for byte')
const stillRow = headerRow(shell)
fold(7.2, 54.1)
await settle(300)
check('the header row is unchanged', headerRow(shell) === stillRow, `${stillRow} → ${headerRow(shell)}`)
check('header and block still read the same figures', sameFigures(shell, '7', '54'), seen(shell))

section('§5 the window clears: no live Anthropic figure left to show')
records.resetLimitsForCredentialSwitch()
check('the header carries no window figures and keeps its lead and subscriptions words', await waitFor(() => headerRow(shell).includes(lead) && !/\d+%/.test(headerRow(shell)), 4000), headerRow(shell))
check('following the store never reopened the read: one Anthropic ask for the one open', asks === askedAtOpen && asks === 1, `asks ${asks}`)

section('§6 a command opened on an empty store keeps the plain opening line')
await call('', {} as never)
check('the opening line is the lead and subscriptions words alone, byte for byte', store.settingsPopupRequest()?.line === lead, store.settingsPopupRequest()?.line ?? 'no request')
check('the painted header is that line, with no window figures', await waitFor(() => headerRow(shell).includes(lead) && !/\d+%/.test(headerRow(shell)), 4000), headerRow(shell))

section('§7 the body still stands on its own, with no popup frame around it')
store.closeSettingsPopup()
fold(9.5, 55.5)
let bare: Mounted | undefined
try {
  bare = await mountOffscreen(
    h(Box, { flexDirection: 'column', width: COLS, height: ROWS }, body?.({ width: 150, inner: 146, rowBudget: 22, compact: false }) as never),
    COLS,
    ROWS,
  )
  check('mounted without a frame, the block reads Current session · 9% and Current week (all models) · 55%', await waitFor(() => bare !== undefined && blockFigures(bare).session === '9' && blockFigures(bare).week === '55', 6000), bare.screen())
} catch (error) {
  check('the body mounts without a popup frame', false, String(error))
}

section('§8 no network')
check('no fixture fetch was needed', fetches.length === 0, JSON.stringify(fetches))

bare?.unmount()
shell.unmount()
await settle(60)
await releaseScratchHome(HOME)
console.log(`\nprove-usage-header-follows-store: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
