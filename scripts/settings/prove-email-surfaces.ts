#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

const ROOT = join(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const framesDir = argument('--frames')
if (framesDir) mkdirSync(framesDir, { recursive: true })
const PROFILE_EMAIL = 'owner@example.com'
const RECORD_EMAIL = 'ring@example.com'
const RECEIPT_EMAIL = 'receipt@example.com'
const LONG_EMAIL = 'a-very-long-fixture-account-name@subdomain.example.com'
const ACCESS_TOKEN = 'fixture-claude-access-token-0001'
const PROOF_KEY = 'proof-key-ci-gate-not-a-real-key'
const MODEL = 'claude-fable-5-1'
const SIZES = [{ columns: 178, rows: 51 }, { columns: 80, rows: 21 }] as const

delete process.env.NODE_ENV
const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'email-surfaces-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, {
  HOME,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_AUTH_SCOPE_DIR: HOME,
  MERCURY_HOME: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_EVOLUTION_LEDGER: '0',
  MERCURY_LIVE_GLYPHS: '0',
  BROWSER: '/usr/bin/true',
  TZ: 'UTC',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
})
for (const name of ['MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_OAUTH_BASE', 'MERCURY_HUGGINGFACE_ROUTER_BASE', 'MERCURY_LOCAL_BASE_URL']) process.env[name] = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const originalNow = Date.now
const originalLocale = Date.prototype.toLocaleString
const NOW = 1_800_000_000_000
Date.now = () => NOW
Date.prototype.toLocaleString = function (_locales, options) {
  return originalLocale.call(this, 'en-GB', { ...options, timeZone: 'UTC', hourCycle: 'h23' })
}
const utilization = {
  five_hour: { utilization: 52, resets_at: new Date(NOW + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: 49, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
  seven_day_fable: { utilization: 46, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
  seven_day_opus: { utilization: 12, resets_at: new Date(NOW + 3 * 86_400_000).toISOString() },
}
const requests: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (request.method === 'GET' && path === '/api/oauth/usage' && request.headers.get('authorization') === `Bearer ${ACCESS_TOKEN}`) return Response.json(utilization)
    return new Response(null, { status: 404 })
  },
})
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
const escaped: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== `http://127.0.0.1:${server.port}`) {
    escaped.push(url.href)
    throw new Error('only the loopback fixture may be contacted')
  }
  return originalFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
  if (!pass) console.log('       change: the surface named in the label must show the credential\'s own email (never the config record); by surface see logins in src/screen/boot-face/BootLoginsScreen.tsx, face chip in sessionAccountWords in src/models/sign-in/accounts/sessionAccount.ts, usage popup and card via anthropicCredentialPresence and anthropicSignInEmail in src/models/roads/providerUsage.ts, /accounts board in scopeSlotTail in src/models/roads/accountSlots.ts, auth status in authStatus in src/commands/verbs/auth.ts, seat wire in src/engine/connector/seatWire.ts; the text after the dash is what was found')
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
async function stub(relative: string, overrides: Record<string, unknown>): Promise<void> {
  const target = join(ROOT, relative)
  const actual = await import(target)
  mock.module(target, () => ({ ...actual, ...overrides }))
}
await stub('src/platform/network/proxy.ts', { getApiFetch: () => globalThis.fetch, getProxyFetchOptions: () => ({}) })

const CREDENTIALS = join(HOME, '.credentials.json')
type Fixture = { profile?: string; receipt?: string; record?: string; envKey?: boolean }
function writeFixture(fixture: Fixture): void {
  const claudeAiOauth = fixture.envKey
    ? undefined
    : {
        accessToken: ACCESS_TOKEN,
        refreshToken: 'fixture-claude-refresh-token-0001',
        expiresAt: NOW + 30 * 86_400_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
        ...(fixture.profile !== undefined
          ? { profile: { account: { uuid: 'uuid-profile-fixture', email: fixture.profile, display_name: 'Fixture Owner', created_at: '2025-06-01T00:00:00Z' }, organization: { uuid: 'org-profile-fixture', organization_type: 'claude_max' } } }
          : {}),
        ...(fixture.receipt !== undefined ? { tokenAccount: { uuid: 'uuid-receipt-fixture', emailAddress: fixture.receipt } } : {}),
      }
  writeFileSync(CREDENTIALS, JSON.stringify(claudeAiOauth === undefined ? {} : { claudeAiOauth }, null, 2) + '\n', { mode: 0o600 })
  if (fixture.envKey) process.env.ANTHROPIC_API_KEY = PROOF_KEY
  else delete process.env.ANTHROPIC_API_KEY
}
writeFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })
const config = await import(join(ROOT, 'src/platform/settings/config.ts'))
config.enableConfigs()
const auth = { ...(await import(join(ROOT, 'src/models/sign-in/credentials/auth.ts'))), ...(await import(join(ROOT, 'src/models/sign-in/lifecycle/oauthLifecycle.ts'))) }
const ledger = await import(join(ROOT, 'src/models/sign-in/account-ledger/signInLedger.ts'))
const wallet = await import(join(ROOT, 'src/models/wallet/wallet.ts'))
const limits = await import(join(ROOT, 'src/models/roads/anthropic/anthropicLimits.ts'))
const identityCache = await import(join(ROOT, 'src/models/sign-in/account-ledger/accountIdentity.ts'))
function settleFixture(fixture: Fixture): void {
  writeFixture(fixture)
  config.saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    oauthAccount: fixture.record !== undefined ? { accountUuid: 'uuid-record-fixture', emailAddress: fixture.record, organizationUuid: 'org-record-fixture' } : undefined,
  }))
  auth.dropCredentialMemos()
  wallet.resetWalletEntriesMemo()
  identityCache.forgetScopeIdentity()
  limits.resetLimitsForCredentialSwitch()
  ledger.noteCredentialChange()
}
settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })

