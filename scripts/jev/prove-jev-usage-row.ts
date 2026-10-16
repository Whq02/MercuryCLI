#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
const HOME = pinScratchHome('jev-usage-row')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

const COLS = 178
const ROWS = 51
const PROOF_KEY = 'proof-key-jev-usage-not-a-real-key-0011'
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
const ids = ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface', 'deepseek', 'zai', 'openrouter', 'openai-compat', 'local']
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const families = () => ids.map(id => ({ id, available: false, credentialed: false, credentialLabel: `${id} fixture key` }))
const owner = (id: string) => ({ provider: id, sourceKind: 'none', windows: [], figures: [], absence: undefined })
await stub('../../src/services/providers/providerUsage.js', () => ({
  providerFamilyPresences: families,
  providerSessionSpend: () => spend,
  providerUsageView: () => ({ entries: [], activeEntry: undefined, sessionSpend: spend, limits: { kind: 'none' } }),
  refreshProviderUsage: async () => undefined,
  usageForProvider: owner,
  usageCreditsLine: () => undefined,
  anthropicWindowViews: () => [],
  anthropicPoolWindowViews: () => [],
  openaiObservedWindowViews: () => [],
}))
await stub('../../src/utils/auth.js', () => ({ isClaudeAISubscriber: () => false }))
await stub('../../src/utils/model/computedDefault.js', () => ({ recentSignIns: () => ids.map(family => ({ family })) }))
await stub('../../src/services/wallet/wallet.js', () => ({ walletEntries: () => [], activeWalletEntry: () => undefined }))
await stub('../../src/services/providers/usageFreshness.js', () => ({ usageSourceWords: () => 'endpoint-fed · read 0 s ago' }))
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/cost-tracker.js', () => ({ formatLaneSpend: () => '$0.00' }))

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.js')
const status = await import('../../src/services/jev/jevStatus.js')
const keyOwner = await import('../../src/services/jev/jevKey.js')
const ledger = await import('../../src/services/jev/jevLedger.js')
const contract = await import('../../src/services/jev/jevContract.js')
const reader = await import('../../src/services/jev/jevSessionFacts.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/services/providers/providerUsage.js')
const usage = await import('../../src/components/Settings/Usage.js')
const { call: usageCall } = await import('../../src/commands/usage/usage.js')

const ZERO_USAGE = {
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
}
const runnerConnector = (): InstanceType<typeof NoSessionConnector> =>
  Object.assign(new NoSessionConnector(), {
    sessionId: () => 'proof-session',
    usage: () => ({ ...ZERO_USAGE, jev: reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()) }),
  })

const frames: Array<{ name: string; note: string; lines: string[] }> = []
function keepFrame(name: string, note: string, m: Mounted): string[] {
  const lines = m.lines()
  frames.push({ name, note, lines })
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), lines.join('\n') + '\n')
  return lines
}
const BORDERS = /[│╭╮╰╯─]/g
const inner = (line: string): string => line.replace(BORDERS, ' ').trim()
async function openUsage(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  await usageCall('', {} as never)
  await waitFor(() => m.screen().includes('Mercury · usage'), 4000)
  await settle(250)
  return m
}
async function closePopup(m: Mounted): Promise<void> {
  store.closeSettingsPopup()
  m.unmount()
  await settle(60)
}
const jevLineOf = (lines: string[]): { text: string; at: number } => {
  const at = lines.findIndex(line => line.includes(usage.JEV_USAGE_LABEL))
  return { text: at < 0 ? '' : inner(lines[at] ?? ''), at }
}

