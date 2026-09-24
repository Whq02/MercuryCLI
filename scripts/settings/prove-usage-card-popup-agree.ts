#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement } from '../../src/ink/dom.js'
import type { UsageWindowView } from '../../src/services/providers/providerUsage.ts'

const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }
const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-card-popup-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_USAGE_POLL_MS', 'MERCURY_MODEL', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/oauth'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'https://fixture.invalid/backend-api/codex'
process.env.MERCURY_OPENAI_API_BASE = 'https://fixture.invalid/v1'

const MIN = 60_000
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
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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

const { noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.ts')
const openaiLimits = await import('../../src/services/providers/openai/openaiLimitState.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const { formatCountdown, formatCountdownCoarse } = await import('../../src/utils/cockpit/quota.ts')
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
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

console.log('the usage card and the /usage popup tell one truth about OpenAI usage after an idle hour')

section('§1 the world: a ChatGPT subscription, one header read 55 minutes ago (a window that reset since, a week at 52%), this session 0 tokens')
writeFileSync(
  join(scratch, '.openai-auth.json'),
  JSON.stringify({ version: 1, tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' } }),
)
noteCredentialChange()
openaiLimits.__resetOpenaiLimitStateForTest()
const now = Date.now()
const observedAt = now - 55 * MIN
openaiLimits.recordOpenaiRateHeaders(
  new Headers({
    'x-codex-primary-used-percent': '0',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': String(20 * 60),
    'x-codex-secondary-used-percent': '52',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-after-seconds': String(5 * 24 * 3600),
  }),
  () => observedAt,
)
const model = 'gpt-5.6-sol'
const { primary } = owner.windowSourceUsages({ model, reads: {} })
check('the owner names the ChatGPT subscription as the focused source with 0 session tokens', primary.provider === 'openai' && primary.sourceKind === 'subscription-oauth' && primary.shape === 'subscription-windows' && primary.spend.models === 0, JSON.stringify({ provider: primary.provider, kind: primary.sourceKind, shape: primary.shape, spend: primary.spend }))
const views = owner.openaiObservedWindowViews()
check('the one derivation states two bands, both older than the header horizon (stale by the one test)', views.length === 2 && views.every(w => owner.usageViewIsStale(w, now)), JSON.stringify(views))

section('§2 the card (the rail\'s USAGE rows) and the popup (the /usage OpenAI section) from that one record')
const meterTail = (w: UsageWindowView, pool: boolean): string | undefined => {
  const age = fresh.usageAgeTail(w, now)
  if (age !== undefined && owner.usageViewIsStale(w, now)) return age
  const reset = w.resetsAtMs == null ? undefined : pool ? formatCountdownCoarse(w.resetsAtMs - now) : formatCountdown(w.resetsAtMs - now)
  const tail = [reset, age].filter((part): part is string => part !== undefined).join(' ')
  return tail === '' ? undefined : tail
}
const liveWindows = primary.windows.filter(w => w.state === 'live')
const cardEmpty = primary.shape !== 'api-spend' && liveWindows.length === 0
const cardRows = cardEmpty
  ? [`${fresh.NO_USAGE_READ_WORDS} · fills after first reply`]
  : liveWindows.map(w => `${w.label} ${Math.round(w.usedPct ?? -1)}% ${meterTail(w, false) ?? ''}`)
const popupMeters = views.map(w => ({
  title: `${w.label === 'wk' ? 'Current week' : `Window (${w.label})`} · ${Math.floor(w.usedPct ?? -1)}%`,
  words: fresh.usageSourceWords(w, now) ?? '',
}))
const popup = await mount(React.createElement(Usage, { width: 146, rowBudget: 22, openToken: 11 } as never), 178)
const popupFrame = popup.frame()
popup.close()
check('the popup paints both bands with the one source + age vocabulary', popupMeters.length === 2 && popupMeters.every(m => popupFrame.includes(m.title) && popupFrame.includes(m.words)) && !popupFrame.includes('no usage signal observed'), `popup=${JSON.stringify(popupMeters)}\n${popupFrame}`)
check("the popup's words: 'header-fed · stale · last read 55 min ago' under 'Window (5h) · 0%' and 'Current week · 52%'", popupMeters.map(m => m.title).join(' | ') === 'Window (5h) · 0% | Current week · 52%' && popupMeters.every(m => m.words === 'header-fed · stale · last read 55 min ago'), JSON.stringify(popupMeters))
check("the card never says 'no usage read' while the popup paints a read — the two strings the operator saw", !cardEmpty && cardRows.length === popupMeters.length, `card=${JSON.stringify(cardRows)} · popup=${JSON.stringify(popupMeters)}`)
check("both say STALE with the same age: the card 'stale ↻55m' per row, the popup 'stale · last read 55 min ago' per meter", cardRows.every(row => row.endsWith('stale ↻55m')) && popupMeters.every(m => m.words.endsWith('stale · last read 55 min ago')), JSON.stringify(cardRows))
check('the card names the same windows at the same percents as the popup (5h 0% · wk 52%)', cardRows.map(row => row.split(' ').slice(0, 2).join(' ')).join(' | ') === '5h 0% | wk 52%', JSON.stringify(cardRows))
check('a session that spent nothing changes neither surface: the spend line is its own fact', popupFrame.includes('This session: 0 tokens.') && primary.spend.models === 0)

section('§3 the laws this pin transcribes stand in the source (the rail, the popup, the composer)')
{
  const rail = src('src/components/HelmTelemetryRail.tsx')
  check("the rail paints the focused source's LIVE rows, with the one meter tail, and the no-read hint only when none is live", rail.includes("const liveWindows = usage.windows.filter(w => w.state === 'live')") && rail.includes("const usageEmpty = usage.shape !== 'api-spend' && liveWindows.length === 0") && rail.includes('text={`${NO_USAGE_READ_WORDS} · fills after first reply`}') && rail.includes('resetIn={meterTail(w, pool)}') && rail.includes('const age = usageAgeTail(w, readNow)'))
  const tab = src('src/components/Settings/Usage.tsx')
  check('the popup paints every band the one derivation states, captioned by usageSourceWords', tab.includes('const windows = openaiObservedWindowViews()') && tab.includes('const observed = usageSourceWords(w)'))
  const composer = src('src/services/providers/providerUsage.ts')
  check("the composer's state means 'stated', never 'aged' — the age is the freshness vocabulary's to say (the Anthropic law, quota.ts)", !composer.includes("usageFreshness({ ...stamp, freshForMs }).state === 'stale' ? 'unavailable'") && composer.includes("state: 'live' as const,\n      usedPct: band.usedPct!,"))
  const quota = src('src/utils/cockpit/quota.ts')
  check('…as the first-party pair does: a stated window is live, an absent one unavailable', quota.includes("return { key, usedPct: null, resetsAtMs: null, state: 'unavailable' }") && quota.includes("state: 'live',"))
}

section('§4 a band the source never stated stays absent on both surfaces (never a fabricated 0%)')
{
  openaiLimits.__resetOpenaiLimitStateForTest()
  const empty = owner.windowSourceUsages({ model, reads: {} }).primary
  const emptyViews = owner.openaiObservedWindowViews()
  check('no observation: the card says no usage read (fills after the first reply) and the popup paints its labelled absence', empty.windows.length === 0 && emptyViews.length === 0)
  openaiLimits.recordOpenaiRateHeaders(
    new Headers({
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': String(20 * 60),
      'x-codex-secondary-used-percent': '52',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': String(5 * 24 * 3600),
    }),
    () => observedAt,
  )
}

const frameDir = arg('--frames')
if (frameDir !== undefined) {
  section('§5 frames: the popup and the card on the fresh window (178x51)')
  mkdirSync(frameDir, { recursive: true })
  const again = await mount(React.createElement(Usage, { width: 146, rowBudget: 22, openToken: 12 } as never), 178)
  const frame = again.frame()
  again.close()
  writeFileSync(join(frameDir, 'openai-fresh-window-popup-178x51.txt'), `${frame}\n`)
  const rowW = railPanelInnerWidth(railPlanAt(178, true).telemetryW)
  const view = owner.windowSourceUsages({ model, reads: {} }).primary
  const rows = view.windows.filter(w => w.state === 'live')
  const cardNode = React.createElement(
    Box,
    { flexDirection: 'column', width: rowW },
    React.createElement(Box, { key: 'label', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${view.label}`)),
    ...(rows.length === 0
      ? [React.createElement(Box, { key: 'none', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${fresh.NO_USAGE_READ_WORDS} · fills after first reply`))]
      : rows.map(w =>
          React.createElement(
            Box,
            { key: w.key, width: rowW },
            React.createElement(Text, { wrap: 'truncate-end' }, '  ', React.createElement(UsageMeter, { compact: true, window: w.label, state: 'live', value: w.usedPct ?? undefined, resetIn: meterTail(w, false) })),
          ),
        )),
  )
  const card = await mount(cardNode, 178)
  const cardFrame = card.frame()
  card.close()
  check("the card's USAGE rows: 5h 0% and wk 52%, each 'stale ↻55m', never the no-read hint", /5h .*0% stale ↻55m/.test(cardFrame) && /wk .*52% stale ↻55m/.test(cardFrame) && !cardFrame.includes('no usage read'), cardFrame)
  writeFileSync(join(frameDir, 'openai-fresh-window-card-178x51.txt'), `${cardFrame}\n`)
  console.log(`  frames written under ${frameDir}`)
}

console.log(`\nusage card/popup agreement: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