await stub('src/screen/keys/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
await stub('src/screen/keys/useExitChord.ts', { useExitOnCtrlCD: () => undefined })
await stub('src/screen/notifications/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('src/platform/health/healthCertSnapshot.ts', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
const connector = {
  modelFacts: () => ({ main: MODEL, effective: MODEL }),
  subscribeModel: () => () => {},
  records: () => [],
  subscribeRecords: () => () => {},
  usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }),
}
await stub('src/engine/connector/focusedConnector.ts', {
  getFocusedSessionConnector: () => connector,
  subscribeThroughFocused: (subscribe: (connection: typeof connector, listener: () => void) => () => void) => (listener: () => void) => subscribe(connector, listener),
  hasFocusedSession: () => false,
  landingInFlight: () => false,
  subscribeFocusedSessionConnector: () => () => {},
})
await stub('src/screen/tasks/useFocusedWork.ts', {
  useFocusedWorkRows: () => [],
  useFocusedWorkRoster: () => ({ rows: [], mission: [], reported: true }),
  focusedSessionIdOrNull: () => null,
})
await stub('src/screen/app-state/vitalsBus.ts', { useVitals: () => ({ trace: null }) })

const ink = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
const { default: StdinContext } = await import(join(ROOT, 'src/screen/renderer/elements/StdinContext.ts'))
const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const MODE_SEQUENCES = /\x1b\[[?>=<][0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[<u|\x1b\[>4m/g
function plain(raw: string): string {
  return stripAnsi(raw.replace(MODE_SEQUENCES, ''))
    .replace(/\n$/, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
}
async function paint(content: React.ReactNode, columns: number, rows: number): Promise<string> {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { width: columns, height: rows, flexDirection: 'column' }, content))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  await settle()
  const frame = plain(instance.lastFrame())
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame
}
function save(name: string, frame: string): void {
  if (framesDir) writeFileSync(join(framesDir, `${name}.txt`), frame + '\n')
}
const inBounds = (frame: string, columns: number, rows: number): boolean =>
  frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns)
const lineWith = (frame: string, needle: string): string | undefined => frame.split('\n').find(line => line.includes(needle))
const rosterRow = (frame: string): string => {
  const label = 'Anthropic — Claude subscription'
  const lines = frame.split('\n')
  const matches = lines.map((line, index) => ({ line, index })).filter(item => item.line.includes(label))
  const hit = matches.sort((a, b) => a.line.indexOf(label) - b.line.indexOf(label))[0]
  if (!hit) return ''
  const next = lines[hit.index + 1] ?? ''
  const nextCell = next.includes('│') ? (next.split('│')[1] ?? '') : ''
  return nextCell.trim() !== '' && !nextCell.includes('—') ? `${hit.line}\n${nextCell}` : hit.line
}
const lineAfter = (frame: string, needle: string): string => {
  const lines = frame.split('\n')
  const at = lines.findIndex(line => line.includes(needle))
  return at < 0 ? '' : (lines[at + 1] ?? '')
}

const logins = await import(join(ROOT, 'src/screen/boot-face/BootLoginsScreen.tsx'))
const { BootSplashScreen } = await import(join(ROOT, 'src/screen/boot-face/BootSplashScreen.tsx'))
const { HelmVitalsRail } = await import(join(ROOT, 'src/screen/fullscreen-layout/HelmVitalsRail.tsx'))
const { railPlanAt } = await import(join(ROOT, 'src/screen/fullscreen-layout/helmGeometry.ts'))
const { settingsPopupGeometry } = await import(join(ROOT, 'src/screen/overlays/SettingsPopupSlot.tsx'))
const popupStore = await import(join(ROOT, 'src/screen/cockpit/settingsPopup.ts'))
const usageCommand = await import(join(ROOT, 'src/commands/usage/usage.tsx'))
const usage = await import(join(ROOT, 'src/models/roads/providerUsage.ts'))
const session = await import(join(ROOT, 'src/models/sign-in/accounts/sessionAccount.ts'))

type Surfaces = { logins: string; face: string; popup: string; card: string }
async function paintSurfaces(size: { columns: number; rows: number }, tag: string): Promise<Surfaces> {
  const { columns, rows } = size
  const stamp = `${tag}-${columns}x${rows}`
  const loginsFrame = await paint(React.createElement(logins.BootLoginsScreen, { fullScene: { columns, rows } }), columns, rows)
  save(`logins-${stamp}`, loginsFrame)
  const faceFrame = await paint(React.createElement(BootSplashScreen), columns, rows)
  save(`face-${stamp}`, faceFrame)
  await usageCommand.call('', {} as never)
  const request = popupStore.settingsPopupRequest()
  popupStore.closeSettingsPopup()
  const geometry = request === null ? null : settingsPopupGeometry(request, columns, rows)
  const popupFrame = request === null || geometry === null
    ? 'no usage popup request'
    : await paint(request.body({ width: geometry.width, inner: geometry.inner, rowBudget: geometry.rowBudget }) as React.ReactNode, columns, rows)
  save(`usage-popup-${stamp}`, popupFrame)
  const plan = railPlanAt(columns, true)
  const cardFrame = plan.vitals
    ? await paint(React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: columns }, React.createElement(HelmVitalsRail, { width: plan.vitalsW, availRows: rows - 7 })), columns, rows)
    : `no sidebar usage card at ${columns}x${rows}: the cockpit's vitals rail needs both rails engaged (railPlanAt vitals=false)`
  save(`usage-card-${stamp}`, cardFrame)
  return { logins: loginsFrame, face: faceFrame, popup: popupFrame, card: cardFrame }
}
function rosterWords(): { chip: string; detail: string[] } {
  const facts = logins.collectLoginsScreenFacts()
  const arm = logins.loginsSortedArms(facts).find(candidate => candidate.familyId === 'anthropic')!
  return { chip: logins.loginsRowStateOf(arm, facts).chip, detail: logins.loginsDetailLines(arm, facts) }
}
const chipWords = (): string => {
  const words = session.sessionAccountWords(MODEL)
  return words.state === 'email' ? words.text : words.state
}

