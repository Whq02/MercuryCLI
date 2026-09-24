#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement } from '../../src/ink/dom.js'
import type { UsageWindowView } from '../../src/services/providers/providerUsage.ts'

const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }
const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-read-renews-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_MOCK_USAGE_PAYLOAD', 'MERCURY_USAGE_POLL_MS', 'MERCURY_OAUTH_CLIENT_ID', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}

const HOUR = 3_600_000
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

type GrantMode = 'grant' | 'refuse' | 'down'
const fixture = {
  mode: 'grant' as GrantMode,
  issued: 0,
  grants: [] as Array<{ grantType?: string; refreshToken?: string; mode: GrantMode }>,
  usage: [] as Array<{ bearer: string }>,
}
const hoursOn = (h: number): string => new Date(Date.now() + h * HOUR).toISOString()
const payload = (): Record<string, unknown> => ({
  five_hour: { utilization: 12, resets_at: hoursOn(4) },
  seven_day: { utilization: 38, resets_at: hoursOn(5 * 24) },
  seven_day_fable: { utilization: 21, resets_at: hoursOn(5 * 24) },
})
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/v1/oauth/token')) {
      let body: { grant_type?: string; refresh_token?: string } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        body = {}
      }
      fixture.grants.push({ grantType: body.grant_type, refreshToken: body.refresh_token, mode: fixture.mode })
      if (fixture.mode === 'refuse') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'fixture: the grant is dead' }))
        return
      }
      if (fixture.mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'server_error' }))
        return
      }
      fixture.issued += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        access_token: `fixture-access-renewed-${fixture.issued}`,
        refresh_token: `fixture-refresh-renewed-${fixture.issued}`,
        expires_in: 3600,
        scope: 'user:inference user:profile',
        token_type: 'Bearer',
      }))
      return
    }
    if (url.startsWith('/api/oauth/usage')) {
      fixture.usage.push({ bearer: String(req.headers.authorization ?? '') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload()))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`
process.env.MERCURY_CUSTOM_OAUTH_URL = base
process.env.ANTHROPIC_BASE_URL = base

const credentialsPath = join(scratch, '.credentials.json')
const seedSignIn = (expiresAt: number, refreshToken: string): void => {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-expired',
        refreshToken,
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
}
const stored = (): { accessToken?: string; refreshToken?: string; expiresAt?: number } =>
  (JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth: { accessToken?: string; refreshToken?: string; expiresAt?: number } }).claudeAiOauth
seedSignIn(Date.now() - 8 * HOUR, 'fixture-refresh-night')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
async function stub(path: string, fixtureExports: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixtureExports() }))
}
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))

const reader = await import('../../src/services/providers/anthropic/anthropicUsageState.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const auth = await import('../../src/utils/auth.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const { isOAuthTokenExpired } = await import('../../src/services/oauth/client.ts')
const { formatCountdown, formatCountdownCoarse } = await import('../../src/utils/cockpit/quota.ts')

let NOW = 1_790_000_000_000
const clock = (): number => NOW
const ttl = fresh.usagePollTtlMs()
const resetWorld = (): void => {
  auth.dropCredentialMemos()
  auth.__resetKnownDeadRefreshTokensForTest()
  auth.__resetUnsavedRefreshForTest()
  reader._resetAnthropicUsageReaderForTesting()
  limits.resetLimitsForCredentialSwitch()
}
const tokenExpired = (): boolean => {
  const tokens = auth.getClaudeAIOAuthTokens()
  return tokens !== null && isOAuthTokenExpired(tokens.expiresAt ?? null)
}
const pct = (key: string): number => Math.round([...owner.anthropicWindowViews(), ...owner.anthropicPoolWindowViews()].find(w => w.key === key)?.usedPct ?? -1)

console.log('the usage read renews an expired sign-in itself through the one refresh road, so an idle session paints live numbers')

section('§1 the idle night: the read refreshes the expired token through the refresh grant, then reads the live figures')
{
  resetWorld()
  check('the world: a subscriber whose sign-in token expired eight hours ago, with a refresh token to spend', auth.isClaudeAISubscriber() && tokenExpired() && !auth.isAnthropicOAuthSignInExpired(), JSON.stringify({ subscriber: auth.isClaudeAISubscriber(), expired: tokenExpired() }))
  const status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  const note = reader.anthropicUsageReaderNote(NOW)
  check('exactly ONE refresh grant reached the loopback token endpoint, spending the stored refresh token', fixture.grants.length === 1 && fixture.grants[0]?.grantType === 'refresh_token' && fixture.grants[0]?.refreshToken === 'fixture-refresh-night', `grants=${JSON.stringify(fixture.grants)} · note=${note ?? 'none'}`)
  check('the usage endpoint was then asked once, with the RENEWED bearer', fixture.usage.length === 1 && fixture.usage[0]?.bearer === 'Bearer fixture-access-renewed-1', `usage=${JSON.stringify(fixture.usage)} · note=${note ?? 'none'}`)
  check('the read answered: no failure note stands, one request counted', status.failure === undefined && note === undefined && status.requests === 1, `failure=${JSON.stringify(status.failure)} · note=${note ?? 'none'}`)
  check("the figures painted are the fixture's live ones: 5h 12% · 7d 38% · Fable 21%", pct('5h') === 12 && pct('7d') === 38 && pct('seven_day_fable') === 21, JSON.stringify({ five: pct('5h'), seven: pct('7d'), fable: pct('seven_day_fable') }))
  const view = owner.usageForProvider('anthropic')
  const tail = view.windows[0] !== undefined ? fresh.usageAgeTail(view.windows[0], Date.now()) : undefined
  check("the card's rows are live with a fresh age tail ('↻0s'), no reader note beside them", view.windows.length === 2 && view.windows.every(w => w.state === 'live') && /^↻\d+s$/.test(tail ?? '') && view.readerNote === undefined, JSON.stringify({ tail, note: view.readerNote, windows: view.windows.map(w => w.state) }))
  const pair = stored()
  check('the renewed pair landed on disk for every other road (the reply road finds it fresh)', pair.accessToken === 'fixture-access-renewed-1' && pair.refreshToken === 'fixture-refresh-renewed-1' && typeof pair.expiresAt === 'number' && !isOAuthTokenExpired(pair.expiresAt), JSON.stringify(pair))
  check("nothing on any surface says 'the next reply refreshes it' any more", !(note ?? '').includes('the next reply refreshes it') && owner.usageSummaryWords(view, NOW).includes('12%'), owner.usageSummaryWords(view, NOW))
}

section('§2 one refresh per read: a re-show inside the floor asks nothing; a fresh token reads without a grant')
{
  NOW += ttl / 2
  let status = await reader.refreshAnthropicUsage({ reason: 'open', now: clock })
  check('a meter re-shown inside the floor asks nothing — no grant, no read', fixture.grants.length === 1 && fixture.usage.length === 1 && status.requests === 1, JSON.stringify({ grants: fixture.grants.length, usage: fixture.usage.length, requests: status.requests }))
  status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  check("the operator's retry with a fresh token reads the endpoint and spends no grant", fixture.grants.length === 1 && fixture.usage.length === 2 && status.requests === 2 && status.failure === undefined, JSON.stringify({ grants: fixture.grants.length, usage: fixture.usage.length, requests: status.requests }))
}

section('§3 a refused grant (invalid_grant): one honest line, the dead sign-in is recorded, and no read spends a second grant')
{
  seedSignIn(Date.now() - 8 * HOUR, 'fixture-refresh-dead')
  resetWorld()
  fixture.mode = 'refuse'
  let status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  let note = reader.anthropicUsageReaderNote(NOW)
  check('one grant was asked with the dead refresh token and refused; the usage endpoint was not asked', fixture.grants.length === 2 && fixture.grants[1]?.refreshToken === 'fixture-refresh-dead' && fixture.usage.length === 2, JSON.stringify({ grants: fixture.grants, usage: fixture.usage.length }))
  check("the honest line: the sign-in has expired, the grant was refused, /logins signs in again — no retry promise", status.failure?.kind === 'token' && status.failure.refresh === 'refused' && note === 'usage endpoint not asked — the sign-in has expired and the refresh grant was refused (/logins anthropic signs in again)', note ?? JSON.stringify(status.failure))
  check('the dead grant is blanked on disk and the estate now observes the sign-in as expired', stored().refreshToken === '' && auth.isAnthropicOAuthSignInExpired(), JSON.stringify(stored()))
  const view = owner.usageForProvider('anthropic')
  check("the owner's view carries the note in prose and the rail's compact spelling", view.readerNote === note && view.readerNoteCompact === 'read failed · expired', JSON.stringify({ note: view.readerNote, compact: view.readerNoteCompact }))
  status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  note = reader.anthropicUsageReaderNote(NOW)
  check('a second ask spends NO grant on a dead sign-in — one refresh per read, never a loop', fixture.grants.length === 2 && fixture.usage.length === 2 && status.failure?.refresh === 'refused' && note !== undefined && !note.includes('retry'), `grants=${fixture.grants.length} · note=${note ?? 'none'}`)
  const record = reader.readUsageReaderRecord()
  check("the doctor's record names the refused grant", record?.kind === 'token' && (record.detail ?? '').includes('refused') && (reader.usageReaderRecordWords() ?? '').includes('refused'), JSON.stringify(record))
  fixture.mode = 'grant'
}

section('§4 a grant the token endpoint did not answer: the line says so with the retry, the sign-in is not declared dead, and the next read tries once more')
{
  seedSignIn(Date.now() - 8 * HOUR, 'fixture-refresh-later')
  resetWorld()
  fixture.mode = 'down'
  let status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  let note = reader.anthropicUsageReaderNote(NOW)
  check('one grant was asked; the token endpoint answered 500; the usage endpoint was not asked', fixture.grants.length === 3 && fixture.grants[2]?.mode === 'down' && fixture.usage.length === 2, JSON.stringify({ grants: fixture.grants.length, usage: fixture.usage.length }))
  check("the line says the grant did not answer, and when the next try comes", status.failure?.kind === 'token' && status.failure.refresh === 'unanswered' && note === 'usage endpoint not asked — the sign-in token is expired and the refresh grant did not answer · retry in 4 min', note ?? JSON.stringify(status.failure))
  check('the refresh token is NOT blanked — a grant that did not answer is not a dead sign-in', stored().refreshToken === 'fixture-refresh-later' && !auth.isAnthropicOAuthSignInExpired(), JSON.stringify(stored()))
  NOW += ttl
  status = await reader.refreshAnthropicUsage({ reason: 'open', now: clock })
  check('a meter shown inside the backoff asks nothing — no grant, no read', fixture.grants.length === 3 && fixture.usage.length === 2, JSON.stringify({ grants: fixture.grants.length, usage: fixture.usage.length }))
  fixture.mode = 'grant'
  status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  note = reader.anthropicUsageReaderNote(NOW)
  check("the operator's retry makes ONE more grant and the read lands with the renewed bearer — the note clears", fixture.grants.length === 4 && fixture.usage.length === 3 && fixture.usage[2]?.bearer === 'Bearer fixture-access-renewed-2' && status.failure === undefined && note === undefined, JSON.stringify({ grants: fixture.grants.length, usage: fixture.usage, note }))
  check("the doctor's record shows the episode recovered", reader.readUsageReaderRecord()?.recoveredAtMs !== undefined, JSON.stringify(reader.readUsageReaderRecord()))
}

section('§5 the reader owns the renewal on its one road (source)')
{
  const src = readFileSync(join(ROOT, 'src/services/providers/anthropic/anthropicUsageState.ts'), 'utf8')
  check('the read renews through checkAndRefreshOAuthTokenIfNeeded — the reply road\'s one refresh — before it asks', src.includes('const renewal = await renewExpiredSignIn()') && src.includes('renewed = await checkAndRefreshOAuthTokenIfNeeded()') && src.indexOf('const renewal = await renewExpiredSignIn()') < src.indexOf('const answer = await fetchUtilization()'))
  check('no second refresh implementation: the reader never posts a grant itself', !src.includes('grant_type') && !src.includes('refresh_token') && !src.includes('TOKEN_URL'))
  const wire = readFileSync(join(ROOT, 'src/services/api/usage.ts'), 'utf8')
  check('the wire call still refuses to ask with an expired token (the seam the reader answers before it)', wire.includes('if (tokens && isOAuthTokenExpired(tokens.expiresAt ?? null)) return null'))
}

const frameDir = arg('--frames')
if (frameDir !== undefined) {
  section('§6 frames: the popup and the card after an idle refresh (178x51)')
  mkdirSync(frameDir, { recursive: true })
  seedSignIn(Date.now() - 8 * HOUR, 'fixture-refresh-dawn')
  resetWorld()
  fixture.mode = 'grant'
  const grantsBefore = fixture.grants.length
  const { Usage } = await import('../../src/components/Settings/Usage.js')
  const { Box, Text, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
  const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
  const { UsageMeter } = await import('../../src/components/mercury-ui/components.js')
  const { railPanelInnerWidth } = await import('../../src/components/mercury-ui/RailPanel.js')
  const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      flushPendingSyncWork()
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  async function mount(node: React.ReactElement, columns: number) {
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: 51 }) as unknown as NodeJS.WriteStream
    const root = React.createRef<DOMElement>()
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const tree = React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, node))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => { painted = resolve })
    const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      settle,
      close() { instance.unmount(); instance.cleanup(); stream.destroy() },
    }
  }
  const popup = await mount(React.createElement(Usage, { width: 146, rowBudget: 22, openToken: 7 } as never), 178)
  for (let round = 0; round < 200 && popup.frame().includes('loading usage…'); round++) await popup.settle()
  const frame = popup.frame()
  check('the popup opened on the expired token, renewed it through one grant and painted the live figures', fixture.grants.length === grantsBefore + 1 && frame.includes('Current session · 12%') && frame.includes('Current week (all models) · 38%') && frame.includes('Current week (Fable) · 21%') && frame.includes('endpoint-fed · read') && !frame.includes('not asked'), frame)
  writeFileSync(join(frameDir, 'anthropic-idle-refresh-popup-178x51.txt'), frame + '\n')
  popup.close()
  const view = owner.usageForProvider('anthropic')
  const now = Date.now()
  const meterTail = (w: UsageWindowView, pool: boolean): string | undefined => {
    const age = fresh.usageAgeTail(w, now)
    if (age !== undefined && owner.usageViewIsStale(w, now)) return age
    const reset = w.resetsAtMs == null ? undefined : pool ? formatCountdownCoarse(w.resetsAtMs - now) : formatCountdown(w.resetsAtMs - now)
    const tail = [reset, age].filter((part): part is string => part !== undefined).join(' ')
    return tail === '' ? undefined : tail
  }
  const rowW = railPanelInnerWidth(railPlanAt(178, true).telemetryW)
  const rows = [...view.windows.filter(w => w.state === 'live').map(w => ({ w, pool: false })), ...view.pools.filter(w => w.state === 'live').map(w => ({ w, pool: true }))]
  const cardNode = React.createElement(
    Box,
    { flexDirection: 'column', width: rowW },
    React.createElement(Box, { key: 'label', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${view.label}`)),
    ...rows.map(({ w, pool }) =>
      React.createElement(
        Box,
        { key: w.key, width: rowW },
        React.createElement(Text, { wrap: 'truncate-end' }, '  ', React.createElement(UsageMeter, { compact: true, window: w.label, state: 'live', value: w.usedPct ?? undefined, resetIn: meterTail(w, pool) })),
      ),
    ),
    ...(view.readerNoteCompact !== undefined ? [React.createElement(Box, { key: 'reader', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${view.readerNoteCompact}`))] : []),
  )
  const card = await mount(cardNode, 178)
  const cardFrame = card.frame()
  card.close()
  check("the card's USAGE rows after the refresh: 5h 12% · 7d 38% · Fable 21%, each with its fresh age, no reader note", /5h .*12%/.test(cardFrame) && /7d .*38%/.test(cardFrame) && /Fable .*21%/.test(cardFrame) && /↻\d+s/.test(cardFrame) && !cardFrame.includes('read failed') && !cardFrame.includes('no usage read'), cardFrame)
  writeFileSync(join(frameDir, 'anthropic-idle-refresh-card-178x51.txt'), `${cardFrame}\n`)
  console.log(`  frames written under ${frameDir}`)
}

server.closeAllConnections?.()
server.close()
console.log(`\nusage read renews the sign-in: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