section('§1 the row\'s words, when it is offered, and the body\'s rows')
{
  const rows = usage.usageBodyRows(22)
  check('a 22-row body keeps one footer row and one Jev row, twenty for the providers', rows.footerRows === 1 && rows.jevRows === 1 && rows.capacity === 20, JSON.stringify(rows))
  check('a body asked for no Jev row keeps the footer and gives the providers the row', JSON.stringify(usage.usageBodyRows(22, 0)) === JSON.stringify({ footerRows: 1, jevRows: 0, capacity: 21 }), JSON.stringify(usage.usageBodyRows(22, 0)))
  check('a two-row body keeps the footer and drops the Jev row; a one-row body keeps neither', JSON.stringify(usage.usageBodyRows(2)) === JSON.stringify({ footerRows: 1, jevRows: 0, capacity: 1 }) && JSON.stringify(usage.usageBodyRows(1)) === JSON.stringify({ footerRows: 0, jevRows: 0, capacity: 1 }) && usage.usageBodyRows(0).capacity === 0)
  check('the label is the plain word, not a shout', usage.JEV_USAGE_LABEL === 'Jev')
  check('no chat open, no key: the row is not offered — no evaluator for this home, nothing counted', !slot.hasFocusedSession() && !usage.jevUsageRowShown())
  const resting = usage.jevUsageRow()
  check('no chat open: the row, were it offered, says what Jev is, names the absence, the allowance, the off headword and the unreported credits — never a count, never "official"', resting === `Jev · second-opinion evaluator · ${reader.JEV_NO_SESSION_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}` && !resting.includes('official'), resting)
  const noRow = await openUsage()
  const bare = keepFrame('usage-no-jev-row-178x51', 'the /usage popup at 178x51 on the absent-provider fixture in a home with no evaluator key and no chat: no Jev row; the more row closes the body', noRow)
  check('a scratch home with no evaluator key and no chat paints no Jev row', jevLineOf(bare).at < 0 && !bare.join('\n').includes('second-opinion evaluator'), jevLineOf(bare).text)
  check('the body row the Jev line would take goes to the providers: the more row is the last body line', bare.some(line => line.includes('↓ ') && line.includes(' more · ')))
  await closePopup(noRow)
  slot.setFocusedSessionConnector(runnerConnector())
  const off = usage.jevUsageRow()
  check('a chat whose runner reports nothing spent, switch off, no key: the row is still not offered — a zero count is no reason to paint it', slot.hasFocusedSession() && reader.jevSessionFacts().state === 'reported' && !usage.jevUsageRowShown())
  check('a chat whose runner reports nothing spent: the row, were it offered, is the session\'s spend against the allowance, the zero calls, the off headword and the unreported credits', off === `Jev · second-opinion evaluator · $0.00 of a $20.00 allowance · 0 calls (0 unconfirmed) · off · credits: ${CREDITS_UNREPORTED_WORDS}`, off)
  const used = { state: 'reported', facts: { ...reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()), calls: 1, attempts: 1 } } as const
  check('a call recorded this session offers the row even with no key for this home', usage.jevUsageRowShown(used, { present: false }))
  check('an attempt that never answered offers the row too (its charge may be unconfirmed)', usage.jevUsageRowShown({ state: 'reported', facts: { ...used.facts, calls: 0, attempts: 1 } }, { present: false }))
  check('a key for this home offers the row with no chat open', usage.jevUsageRowShown({ state: 'no-session' }, { present: true, source: 'stored' }))
  check('the credits words are the provider-usage owner\'s spelling', CREDITS_UNREPORTED_WORDS === 'not reported by the provider' && off.endsWith(CREDITS_UNREPORTED_WORDS))
  check('the headword is the status resolver\'s, as the runner answered it', off.includes(` · ${status.JEV_STATUS_HEADWORDS[status.jevStatus().kind]} · `))
  check('the row fits the popup\'s 146-cell body', stringWidth(off) <= 146, String(stringWidth(off)))
}