section('§1 the stored profile beside the token names the account; the config record names another')
{
  const words = rosterWords()
  check('the roster row chip is the credential\'s own email', words.chip === PROFILE_EMAIL, words.chip)
  check('the roster detail names the credential\'s own email on the OAuth slot line', words.detail.some(line => line.includes(`OAuth — ${PROFILE_EMAIL}`)) && !words.detail.some(line => line.includes(RECORD_EMAIL)), JSON.stringify(words.detail))
  check('the face chip composer names the credential\'s own email', chipWords() === PROFILE_EMAIL, chipWords())
  check('the presence owner names the credential\'s own email', usage.anthropicCredentialPresence().identity === PROFILE_EMAIL, JSON.stringify(usage.anthropicCredentialPresence()))
  for (const size of SIZES) {
    const stamp = `${size.columns}x${size.rows}`
    const frames = await paintSurfaces(size, 'profile')
    const row = rosterRow(frames.logins)
    check(`${stamp} logins: the Claude row carries the credential's own email`, row.includes(PROFILE_EMAIL), row)
    check(`${stamp} logins: the config record's email is nowhere on the roster`, !frames.logins.includes(RECORD_EMAIL), lineWith(frames.logins, RECORD_EMAIL))
    check(`${stamp} face: the approved boot face paints no account chip and never the config record`, !frames.face.includes('Acct') && !frames.face.includes(RECORD_EMAIL), lineWith(frames.face, 'Acct') ?? lineWith(frames.face, RECORD_EMAIL))
    check(`${stamp} usage popup: the Anthropic subscription slot says Signed in as <email>`, frames.popup.includes(`Signed in as ${PROFILE_EMAIL}`), lineWith(frames.popup, 'Subscription') ?? frames.popup.split('\n').slice(0, 6).join(' | '))
    check(`${stamp} usage popup: the identity line sits under the Anthropic usage title`, lineAfter(frames.popup, 'Anthropic usage').includes(`Signed in as ${PROFILE_EMAIL}`), lineAfter(frames.popup, 'Anthropic usage'))
    check(`${stamp} usage popup: the config record's email is nowhere`, !frames.popup.includes(RECORD_EMAIL))
    if (size.columns >= 150) {
      check(`${stamp} usage card: the line under Anthropic usage is the credential's own email`, lineAfter(frames.card, 'Anthropic usage').includes(PROFILE_EMAIL), lineAfter(frames.card, 'Anthropic usage'))
      check(`${stamp} usage card: the config record's email is nowhere`, !frames.card.includes(RECORD_EMAIL))
      check(`${stamp} usage card: the frame stays inside the terminal`, inBounds(frames.card, size.columns, size.rows))
    } else {
      check(`${stamp} usage card: no vitals rail exists at this size (recorded)`, frames.card.startsWith('no sidebar usage card'), frames.card)
    }
    check(`${stamp} every painted frame stays inside the terminal`, inBounds(frames.logins, size.columns, size.rows) && inBounds(frames.face, size.columns, size.rows) && inBounds(frames.popup, size.columns, size.rows))
  }
}

