#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

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
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/services/providers/providerUsage.js')
const usage = await import('../../src/components/Settings/Usage.js')
const { call: usageCall } = await import('../../src/commands/usage/usage.js')

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

section('§1 the row\'s words and the body\'s rows')
{
  const rows = usage.usageBodyRows(22)
  check('a 22-row body keeps one footer row and one JEV row, twenty for the providers', rows.footerRows === 1 && rows.jevRows === 1 && rows.capacity === 20, JSON.stringify(rows))
  check('a two-row body keeps the footer and drops the JEV row; a one-row body keeps neither', JSON.stringify(usage.usageBodyRows(2)) === JSON.stringify({ footerRows: 1, jevRows: 0, capacity: 1 }) && JSON.stringify(usage.usageBodyRows(1)) === JSON.stringify({ footerRows: 0, jevRows: 0, capacity: 1 }) && usage.usageBodyRows(0).capacity === 0)
  const off = usage.jevUsageRow()
  check('off, keyless, nothing spent: the row is Mercury\'s count at zero, the allowance, the off headword and the unreported credits', off === `JEV · Mercury's count: $0.00 · 0 calls (0 unconfirmed) · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}`, off)
  check('the credits words are the provider-usage owner\'s spelling', CREDITS_UNREPORTED_WORDS === 'not reported by the provider' && off.endsWith(CREDITS_UNREPORTED_WORDS))
  check('the headword is the status resolver\'s', off.includes(` · ${status.JEV_STATUS_HEADWORDS[status.jevStatus().kind]} · `))
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
  check('on, keyed, spent: the row carries the ledger\'s count, the calls with the unconfirmed one, the allowance and ready', expected === `JEV · Mercury's count: ${contract.jevUsdLabel(ledger.jevLedgerSnapshot().spendUsd)} · 2 calls (1 unconfirmed) · allowance $20.00 · ready · credits: ${CREDITS_UNREPORTED_WORDS}`, expected)
  const m = await openUsage()
  const lines = keepFrame('usage-jev-row-178x51', 'the /usage popup (150x29) at 178x51 on the absent-provider fixture with JEV on, a key stored and spend on the ledger: the JEV row above the more row', m)
  const jev = jevLineOf(lines)
  check('the JEV row is painted verbatim', jev.text === expected, jev.text)
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
  check('the body paints the row from the one reader and takes its rows from usageBodyRows', src.includes('{jevUsageRow()}') && src.includes('usageBodyRows(budget)') && src.includes('CREDITS_UNREPORTED_WORDS'))
  check('the row reads the owner modules, never a copy of a setting or a spend', src.includes("from '../../services/jev/jevLedger.js'") && src.includes("from '../../services/jev/jevSetting.js'") && src.includes("from '../../services/jev/jevStatus.js'") && !src.includes('typesafeApiKey') && !src.includes('resolveJevApiKey'))
  const pin = readFileSync(join(REPO, 'scripts/settings/prove-usage-popup.ts'), 'utf8')
  check('the usage popup pin reads the body rows from the owner and keeps its words baseline clear of the JEV row', pin.includes('usageBodyRows(budget).capacity') && pin.includes('!run.startsWith(JEV_USAGE_LABEL)'))
}

if (frameDir !== undefined) {
  const index = frames.map(frame => `${frame.name}.txt | ${frame.note}`)
  writeFileSync(join(frameDir, 'usage-index.txt'), index.join('\n') + '\n')
  console.log(`\nframes: ${frames.length} written to ${frameDir}`)
}
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jev-usage-row: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