section('§2 /usage at 178x51 with the switch on, a key stored and spend on the ledger (frame)')
{
  setting.setJevEnabled(true)
  keyOwner.storeJevApiKey(PROOF_KEY)
  const T0 = Date.UTC(2026, 0, 15, 14, 30)
  ledger.resetJevLedger()
  ledger.noteJevAttempt(T0)
  ledger.settleJevCall({ input_tokens: 4000, output_tokens: 0 }, 'jev-1.13.0', T0)
  ledger.noteJevAttempt(T0 + 1000)
  ledger.settleJevCall({ input_tokens: 6000, output_tokens: 0 }, 'jev-1.13.0', T0 + 1000)
  ledger.noteJevAttempt(T0 + 2000)
  ledger.noteJevWireFailure({ kind: 'parse-failed', status: 200, detail: 'not json' }, T0 + 2000, () => 0.5)
  const expected = usage.jevUsageRow()
  check('on, keyed, spent: the row is offered — a key for this home and calls on the count', usage.jevUsageRowShown())
  check('on, keyed, spent: the row says what Jev is, the session\'s spend against the allowance as its runner answered it, the calls with the unconfirmed one, and ready — never "official"', expected === `Jev · second-opinion evaluator · ${contract.jevUsdLabel(ledger.jevLedgerSnapshot().spendUsd)} of a $20.00 allowance · 2 calls (1 unconfirmed) · ready · credits: ${CREDITS_UNREPORTED_WORDS}` && !expected.includes('official'), expected)
  check('the reader hands the surfaces the runner\'s row, never a local snapshot', reader.jevSessionFacts().state === 'reported' && JSON.stringify(reader.jevSessionFacts()) === JSON.stringify({ state: 'reported', facts: reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()) }))
  const m = await openUsage()
  const lines = keepFrame('usage-jev-row-178x51', 'the /usage popup (150x29) at 178x51 on the absent-provider fixture with Jev on, a key stored and spend on the ledger: the Jev row above the more row', m)
  const jev = jevLineOf(lines)
  check('the stubbed evaluator credential paints the plain Jev row verbatim', jev.text === expected, jev.text)
  const moreAt = lines.findIndex(line => line.includes('↓ 4 more · Z.AI · OpenRouter · Custom endpoint · Local models'))
  check('the row sits directly above the more row, the six absent providers keeping their names', moreAt > 0 && jev.at === moreAt - 1, `${jev.at} / ${moreAt}`)
  check('the frame fits 178 columns and 51 rows', lines.length <= ROWS && lines.every(line => stringWidth(line) <= COLS))
  check('the key value appears nowhere on the frame; no frame says experimental', !lines.join('\n').includes(PROOF_KEY) && !/experimental/i.test(lines.join('\n')))
  check('the row names no provider balance', !/balance/i.test(jev.text))
  await closePopup(m)
  ledger.resetJevLedger()
  keyOwner.storeJevApiKey(null)
  setting.setJevEnabled(false)
}

section('§3 the source pins')
{
  const src = readFileSync(join(REPO, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the body paints the row from the one reader behind the one gate and takes its rows from usageBodyRows, none when the row is absent', src.includes('const jevLine = jevUsageRowShown() ? jevUsageRow() : undefined') && src.includes('{jevLine}') && src.includes('usageBodyRows(budget, requestedJevRows)') && src.includes('jevLine === undefined ? 0') && src.includes('CREDITS_UNREPORTED_WORDS'))
  check('the compact body paints the row behind the same gate', src.includes('jev: () => (jevUsageRowShown() ? jevUsageRow() : undefined)'))
  check('the row reads the owner modules — the session reader for the count, the key owner for the credential, the settings owner, the headwords — never a copy of a setting, a spend, a key or the cockpit\'s own ledger', src.includes("from '../../services/jev/jevSessionFacts.js'") && src.includes("from '../../services/jev/jevKey.js'") && src.includes("from '../../services/jev/jevSetting.js'") && src.includes("from '../../services/jev/jevStatus.js'") && !src.includes('jevLedger.js') && !src.includes('jevLedgerSnapshot') && !/\bjevStatus\(/.test(src) && !src.includes('typesafeApiKey') && !src.includes('resolveJevApiKey'))
  const pin = readFileSync(join(REPO, 'scripts/settings/prove-usage-popup.ts'), 'utf8')
  check('the usage popup pin reads the body rows from the owner for a home with no evaluator and keeps its words baseline clear of the Jev row', pin.includes('usageBodyRows(budget, 0).capacity') && pin.includes('!run.startsWith(JEV_USAGE_LABEL)'))
}

if (frameDir !== undefined) {
  const index = frames.map(frame => `${frame.name}.txt | ${frame.note}`)
  writeFileSync(join(frameDir, 'usage-index.txt'), index.join('\n') + '\n')
  console.log(`\nframes: ${frames.length} written to ${frameDir}`)
}
slot._resetFocusedSessionConnectorForTesting()
await releaseScratchHome(HOME)
console.log(`\nprove-jev-usage-row: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