section('§2 a long email clips with each surface\'s own tail marker, never past the width')
{
  settleFixture({ profile: LONG_EMAIL, receipt: LONG_EMAIL, record: RECORD_EMAIL })
  const words = rosterWords()
  check('the roster chip hands the whole email to the composer', words.chip === LONG_EMAIL, words.chip)
  check('the face chip composer hands the whole email to the strip', chipWords() === LONG_EMAIL, chipWords())
  for (const size of SIZES) {
    const stamp = `${size.columns}x${size.rows}`
    const frames = await paintSurfaces(size, 'long')
    const row = rosterRow(frames.logins)
    const nextRow = lineAfter(frames.logins, 'Anthropic — Claude subscription')
    const loginsOk = size.columns >= 120
      ? (row.includes(LONG_EMAIL) || nextRow.includes(LONG_EMAIL)) && !frames.logins.includes(`${LONG_EMAIL.slice(0, 25)}…`)
      : /a-very-long-fixtur\S*…/.test(row) && !row.includes(LONG_EMAIL)
    check(`${stamp} logins: ${size.columns >= 120 ? 'wide tier shows the whole email inside its panel' : 'narrow tier clips the email with an ellipsis'}`, loginsOk, `${row} | ${nextRow}`)
    const popupLine = lineWith(frames.popup, 'Signed in as') ?? ''
    check(`${stamp} usage popup: the identity line is present and never wider than its column`, popupLine.includes('Signed in as ') && (popupLine.includes(LONG_EMAIL) || popupLine.includes('…')), popupLine)
    if (size.columns >= 150) {
      const cardLine = lineAfter(frames.card, 'Anthropic usage')
      check(`${stamp} usage card: the email clips with an ellipsis inside the rail width`, cardLine.includes(`${LONG_EMAIL.slice(0, 10)}`) && cardLine.includes('…') && !cardLine.includes(LONG_EMAIL) && stringWidth(cardLine) <= size.columns, cardLine)
      check(`${stamp} usage card: the frame stays inside the terminal`, inBounds(frames.card, size.columns, size.rows))
    }
    check(`${stamp} every painted frame stays inside the terminal`, inBounds(frames.logins, size.columns, size.rows) && inBounds(frames.face, size.columns, size.rows) && inBounds(frames.popup, size.columns, size.rows))
  }
}

section('§3 a receipt beside the token names the account when no profile was stored')
{
  settleFixture({ receipt: RECEIPT_EMAIL, record: RECORD_EMAIL })
  const words = rosterWords()
  check('the roster chip is the receipt\'s email', words.chip === RECEIPT_EMAIL, words.chip)
  check('the face chip composer is the receipt\'s email', chipWords() === RECEIPT_EMAIL, chipWords())
  check('the presence owner is the receipt\'s email', usage.anthropicCredentialPresence().identity === RECEIPT_EMAIL, JSON.stringify(usage.anthropicCredentialPresence()))
}

section('§4 a credential with no stored email paints today\'s words and never the config record')
{
  settleFixture({ record: RECORD_EMAIL })
  const words = rosterWords()
  check('the roster chip falls to its signed-in word', words.chip === 'signed in', words.chip)
  check('the face chip composer falls to the credential\'s plan label', chipWords() === 'Claude subscription (max)', chipWords())
  check('the presence owner records no identity', usage.anthropicCredentialPresence().identity === undefined, JSON.stringify(usage.anthropicCredentialPresence()))
  const size = SIZES[0]
  const frames = await paintSurfaces(size, 'no-email')
  check('178x51 logins: the config record\'s email is nowhere', !frames.logins.includes(RECORD_EMAIL), lineWith(frames.logins, RECORD_EMAIL))
  check('178x51 face: the approved boot face paints no account chip and never the record', !frames.face.includes('Acct') && !frames.face.includes(RECORD_EMAIL), lineWith(frames.face, 'Acct') ?? lineWith(frames.face, RECORD_EMAIL))
  check('178x51 usage popup: no identity line, never the record', !frames.popup.includes('Signed in as') && !frames.popup.includes(RECORD_EMAIL), lineWith(frames.popup, 'Signed in as'))
  check('178x51 usage card: no identity line, never the record', !frames.card.includes('@') && !frames.card.includes(RECORD_EMAIL), lineAfter(frames.card, 'Anthropic usage'))
}

section('§5 a key-based sign-in is unchanged')
{
  settleFixture({ envKey: true })
  const size = SIZES[0]
  const frames = await paintSurfaces(size, 'key')
  const keyRow = rosterRow(frames.logins)
  check('178x51 logins: the Anthropic row names the env key, no email', keyRow.includes('ANTHROPIC_API_KEY') && !frames.logins.includes('@'), keyRow)
  check('178x51 face: the approved boot face paints no account chip and no email', !frames.face.includes('Acct') && !frames.face.includes('@'), lineWith(frames.face, 'Acct') ?? lineWith(frames.face, '@'))
  check('178x51 usage popup: the key slot, no identity line', frames.popup.includes('Anthropic API key (ANTHROPIC_API_KEY)') && !frames.popup.includes('Signed in as'), lineWith(frames.popup, 'API key'))
  check('178x51 usage card: API usage, no email', frames.card.includes('API usage') && !frames.card.includes('@'), lineWith(frames.card, 'usage'))
}

section('§6 no wire probe at paint time; the loopback fixture saw only the usage read')
{
  check('no request reached the OAuth profile endpoint while painting', !requests.some(path => path.includes('/api/oauth/profile')), JSON.stringify(requests))
  check('the usage endpoint was read with the fixture token', requests.some(path => path === 'GET /api/oauth/usage'), JSON.stringify(requests))
  check('no fetch escaped the loopback box', escaped.every(url => url.startsWith('http://127.0.0.1:1/')), JSON.stringify(escaped.slice(0, 4)))
}


