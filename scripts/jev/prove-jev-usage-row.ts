#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

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
const COMPACT_SRC = 'src/screen/settings/usage/compact.tsx'
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
await stub('../../src/models/roads/providerUsage.js', () => ({
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
await stub('../../src/models/sign-in/credentials/auth.js', () => ({ isClaudeAISubscriber: () => false }))
await stub('../../src/models/catalogue/computedDefault.js', () => ({ recentSignIns: () => ids.map(family => ({ family })) }))
await stub('../../src/models/wallet/wallet.js', () => ({ walletEntries: () => [], activeWalletEntry: () => undefined }))
await stub('../../src/models/roads/usageFreshness.js', () => ({ usageSourceWords: () => 'endpoint-fed · read 0 s ago' }))
await stub('../../src/models/roads/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/models/roads/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/models/roads/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/models/roads/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/models/roads/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/models/roads/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/models/roads/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/models/usage/sessionCost.js', () => ({ formatLaneSpend: () => '$0.00' }))

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const setting = await import('../../src/models/jev/jevSetting.js')
const status = await import('../../src/models/jev/jevStatus.js')
const keyOwner = await import('../../src/models/jev/jevKey.js')
const ledger = await import('../../src/models/jev/jevLedger.js')
const contract = await import('../../src/models/jev/jevContract.js')
const reader = await import('../../src/models/jev/jevSessionFacts.js')
const slot = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/models/roads/providerUsage.js')
const usage = await import('../../src/screen/settings/Usage.js')
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
  check('a 22-row body keeps one footer row and one Jev row, twenty for the providers', rows.footerRows === 1 && rows.jevRows === 1 && rows.capacity === 20, 'change usageBodyRows in ' + COMPACT_SRC + ' so a 22-row body keeps footer 1, jev 1, capacity 20; got ' + JSON.stringify(rows))
  check('a body asked for no Jev row keeps the footer and gives the providers the row', JSON.stringify(usage.usageBodyRows(22, 0)) === JSON.stringify({ footerRows: 1, jevRows: 0, capacity: 21 }), 'usageBodyRows(22, 0) in ' + COMPACT_SRC + ' must give footer 1, jev 0, capacity 21; got ' + JSON.stringify(usage.usageBodyRows(22, 0)))
  check('a two-row body keeps the footer and drops the Jev row; a one-row body keeps neither', JSON.stringify(usage.usageBodyRows(2)) === JSON.stringify({ footerRows: 1, jevRows: 0, capacity: 1 }) && JSON.stringify(usage.usageBodyRows(1)) === JSON.stringify({ footerRows: 0, jevRows: 0, capacity: 1 }) && usage.usageBodyRows(0).capacity === 0, 'usageBodyRows in ' + COMPACT_SRC + ' must give 2 rows: footer 1 / jev 0 / capacity 1, 1 row: footer 0 / jev 0 / capacity 1, 0 rows: capacity 0')
  check('the label is the plain word, not a shout', usage.JEV_USAGE_LABEL === 'Jev', 'set JEV_USAGE_LABEL to the plain word Jev in ' + COMPACT_SRC)
  check('no chat open, no key: the row is not offered — no evaluator for this home, nothing counted', !slot.hasFocusedSession() && !usage.jevUsageRowShown(), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be false with no focused chat and no evaluator key for this home')
  const resting = usage.jevUsageRow()
  check('no chat open: the row, were it offered, says what Jev is, names the absence, the allowance, the off headword and the unreported credits — never a count, never "official"', resting === `Jev · second-opinion evaluator · ${reader.JEV_NO_SESSION_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}` && !resting.includes('official'), 'change jevUsageRow in ' + COMPACT_SRC + ' to say the no-chat words, allowance, off headword and credits words, without a count or the word official; got ' + resting)
  const noRow = await openUsage()
  const bare = keepFrame('usage-no-jev-row-178x51', 'the /usage popup at 178x51 on the absent-provider fixture in a home with no evaluator key and no chat: no Jev row; the more row closes the body', noRow)
  check('a scratch home with no evaluator key and no chat paints no Jev row', jevLineOf(bare).at < 0 && !bare.join('\n').includes('second-opinion evaluator'), 'the /usage body (usageBodyRows / jevUsageRowShown in ' + COMPACT_SRC + ') must paint no Jev row when none is offered; found: ' + jevLineOf(bare).text)
  check('the body row the Jev line would take goes to the providers: the more row is the last body line', bare.some(line => line.includes('↓ ') && line.includes(' more · ')), 'when no Jev row is offered, usageBodyRows in ' + COMPACT_SRC + ' must give its row to the providers so the more row is the last body line')
  await closePopup(noRow)
  slot.setFocusedSessionConnector(runnerConnector())
  const off = usage.jevUsageRow()
  check('a chat whose runner reports nothing spent, switch off, no key: the row is still not offered — a zero count is no reason to paint it', slot.hasFocusedSession() && reader.jevSessionFacts().state === 'reported' && !usage.jevUsageRowShown(), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be false for a reported session with zero calls, zero attempts, switch off and no key')
  check('a chat whose runner reports nothing spent: the row, were it offered, is the session\'s spend against the allowance, the zero calls, the off headword and the unreported credits', off === `Jev · second-opinion evaluator · $0.00 of a $20.00 allowance · 0 calls (0 unconfirmed) · off · credits: ${CREDITS_UNREPORTED_WORDS}`, 'change jevUsageRow in ' + COMPACT_SRC + ' to the spend-against-allowance, zero calls, off and credits wording; got ' + off)
  const used = { state: 'reported', facts: { ...reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()), calls: 1, attempts: 1 } } as const
  check('a call recorded this session offers the row even with no key for this home', usage.jevUsageRowShown(used, { present: false }), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be true when the session facts record a call, key or no key')
  check('an attempt that never answered offers the row too (its charge may be unconfirmed)', usage.jevUsageRowShown({ state: 'reported', facts: { ...used.facts, calls: 0, attempts: 1 } }, { present: false }), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be true when attempts is above zero even with zero calls')
  check('a key for this home offers the row with no chat open', usage.jevUsageRowShown({ state: 'no-session' }, { present: true, source: 'stored' }), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be true when a key is present, even with no chat open')
  check('the credits words are the provider-usage owner\'s spelling', CREDITS_UNREPORTED_WORDS === 'not reported by the provider' && off.endsWith(CREDITS_UNREPORTED_WORDS), 'CREDITS_UNREPORTED_WORDS in src/models/roads/provider-usage/shared.ts must read not reported by the provider, and jevUsageRow in ' + COMPACT_SRC + ' must end with it; got ' + off)
  check('the headword is the status resolver\'s, as the runner answered it', off.includes(` · ${status.JEV_STATUS_HEADWORDS[status.jevStatus().kind]} · `), 'jevUsageRow in ' + COMPACT_SRC + ' must carry the headword from JEV_STATUS_HEADWORDS for the current jevStatus kind; got ' + off)
  check('the row fits the popup\'s 146-cell body', stringWidth(off) <= 146, 'shorten the row jevUsageRow builds in ' + COMPACT_SRC + ' to fit 146 cells; width ' + String(stringWidth(off)))
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
  check('on, keyed, spent: the row is offered — a key for this home and calls on the count', usage.jevUsageRowShown(), 'jevUsageRowShown in ' + COMPACT_SRC + ' must be true with the switch on, a stored key and calls on the ledger')
  check('on, keyed, spent: the row says what Jev is, the session\'s spend against the allowance as its runner answered it, the calls with the unconfirmed one, and ready — never "official"', expected === `Jev · second-opinion evaluator · ${contract.jevUsdLabel(ledger.jevLedgerSnapshot().spendUsd)} of a $20.00 allowance · 2 calls (1 unconfirmed) · ready · credits: ${CREDITS_UNREPORTED_WORDS}` && !expected.includes('official'), 'change jevUsageRow in ' + COMPACT_SRC + ' to the spend, 2 calls (1 unconfirmed), ready and credits wording, without the word official; got ' + expected)
  check('the reader hands the surfaces the runner\'s row, never a local snapshot', reader.jevSessionFacts().state === 'reported' && JSON.stringify(reader.jevSessionFacts()) === JSON.stringify({ state: 'reported', facts: reader.jevFactsOf(ledger.jevLedgerSnapshot(), status.jevStatus()) }), 'jevSessionFacts in src/models/jev/jevSessionFacts.ts must return the reported state with the facts jevFactsOf builds from the runner, not a local snapshot')
  const m = await openUsage()
  const lines = keepFrame('usage-jev-row-178x51', 'the /usage popup (150x29) at 178x51 on the absent-provider fixture with Jev on, a key stored and spend on the ledger: the Jev row above the more row', m)
  const jev = jevLineOf(lines)
  check('the stubbed evaluator credential paints the plain Jev row verbatim', jev.text === expected, 'the /usage popup row must equal jevUsageRow in ' + COMPACT_SRC + '; painted: ' + jev.text)
  const moreAt = lines.findIndex(line => line.includes('↓ 4 more · Z.AI · OpenRouter · Custom endpoint · Local models'))
  check('the row sits directly above the more row, the six absent providers keeping their names', moreAt > 0 && jev.at === moreAt - 1, 'usageBodyRows in ' + COMPACT_SRC + ' must place the Jev row directly above the more row; row at / more row at: ' + `${jev.at} / ${moreAt}`)
  check('the frame fits 178 columns and 51 rows', lines.length <= ROWS && lines.every(line => stringWidth(line) <= COLS), 'the /usage popup must fit 178x51; check usageBodyRows and the row width in ' + COMPACT_SRC)
  check('the key value appears nowhere on the frame; no frame says experimental', !lines.join('\n').includes(PROOF_KEY) && !/experimental/i.test(lines.join('\n')), 'the /usage frame must not show the stored key value or the word experimental; check jevUsageRow in ' + COMPACT_SRC)
  check('the row names no provider balance', !/balance/i.test(jev.text), 'jevUsageRow in ' + COMPACT_SRC + ' must not mention a provider balance; row: ' + jev.text)
  await closePopup(m)
  ledger.resetJevLedger()
  keyOwner.storeJevApiKey(null)
  setting.setJevEnabled(false)
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
