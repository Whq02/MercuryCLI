#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('jev-facts-total')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_REDUCED_MOTION
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 178
const ROWS = 51

let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  const shown = [hint, detail].filter(Boolean).join(' · ')
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && shown ? ` — ${shown.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

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
const crash = await import('../../src/platform/logs/crashReport.js')
const setting = await import('../../src/models/jev/jevSetting.js')
const keyOwner = await import('../../src/models/jev/jevKey.js')
const contract = await import('../../src/models/jev/jevContract.js')
const reader = await import('../../src/models/jev/jevSessionFacts.js')
const slot = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/models/roads/providerUsage.js')
const usage = await import('../../src/screen/settings/Usage.js')
const { call: usageCall } = await import('../../src/commands/usage/usage.js')
const jevBody = await import('../../src/screen/settings/Jev.js')
const { call: jevCall, jevPopupRequest } = await import('../../src/commands/jev/jev.js')

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
const stubConnector = (jev: unknown): InstanceType<typeof NoSessionConnector> =>
  Object.assign(new NoSessionConnector(), { sessionId: () => 'proof-session', usage: () => ({ ...ZERO_USAGE, ...(jev === undefined ? {} : { jev }) }) })

const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
const safe = (words: () => string): string => {
  try {
    return words()
  } catch (error) {
    return `THROW: ${error instanceof Error ? error.message : String(error)}`
  }
}
const BORDERS = /[│╭╮╰╯─]/g
const inner = (line: string): string => line.replace(BORDERS, ' ').trim()
const spendRow = (lines: string[]): string => inner(lines.find(line => /\bSpend\s{2,}\S/.test(line)) ?? '')
const usageRowOf = (lines: string[]): string => inner(lines.find(line => line.includes(usage.JEV_USAGE_LABEL)) ?? '')
const crashesDir = crash.crashReportDir()
const crashFiles = (): string[] => (existsSync(crashesDir) ? readdirSync(crashesDir).filter(name => name.startsWith('crash-')) : [])
const FALLBACK = 'a part of this view could not be rendered'

async function mountPopup(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  return mountOffscreen(element, COLS, ROWS)
}
async function closePopup(m: Mounted): Promise<void> {
  store.closeSettingsPopup()
  m.unmount()
  await settle(60)
}
type Painted = { ok: true; lines: string[]; m: Mounted } | { ok: false; error: string }
async function paint(open: (m: Mounted) => Promise<void>, title: string): Promise<Painted> {
  try {
    const m = await mountPopup()
    await open(m)
    await waitFor(() => m.screen().includes(title), 4000)
    await settle(200)
    return { ok: true, lines: m.lines(), m }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }
}
async function paintJev(): Promise<Painted> {
  return paint(async () => {
    await jevCall('', {} as never)
  }, 'Mercury · jev')
}
async function paintUsage(): Promise<Painted> {
  return paint(async () => {
    await usageCall('', {} as never)
  }, 'Mercury · usage')
}

const T0 = Date.UTC(2026, 0, 15, 14, 30)
const WORDS = 'allowance hit — Mercury counts $0.42 of the $0.40 session allowance and one more call could pass it; /clear resets the count, /jev raises the allowance'
const wireRow = { spend_usd: 0.422688, calls: 3, attempts: 4, input_tokens: 10_000_000, unconfirmed_charges: 1, hold_until_ms: 0, refusals: 0, last_answered_at_ms: T0 + 2000, last_model: 'jev-1.13.0', status: { kind: 'allowance-hit', words: WORDS } }
const internalRow = { spendUsd: 0.422688, calls: 3, attempts: 4, inputTokens: 10_000_000, unconfirmedCharges: 1, holdUntilMs: 0, refusals: 0, lastAnsweredAtMs: T0 + 2000, lastModel: 'jev-1.13.0', status: { kind: 'allowance-hit', words: WORDS } }
const { spendUsd: _dropped, ...partialRow } = internalRow
void _dropped

const decode = (row: unknown): unknown => (typeof reader.jevFactsOfRow === 'function' ? reader.jevFactsOfRow(row) : 'NO DECODER')

section('§0 the decoder is total: both spellings decode, everything else reads as not reported')
{
  check('the crashes dir is the scratch home\'s (hermetic) and empty going in', crashesDir.includes('jev-facts-total') && crashFiles().length === 0, `${crashesDir} · ${crashFiles().join(',')}`, 'the proof home must be the scratch home from pinScratchHome and hold no crash report before the legs run; a leftover crash file means an earlier leg threw')
  check('a fresh home: switch off, no key', setting.jevEnabled() === false && keyOwner.jevKeyPresence().present === false, '', 'a fresh home must read jevEnabled false in src/models/jev/jevSetting.ts and no key in src/models/jev/jevKey.ts')
  check('the reader exports the one total decoder', typeof reader.jevFactsOfRow === 'function', '', 'export jevFactsOfRow from src/models/jev/jevSessionFacts.ts')
  check("an older daemon's wire-spelled row decodes to the internal spelling", j(decode(wireRow)) === j(internalRow), j(decode(wireRow)), 'change jevFactsOfRow in src/models/jev/jevSessionFacts.ts to decode the snake_case wire row into the camelCase facts')
  check('the internal spelling decodes to itself', j(decode(internalRow)) === j(internalRow), '', 'jevFactsOfRow in src/models/jev/jevSessionFacts.ts must accept the camelCase row unchanged')
  check('a row with a null last answer and no model decodes', j(decode({ ...wireRow, last_answered_at_ms: null, last_model: null })) === j({ ...internalRow, lastAnsweredAtMs: null, lastModel: null }), '', 'jevFactsOfRow in src/models/jev/jevSessionFacts.ts must accept a null last answer and a null model')
  const refused: Array<[string, unknown]> = [
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'jev'],
    ['an empty object', {}],
    ['a partial row without spendUsd', partialRow],
    ['spendUsd NaN', { ...internalRow, spendUsd: Number.NaN }],
    ['spendUsd Infinity', { ...internalRow, spendUsd: Number.POSITIVE_INFINITY }],
    ['spendUsd a string', { ...internalRow, spendUsd: '0.42' }],
    ['calls missing', (({ calls: _c, ...rest }) => rest)(internalRow)],
    ['lastAnsweredAtMs undefined', { ...internalRow, lastAnsweredAtMs: undefined }],
    ['lastModel a number', { ...internalRow, lastModel: 7 }],
    ['status missing', (({ status: _s, ...rest }) => rest)(internalRow)],
    ["status.kind 'nonsense'", { ...internalRow, status: { kind: 'nonsense', words: 'x' } }],
    ["status.kind 'toString' (a prototype key is not a kind)", { ...internalRow, status: { kind: 'toString', words: 'x' } }],
    ['status.words a number', { ...internalRow, status: { kind: 'ready', words: 1 } }],
  ]
  for (const [name, row] of refused) check(`${name} reads as not reported`, decode(row) === undefined, j(decode(row)), 'jevFactsOfRow in src/models/jev/jevSessionFacts.ts must return undefined for this malformed row instead of decoding or throwing')
  check('every status kind the headwords name is accepted', contract.JEV_STATUS_KINDS.every(kind => (decode({ ...internalRow, status: { kind, words: 'w' } }) as { status?: { kind?: string } } | undefined)?.status?.kind === kind), '', 'jevFactsOfRow in src/models/jev/jevSessionFacts.ts must accept every kind in JEV_STATUS_KINDS from src/models/jev/jevContract.ts')
}

type Case = { name: string; jev: unknown; reported: boolean }
const cases: Case[] = [
  { name: 'absent', jev: undefined, reported: false },
  { name: 'an empty object', jev: {}, reported: false },
  { name: "an older daemon's wire-spelled row (snake_case keys, valid numbers)", jev: wireRow, reported: true },
  { name: 'a partial camelCase row without spendUsd', jev: partialRow, reported: false },
  { name: 'a row with spendUsd NaN', jev: { ...internalRow, spendUsd: Number.NaN }, reported: false },
  { name: "a row whose status.kind is 'nonsense'", jev: { ...internalRow, status: { kind: 'nonsense', words: 'x' } }, reported: false },
]
const absentUsageRow = `${usage.JEV_USAGE_LABEL} · second-opinion evaluator · ${reader.JEV_SPEND_UNREPORTED_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}`
const absentPopupLine = `off · official · no key · ${reader.JEV_SPEND_UNREPORTED_SHORT_WORDS} · cap $20.00 · off`
const reportedUsageRow = `${usage.JEV_USAGE_LABEL} · second-opinion evaluator · $0.42 of a $20.00 allowance · 3 calls (1 unconfirmed) · allowance hit · credits: ${CREDITS_UNREPORTED_WORDS}`
const reportedPopupLine = 'off · official · no key · spend $0.42 / $20.00 · allowance hit'

let n = 0
for (const c of cases) {
  n++
  section(`§${n} usage().jev is ${c.name}`)
  slot.setFocusedSessionConnector(stubConnector(c.jev))
  const session = reader.jevSessionFacts()
  check(`the reader answers ${c.reported ? 'reported' : 'unknown'}`, slot.hasFocusedSession() && session.state === (c.reported ? 'reported' : 'unknown'), j(session), 'change jevSessionFacts in src/models/jev/jevSessionFacts.ts so this usage().jev value reads as the expected state')
  const row = safe(() => usage.jevUsageRow())
  check(c.reported ? 'the /usage row carries the figures decoded from spend_usd ($0.42, 3 calls, 1 unconfirmed) and the runner\'s headword' : 'the /usage row carries the not-reported words, the shared allowance and the shared headword', row === (c.reported ? reportedUsageRow : absentUsageRow), row, 'change the Jev row in src/screen/settings/Usage.tsx; a THROW in the printed row means it threw on this usage value')
  const line = safe(() => jevBody.jevPopupLine())
  check(c.reported ? 'the /jev summary line reads the decoded spend against the allowance' : 'the /jev summary line reads the short absence words', line === (c.reported ? reportedPopupLine : absentPopupLine), line, 'change jevPopupLine in src/screen/settings/Jev.tsx; a THROW in the printed line means it threw on this usage value')
  const jev = await paintJev()
  check('the /jev popup paints without a throw', jev.ok, jev.ok ? '' : jev.error, 'the /jev popup in src/screen/settings/Jev.tsx threw or never showed its title; read the error printed here')
  if (jev.ok) {
    check('the popup title and the summary line are on the frame, and no boundary fallback', has(jev.lines, 'Mercury · jev') && has(jev.lines, line) && !has(jev.lines, FALLBACK) && !has(jev.lines, 'RENDER ERROR'), jev.lines.filter(l => l.includes('JEV') || l.includes(FALLBACK)).join(' | '), 'the /jev popup body in src/screen/settings/Jev.tsx threw while painting, or its summary line is missing from the frame')
    check(c.reported ? 'the Spend row carries the decoded count' : 'the Spend row carries the full not-reported words', c.reported ? /spend so far: \$0\.42 · 3 calls · 1 unconfirmed/.test(spendRow(jev.lines)) : spendRow(jev.lines).includes(reader.JEV_SPEND_UNREPORTED_WORDS), spendRow(jev.lines), 'change the Spend row in src/screen/settings/Jev.tsx to read the session facts from src/models/jev/jevSessionFacts.ts')
    check(c.reported ? "the status line is the runner's words" : 'the status line is the shared reading (off)', c.reported ? has(jev.lines, 'JEV allowance hit') : has(jev.lines, 'JEV off'), jev.lines.filter(l => l.includes('JEV ')).join(' | '))
    await closePopup(jev.m)
  }
  const use = await paintUsage()
  check('the /usage popup paints without a throw', use.ok, use.ok ? '' : use.error, 'the /usage popup in src/screen/settings/Usage.tsx threw or never showed its title; read the error printed here')
  if (use.ok) {
    check(c.reported ? 'the usage title is on the frame and the Jev row (calls on the count) is painted verbatim, no boundary fallback' : 'the usage title is on the frame and no Jev row paints for a home with no key and nothing counted, no boundary fallback', has(use.lines, 'Mercury · usage') && usageRowOf(use.lines) === (c.reported ? row : '') && !has(use.lines, FALLBACK) && !has(use.lines, 'RENDER ERROR'), usageRowOf(use.lines), 'the Jev row in src/screen/settings/Usage.tsx must paint exactly as jevUsageRow reads, and not at all with no key and nothing counted')
    await closePopup(use.m)
  }
  check('no crash report landed', crashFiles().length === 0, crashFiles().join(','), 'a popup surface threw and the boundary in src/screen/overlays/SettingsPopupSlot.tsx filed a crash report; read the file under the crashes dir')
}

section(`§${n + 1} no session in the slot`)
{
  slot.releaseFocusedSessionConnector()
  check('the reader answers no-session', !slot.hasFocusedSession() && reader.jevSessionFacts().state === 'no-session', '', 'jevSessionFacts in src/models/jev/jevSessionFacts.ts must read no-session once the focused connector is released')
  const row = safe(() => usage.jevUsageRow())
  check('the /usage row reads no chat open beside the shared parts', row === `${usage.JEV_USAGE_LABEL} · second-opinion evaluator · ${reader.JEV_NO_SESSION_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}`, row, 'change the Jev row in src/screen/settings/Usage.tsx to read no chat open when there is no session')
  const line = safe(() => jevBody.jevPopupLine())
  check('the /jev summary line reads no chat', line === `off · official · no key · ${reader.JEV_NO_SESSION_SHORT_WORDS} · cap $20.00 · off`, line, 'change jevPopupLine in src/screen/settings/Jev.tsx to read no chat when there is no session')
  const jev = await paintJev()
  check('the /jev popup paints without a throw', jev.ok, jev.ok ? '' : jev.error, 'the /jev popup in src/screen/settings/Jev.tsx threw or never showed its title; read the error printed here')
  if (jev.ok) {
    check('the Spend row reads no chat open and no fallback paints', spendRow(jev.lines).includes(reader.JEV_NO_SESSION_WORDS) && has(jev.lines, line) && !has(jev.lines, FALLBACK), spendRow(jev.lines))
    await closePopup(jev.m)
  }
  const use = await paintUsage()
  check('the /usage popup paints without a throw', use.ok, use.ok ? '' : use.error, 'the /usage popup in src/screen/settings/Usage.tsx threw or never showed its title; read the error printed here')
  if (use.ok) {
    check('no chat and no key: no Jev row paints, no fallback', usageRowOf(use.lines) === '' && !has(use.lines, FALLBACK), usageRowOf(use.lines))
    await closePopup(use.m)
  }
  check('no crash report landed', crashFiles().length === 0, crashFiles().join(','), 'a popup surface threw and the boundary in src/screen/overlays/SettingsPopupSlot.tsx filed a crash report; read the file under the crashes dir')
}

section(`§${n + 2} a throw inside a popup surface never reaches the app root: the slot's boundary paints one quiet line and files a settings-popup report`)
{
  slot.setFocusedSessionConnector(stubConnector(undefined))
  const request = jevPopupRequest()
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => 'proof-session',
      usage: (): never => {
        throw new Error('MERCURY_JEV_FIXTURE_FAULT')
      },
    }),
  )
  const painted = await paint(async () => {
    store.openSettingsPopup(request)
  }, FALLBACK)
  check('the mount survives the surface throw', painted.ok, painted.ok ? '' : painted.error)
  if (painted.ok) {
    check('the boundary\'s one quiet line paints where the popup stands, no raw render error', has(painted.lines, FALLBACK) && !has(painted.lines, 'RENDER ERROR') && !has(painted.lines, 'MERCURY_JEV_FIXTURE_FAULT'), painted.lines.filter(l => l.trim() !== '').slice(0, 6).join(' | '), 'the popup boundary in src/screen/overlays/SettingsPopupSlot.tsx must paint one quiet fallback line for a throwing surface, not the raw render error')
    await closePopup(painted.m)
  }
  const reports = crashFiles()
  check('exactly one crash report landed, with the settings-popup origin and the fault named', reports.length === 1 && reports[0]!.includes('-settings-popup.json') && (JSON.parse(readFileSync(join(crashesDir, reports[0]!), 'utf8')) as { origin?: string; message?: string }).origin === 'settings-popup' && (JSON.parse(readFileSync(join(crashesDir, reports[0]!), 'utf8')) as { message?: string }).message === 'MERCURY_JEV_FIXTURE_FAULT', reports.join(','), 'the popup boundary in src/screen/overlays/SettingsPopupSlot.tsx must file exactly one crash report with origin settings-popup and the thrown message')
  check('no app-root report landed', !reports.some(name => name.includes('-app-root.json')), reports.join(','), 'a popup throw reached the app root; the boundary in src/screen/overlays/SettingsPopupSlot.tsx must catch it')
}


slot._resetFocusedSessionConnectorForTesting()
await releaseScratchHome(HOME)
console.log(`\nprove-jev-facts-total: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