type ScopeRead = import('../../src/models/sign-in/account-ledger/accountIdentity.ts').ScopeIdentityState
let probe: (dir: string) => Promise<ScopeRead> = () => new Promise<ScopeRead>(() => {})
await stub('src/models/sign-in/account-ledger/accountIdentity.ts', { resolveLiveScopeIdentity: (dir: string) => probe(dir) })
const slots = await import(join(ROOT, 'src/models/roads/accountSlots.ts'))
const status = await import(join(ROOT, 'src/commands/verbs/status.tsx'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { AccountView } = await import(join(ROOT, 'src/screen/widgets/parity/AccountView.tsx'))
const { ModalContext } = await import(join(ROOT, 'src/screen/overlays/modalContext.tsx'))
const boardRow = (frame: string): string => frame.split('\n').find(line => /\bclaude\s+OAuth\b/.test(line)) ?? ''
async function paintBoard(size: { columns: number; rows: number }, tag: string, read?: ScopeRead): Promise<string> {
  probe = read === undefined ? () => new Promise<ScopeRead>(() => {}) : async () => read
  const frame = await paint(
    React.createElement(ModalContext.Provider, { value: { rows: size.rows, columns: size.columns, scrollRef: null } },
      React.createElement(AppStateProvider, null,
        React.createElement(ink.Box, { flexShrink: 0, flexDirection: 'column' }, React.createElement(AccountView, { onClose: () => {} })))),
    size.columns,
    size.rows,
  )
  save(`accounts-${tag}-${size.columns}x${size.rows}`, frame)
  return frame
}
function scopeWords(read: ScopeRead | undefined): { tail: string; mainLoop: string; identity: string } {
  const groups = slots.deriveFamilySlotGroups()
  const scope = groups.find(group => group.family.id === 'anthropic')?.slots.find(slot => slot.scope !== undefined)
  if (scope === undefined) return { tail: 'no anthropic scope slot', mainLoop: '', identity: '' }
  const identities = read === undefined ? {} : { [scope.id]: read }
  const tail = slots.scopeSlotTail(slots.slotSigninState(scope, identities), read, scope)
  const mainLoop = slots.mainLoopIdentity({ model: MODEL, presences: groups.map(group => group.family), currentScopeIdentity: read ?? { state: 'checking' } }).text
  return { tail, mainLoop, identity: scope.identity }
}

section('§8 the /accounts board names the credential\'s own email; the config record rides only as a labelled snapshot beside it')
{
  settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })
  const checking = scopeWords(undefined)
  check('the scope row tail names the credential\'s own email first while the probe is out', checking.tail.startsWith(`${PROFILE_EMAIL} · `) && checking.tail.endsWith('verifying identity…'), checking.tail)
  check('…and the differing config record rides beside it, labelled a snapshot', checking.tail.includes(` · snapshot ${RECORD_EMAIL} · `), checking.tail)
  check('the main-loop row names the credential\'s own email and never labels it a snapshot', checking.mainLoop.includes(` · ${PROFILE_EMAIL} · verifying identity…`) && !checking.mainLoop.includes('snapshot'), checking.mainLoop)
  const expiredRead: ScopeRead = { state: 'expired', snapshotEmail: RECORD_EMAIL }
  const expired = scopeWords(expiredRead)
  check('an expired credential is named by its own email, the record labelled beside it', expired.tail === `expired — ${PROFILE_EMAIL} (snapshot ${RECORD_EMAIL}) · not signed in · ↵ opens Logins to reauth`, expired.tail)
  check('…on the main-loop row too', expired.mainLoop.includes(`credential expired · ${PROFILE_EMAIL} (snapshot ${RECORD_EMAIL})`), expired.mainLoop)
  const offlineRead: ScopeRead = { state: 'unverified', email: RECORD_EMAIL, note: 'offline (fixture)' }
  const offline = scopeWords(offlineRead)
  check('an offline probe leaves the credential\'s own email on the row, the record labelled beside it', offline.tail === `unverified — offline (fixture) · ${PROFILE_EMAIL} · snapshot ${RECORD_EMAIL} · not counted as signed in`, offline.tail)
  check('…on the main-loop row too', offline.mainLoop.endsWith(`unverified — offline (fixture) · ${PROFILE_EMAIL} · snapshot ${RECORD_EMAIL}`), offline.mainLoop)
  for (const size of SIZES) {
    const stamp = `${size.columns}x${size.rows}`
    const frame = await paintBoard(size, 'profile')
    const row = boardRow(frame)
    check(`${stamp} accounts: the Claude row's tail opens with the credential's own email`, row.includes(PROFILE_EMAIL) && !row.includes(`snapshot ${PROFILE_EMAIL}`) && (row.indexOf('snapshot') < 0 || row.indexOf(PROFILE_EMAIL) < row.indexOf('snapshot')), row)
    if (size.columns >= 150) {
      check(`${stamp} accounts: the record rides beside it as a labelled snapshot, then the probe word`, row.includes(`${PROFILE_EMAIL} · snapshot ${RECORD_EMAIL} · verifying identity…`), row)
      const mainLoop = lineWith(frame, 'main loop') ?? ''
      check(`${stamp} accounts: the main-loop row names the credential's own email, unlabelled`, mainLoop.includes(`· ${PROFILE_EMAIL} · verifying identity…`) && !mainLoop.includes('snapshot'), mainLoop)
      check(`${stamp} accounts: the frame stays inside the terminal`, inBounds(frame, size.columns, size.rows))
    } else {
      check(`${stamp} accounts: the row never opens with the record`, !row.includes(`snapshot ${RECORD_EMAIL} · verifying`), row)
      check(`${stamp} accounts: the compact board stays inside the terminal`, inBounds(frame, size.columns, size.rows))
    }
  }
  const size = SIZES[0]
  const expiredFrame = await paintBoard(size, 'expired', expiredRead)
  check('178x51 accounts (expired): the row names the credential\'s own email, the record labelled', boardRow(expiredFrame).includes(`expired — ${PROFILE_EMAIL} (snapshot ${RECORD_EMAIL})`), boardRow(expiredFrame))
  const offlineFrame = await paintBoard(size, 'offline', offlineRead)
  check('178x51 accounts (offline): the row names the credential\'s own email, the record labelled', boardRow(offlineFrame).includes(`${PROFILE_EMAIL} · snapshot ${RECORD_EMAIL}`), boardRow(offlineFrame))
  settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: PROFILE_EMAIL })
  const agree = scopeWords(undefined)
  check('a record that agrees with the credential is not repeated: one address, no snapshot word', agree.tail === `${PROFILE_EMAIL} · verifying identity…`, agree.tail)
  const agreeFrame = await paintBoard(size, 'agree')
  check('178x51 accounts (agree): one address on the row, no snapshot word', boardRow(agreeFrame).includes(`${PROFILE_EMAIL} · verifying identity…`) && !boardRow(agreeFrame).includes('snapshot'), boardRow(agreeFrame))
  settleFixture({ record: RECORD_EMAIL })
  const nameless = scopeWords(undefined)
  check('a credential with no stored email leaves the labelled snapshot standing alone (recorded)', nameless.tail === `snapshot ${RECORD_EMAIL} · verifying identity…` && nameless.identity === 'signed in', `${nameless.tail} | ${nameless.identity}`)
  const namelessFrame = await paintBoard(size, 'no-email')
  check('178x51 accounts (no email): the row carries the labelled snapshot and no bare address', boardRow(namelessFrame).includes(`snapshot ${RECORD_EMAIL} · verifying identity…`), boardRow(namelessFrame))
  settleFixture({ envKey: true })
  const keyFrame = await paintBoard(size, 'key')
  const keyRow = lineWith(keyFrame, 'API key · env') ?? ''
  check('178x51 accounts (key): the key row names the env key and no email; no OAuth row', keyRow.includes('ANTHROPIC_API_KEY (env)') && !keyFrame.includes('@') && boardRow(keyFrame) === '', keyRow)
  check('no request reached the OAuth profile endpoint while the board painted', !requests.some(path => path.includes('/api/oauth/profile')), JSON.stringify(requests))
}

section('§9 auth status names the credential\'s own email; the JSON shape is the contract it was')
{
  const RUNNER = join(HOME, 'auth-status-runner.ts')
  writeFileSync(RUNNER, [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    `const { enableConfigs } = await import(${JSON.stringify(join(ROOT, 'src/platform/settings/config.ts'))})`,
    'enableConfigs()',
    `const { authStatus } = await import(${JSON.stringify(join(ROOT, 'src/commands/verbs/auth.ts'))})`,
    'await authStatus({ json: true })',
  ].join('\n') + '\n')
  const authStatusJson = (): { status: number; json: Record<string, unknown> | null; stdout: string; stderr: string } => {
    const result = Bun.spawnSync([process.execPath, RUNNER], { cwd: HOME, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    const stdout = result.stdout.toString()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      json = null
    }
    return { status: result.exitCode, json, stdout, stderr: result.stderr.toString() }
  }
  const emailRow = (): string => {
    const property = status.buildAccountProperties().find(candidate => candidate.label === 'Email')
    return property === undefined ? 'no Email row' : status.propertyValueToText(property.value)
  }
  settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })
  const info = auth.getAccountInformation()
  check('getAccountInformation().email is the credential\'s own email', info?.email === PROFILE_EMAIL, JSON.stringify(info))
  check('the readable Email row (auth status on a terminal, /status) reads it', emailRow() === PROFILE_EMAIL, emailRow())
  const signedIn = authStatusJson()
  check('auth status --json: stdout is JSON, exit 0 on the signed-in ladder', signedIn.json !== null && signedIn.status === 0, `status=${signedIn.status} stdout=${signedIn.stdout.slice(0, 160)} stderr=${signedIn.stderr.slice(0, 300)}`)
  check('auth status --json: email is the credential\'s own', signedIn.json?.email === PROFILE_EMAIL, JSON.stringify(signedIn.json?.email))
  check('auth status --json: the key set is the contract\'s, in order', JSON.stringify(Object.keys(signedIn.json ?? {})) === JSON.stringify(['loggedIn', 'authMethod', 'email', 'orgId', 'orgName', 'subscriptionType', 'routedProvider', 'providers']), JSON.stringify(Object.keys(signedIn.json ?? {})))
  check('auth status --json: loggedIn true, authMethod claude.ai, orgId still the record\'s (not this change\'s)', signedIn.json?.loggedIn === true && signedIn.json?.authMethod === 'claude.ai' && signedIn.json?.orgId === 'org-record-fixture', JSON.stringify(signedIn.json))
  settleFixture({ record: RECORD_EMAIL })
  const namelessInfo = auth.getAccountInformation()
  check('a credential with no stored email names nobody — never the record', namelessInfo?.email === undefined && emailRow() === 'no Email row', JSON.stringify(namelessInfo))
  const nameless = authStatusJson()
  check('auth status --json: email null for a nameless credential, the key kept', nameless.json !== null && 'email' in nameless.json && nameless.json.email === null, JSON.stringify(nameless.json))
  settleFixture({ envKey: true })
  const keyInfo = auth.getAccountInformation()
  check('a key-based sign-in is unchanged: the key source, no email', keyInfo?.apiKeySource === 'ANTHROPIC_API_KEY' && keyInfo.email === undefined, JSON.stringify(keyInfo))
  const key = authStatusJson()
  check('auth status --json for the key: authMethod api_key, apiKeySource named, no email key', key.json?.authMethod === 'api_key' && key.json?.apiKeySource === 'ANTHROPIC_API_KEY' && !('email' in (key.json ?? {})), JSON.stringify(key.json))
}

type SeatIdentity = import('../../src/engine/connector/types.ts').SeatIdentityV1
section('§10 the seat facts a hosted session answers carry the credential\'s own email; the wire, the daemon\'s seat and the cockpit\'s connector relay it untouched')
{
  const { liveFactsOf, withLiveRunner } = await import('../lib/builtProduct.ts')
  const billing = await import(join(ROOT, 'src/models/usage/billing.ts'))
  const ownIdentity = (): SeatIdentity => ({ firstPartyApi: auth.is1PApiCustomer(), consoleBilling: billing.hasConsoleBillingAccess(), claudeAiBilling: billing.hasClaudeAiBillingAccess(), accountEmail: usage.anthropicSignInEmail() ?? null })
  const identityOf = (): Promise<SeatIdentity | string> =>
    withLiveRunner(liveFactsOf, { env: { MERCURY_CONFIG_DIR: HOME, MERCURY_AUTH_SCOPE_DIR: HOME, ...(process.env.ANTHROPIC_API_KEY === undefined ? {} : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }) } }).then(
      facts => facts.identity,
      (error: unknown) => `the runner did not answer its facts: ${error instanceof Error ? error.message : String(error)}`,
    )
  settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })
  const identity = await identityOf()
  const readerSays = [JSON.stringify(typeof identity === 'string' ? identity : identity) === JSON.stringify(ownIdentity())]
  check('the runner\'s session_facts arm composes the identity block the seat wire carries', typeof identity !== 'string' && JSON.stringify(Object.keys(identity).sort()) === JSON.stringify(['accountEmail', 'claudeAiBilling', 'consoleBilling', 'firstPartyApi']), JSON.stringify(identity))
  check('the seat facts\' identity.accountEmail is the credential\'s own email, never the config record', typeof identity !== 'string' && identity.accountEmail === PROFILE_EMAIL, JSON.stringify(identity))
  check('the other identity facts stand (a subscriber: not a first-party API customer, claude.ai billing)', typeof identity !== 'string' && identity.firstPartyApi === false && identity.claudeAiBilling === true && identity.consoleBilling === false, typeof identity === 'string' ? identity : JSON.stringify(identity))
  const seatWire = await import(join(ROOT, 'src/engine/connector/seatWire.ts'))
  const zeroUsage = { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }
  const answerWith = (who: SeatIdentity | string): Record<string, unknown> => ({
    model: { effective: MODEL, setting: null },
    usage: zeroUsage,
    identity: typeof who === 'string' ? { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: who } : who,
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd: HOME, originalCwd: HOME, projectRoot: HOME, instructionRoots: [] },
    queue: [],
  })
  const onWire = seatWire.sessionFactsToWire(answerWith(identity) as never) as { identity?: Record<string, unknown> }
  check('the wire carries it under account_email, the key unchanged by name', onWire.identity?.account_email === PROFILE_EMAIL && !('accountEmail' in (onWire.identity ?? {})), JSON.stringify(onWire.identity))
  check('the wire\'s identity keys are the contract\'s four', JSON.stringify(Object.keys(onWire.identity ?? {}).sort()) === JSON.stringify(['account_email', 'claude_ai_billing', 'console_billing', 'first_party_api']), JSON.stringify(Object.keys(onWire.identity ?? {})))
  const decoded = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(onWire))) as { identity?: SeatIdentity } | null
  check('the seat decodes it back as identity.accountEmail', decoded?.identity?.accountEmail === PROFILE_EMAIL, JSON.stringify(decoded?.identity))

  const DAEMON_DIR = join(HOME, 'daemon')
  mkdirSync(DAEMON_DIR, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
  const seat = await import(join(ROOT, 'src/daemon/session-seat/sessionSeat.ts'))
  const workers = await import(join(ROOT, 'src/daemon/concourse-workers/concourseWorkers.ts'))
  const projections = await import(join(ROOT, 'src/engine/connector/seatProjections.ts'))
  const { DaemonSessionConnector } = await import(join(ROOT, 'src/engine/connector/daemonConnector.ts'))
  const { NoSessionConnector } = await import(join(ROOT, 'src/engine/connector/noSessionConnector.ts'))
  const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-seatemail001'
  const SHORT = 'concourse-se1'
  workers.updateConcourseWorkers(workers => {
    workers[SHORT] = {
      schema: 1,
      runnerId: SHORT,
      sessionId: SESSION,
      workspaceId: HOME,
      isolation: 'exclusive',
      modelKey: MODEL,
      effort: 'high',
      spawnedAt: NOW,
      lastLiveAt: NOW,
      settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: SESSION, profileRevision: 0, profileDigest: 'd', resolvedAt: NOW, rows: [] },
      workspaceKind: 'plain-folder',
    } as never
  }, DAEMON_DIR)
  const roster = { door: () => undefined, list: () => [{ short: SHORT, turnActive: false }], patchSeatModel: () => true, patchSeatEffort: () => true }
  const published = (): SeatIdentity | undefined => projections.readSessionFacts(SESSION, DAEMON_DIR)?.identity
  const settled = async (expect: (who: SeatIdentity | undefined) => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (expect(published())) return true
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    return expect(published())
  }
  seat.publishSeatFacts(SHORT, DAEMON_DIR, roster as never)
  check('before the runner\'s first answer the seat publishes no account email (the skeleton), never the record', await settled(who => who !== undefined && who.accountEmail === null), JSON.stringify(published()))
  const runnerAnswers = (who: SeatIdentity | string): void => {
    seat.onFactsAnswer(SHORT, seatWire.sessionFactsToWire(answerWith(who) as never), roster as never, DAEMON_DIR)
  }
  runnerAnswers(identity)
  check('the daemon\'s seat publishes the runner\'s identity verbatim: the credential\'s own email on the facts file', await settled(who => who?.accountEmail === PROFILE_EMAIL), JSON.stringify(published()))
  const record = { sessionId: SESSION, runnerId: SHORT, title: 'seat', projectLabel: 'scratch', workspaceId: HOME, home: HOME }
  const hosted = new DaemonSessionConnector(record)
  check('the cockpit\'s hosted connector reads the published identity: the credential\'s own email', hosted.identity().accountEmail === PROFILE_EMAIL && hosted.identity().claudeAiBilling === true, JSON.stringify(hosted.identity()))
  check('a hosted connector with no facts on disk names nobody', new DaemonSessionConnector({ ...record, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-seatemail000' }).identity().accountEmail === null)
  check('the resting slot names nobody', new NoSessionConnector().identity().accountEmail === null)
  runnerAnswers(RECEIPT_EMAIL)
  check('a fresh answer replaces the published address; the connector built on it reads the new one', (await settled(who => who?.accountEmail === RECEIPT_EMAIL)) && new DaemonSessionConnector(record).identity().accountEmail === RECEIPT_EMAIL, JSON.stringify(published()))
  settleFixture({ record: RECORD_EMAIL })
  const unstored = await identityOf()
  readerSays.push(JSON.stringify(unstored) === JSON.stringify(ownIdentity()))
  check('a credential with no stored email puts null on the facts, never the record', typeof unstored !== 'string' && unstored.accountEmail === null, JSON.stringify(unstored))
  settleFixture({ envKey: true })
  const keyed = await identityOf()
  readerSays.push(JSON.stringify(keyed) === JSON.stringify(ownIdentity()))
  check('a key-based sign-in puts null on the facts (unchanged)', typeof keyed !== 'string' && keyed.accountEmail === null, JSON.stringify(keyed))
  settleFixture({ profile: PROFILE_EMAIL, receipt: PROFILE_EMAIL, record: RECORD_EMAIL })
  check('the runner composes accountEmail through the one sign-in email reader, never the config record', readerSays.length === 3 && readerSays.every(Boolean), JSON.stringify({ readerSays, identity, unstored, keyed }))
  const answered = { asPublished: new DaemonSessionConnector(record).identity(), withNoFacts: new DaemonSessionConnector({ ...record, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-seatemail000' }).identity() }
  check('the connector answers the facts\' identity as published, null when none', published() !== undefined && JSON.stringify(answered.asPublished) === JSON.stringify(published()) && JSON.stringify(answered.withNoFacts) === JSON.stringify({ firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }), `identity() of the hosted connector answers ${JSON.stringify(answered)} over published ${JSON.stringify(published())}: it returns the facts' identity whole, and with no facts read the four fields false, false, false, null`)
  check('getAccountInformation().email in this home is the credential\'s own (the same sign-in the facts answer reads)', auth.getAccountInformation()?.email === PROFILE_EMAIL, JSON.stringify(auth.getAccountInformation()))
  delete process.env.MERCURY_DAEMON_DIR
}

if (framesDir) {
  writeFileSync(join(framesDir, 'index.txt'), [
    'profile-*: the credential stores profile owner@example.com beside the token; the config record says ring@example.com',
    'long-*: the credential stores a-very-long-fixture-account-name@subdomain.example.com',
    'no-email-*: the credential stores neither a profile nor a receipt; the config record says ring@example.com',
    'key-*: ANTHROPIC_API_KEY alone, no Claude sign-in',
    'logins: the face Logins roster (BootLoginsScreen) · face: the boot face with its strip (BootSplashScreen)',
    'usage-popup: the /usage popup body at the store geometry · usage-card: the cockpit vitals rail (HelmVitalsRail)',
    'accounts: the /accounts board (AccountView) with its live probe held in flight, except where the leg names the probe\'s answer',
    'accounts-agree-*: the config record agrees with the credential (owner@example.com on both)',
    'accounts-expired-*: the probe refused the credential (401) and fell back to the record · accounts-offline-*: the probe could not reach the endpoint and fell back to the record',
    `fixture usage endpoint: ${JSON.stringify(utilization)}`,
  ].join('\n') + '\n')
}
server.stop(true)
globalThis.fetch = originalFetch
Date.now = originalNow
Date.prototype.toLocaleString = originalLocale
rmSync(HOME, { recursive: true, force: true })
console.log(`\nemail surfaces: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
