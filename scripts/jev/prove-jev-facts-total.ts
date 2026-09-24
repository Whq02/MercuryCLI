#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
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
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
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
const crash = await import('../../src/utils/crashReport.js')
const setting = await import('../../src/services/jev/jevSetting.js')
const keyOwner = await import('../../src/services/jev/jevKey.js')
const contract = await import('../../src/services/jev/jevContract.js')
const reader = await import('../../src/services/jev/jevSessionFacts.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/services/providers/providerUsage.js')
const usage = await import('../../src/components/Settings/Usage.js')
const { call: usageCall } = await import('../../src/commands/usage/usage.js')
const jevBody = await import('../../src/components/Settings/Jev.js')
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
  check('the crashes dir is the scratch home\'s (hermetic) and empty going in', crashesDir.includes('jev-facts-total') && crashFiles().length === 0, `${crashesDir} · ${crashFiles().join(',')}`)
  check('a fresh home: switch off, no key', setting.jevEnabled() === false && keyOwner.jevKeyPresence().present === false)
  check('the reader exports the one total decoder', typeof reader.jevFactsOfRow === 'function')
  check("an older daemon's wire-spelled row decodes to the internal spelling", j(decode(wireRow)) === j(internalRow), j(decode(wireRow)))
  check('the internal spelling decodes to itself', j(decode(internalRow)) === j(internalRow))
  check('a row with a null last answer and no model decodes', j(decode({ ...wireRow, last_answered_at_ms: null, last_model: null })) === j({ ...internalRow, lastAnsweredAtMs: null, lastModel: null }))
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
  for (const [name, row] of refused) check(`${name} reads as not reported`, decode(row) === undefined, j(decode(row)))
  check('every status kind the headwords name is accepted', contract.JEV_STATUS_KINDS.every(kind => (decode({ ...internalRow, status: { kind, words: 'w' } }) as { status?: { kind?: string } } | undefined)?.status?.kind === kind))
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
const absentUsageRow = `${usage.JEV_USAGE_LABEL}: ${reader.JEV_SPEND_UNREPORTED_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}`
const absentPopupLine = `switch off · no key · ${reader.JEV_SPEND_UNREPORTED_SHORT_WORDS} · allowance $20.00 · off`
const reportedUsageRow = `${usage.JEV_USAGE_LABEL}: $0.42 · 3 calls (1 unconfirmed) · allowance $20.00 · allowance hit · credits: ${CREDITS_UNREPORTED_WORDS}`
const reportedPopupLine = 'switch off · no key · spend $0.42 of $20.00 · allowance hit'

let n = 0
for (const c of cases) {
  n++
  section(`§${n} usage().jev is ${c.name}`)
  slot.setFocusedSessionConnector(stubConnector(c.jev))
  const session = reader.jevSessionFacts()
  check(`the reader answers ${c.reported ? 'reported' : 'unknown'}`, slot.hasFocusedSession() && session.state === (c.reported ? 'reported' : 'unknown'), j(session))
  const row = safe(() => usage.jevUsageRow())
  check(c.reported ? 'the /usage row carries the figures decoded from spend_usd ($0.42, 3 calls, 1 unconfirmed) and the runner\'s headword' : 'the /usage row carries the not-reported words, the shared allowance and the shared headword', row === (c.reported ? reportedUsageRow : absentUsageRow), row)
  const line = safe(() => jevBody.jevPopupLine())
  check(c.reported ? 'the /jev summary line reads the decoded spend against the allowance' : 'the /jev summary line reads the short absence words', line === (c.reported ? reportedPopupLine : absentPopupLine), line)
  const jev = await paintJev()
  check('the /jev popup paints without a throw', jev.ok, jev.ok ? '' : jev.error)
  if (jev.ok) {
    check('the popup title and the summary line are on the frame, and no boundary fallback', has(jev.lines, 'Mercury · jev') && has(jev.lines, line) && !has(jev.lines, FALLBACK) && !has(jev.lines, 'RENDER ERROR'), jev.lines.filter(l => l.includes('JEV') || l.includes(FALLBACK)).join(' | '))
    check(c.reported ? 'the Spend row carries the decoded count' : 'the Spend row carries the full not-reported words', c.reported ? /spend so far: \$0\.42 · 3 calls · 1 unconfirmed/.test(spendRow(jev.lines)) : spendRow(jev.lines).includes(reader.JEV_SPEND_UNREPORTED_WORDS), spendRow(jev.lines))
    check(c.reported ? "the status line is the runner's words" : 'the status line is the shared reading (off)', c.reported ? has(jev.lines, 'JEV allowance hit') : has(jev.lines, 'JEV off'), jev.lines.filter(l => l.includes('JEV ')).join(' | '))
    await closePopup(jev.m)
  }
  const use = await paintUsage()
  check('the /usage popup paints without a throw', use.ok, use.ok ? '' : use.error)
  if (use.ok) {
    check('the usage title is on the frame and the JEV row is painted verbatim, no boundary fallback', has(use.lines, 'Mercury · usage') && usageRowOf(use.lines) === row && !has(use.lines, FALLBACK) && !has(use.lines, 'RENDER ERROR'), usageRowOf(use.lines))
    await closePopup(use.m)
  }
  check('no crash report landed', crashFiles().length === 0, crashFiles().join(','))
}

section(`§${n + 1} no session in the slot`)
{
  slot.releaseFocusedSessionConnector()
  check('the reader answers no-session', !slot.hasFocusedSession() && reader.jevSessionFacts().state === 'no-session')
  const row = safe(() => usage.jevUsageRow())
  check('the /usage row reads no chat open beside the shared parts', row === `${usage.JEV_USAGE_LABEL}: ${reader.JEV_NO_SESSION_WORDS} · allowance $20.00 · off · credits: ${CREDITS_UNREPORTED_WORDS}`, row)
  const line = safe(() => jevBody.jevPopupLine())
  check('the /jev summary line reads no chat', line === `switch off · no key · ${reader.JEV_NO_SESSION_SHORT_WORDS} · allowance $20.00 · off`, line)
  const jev = await paintJev()
  check('the /jev popup paints without a throw', jev.ok, jev.ok ? '' : jev.error)
  if (jev.ok) {
    check('the Spend row reads no chat open and no fallback paints', spendRow(jev.lines).includes(reader.JEV_NO_SESSION_WORDS) && has(jev.lines, line) && !has(jev.lines, FALLBACK), spendRow(jev.lines))
    await closePopup(jev.m)
  }
  const use = await paintUsage()
  check('the /usage popup paints without a throw', use.ok, use.ok ? '' : use.error)
  if (use.ok) {
    check('the JEV row is painted verbatim, no fallback', usageRowOf(use.lines) === row && !has(use.lines, FALLBACK), usageRowOf(use.lines))
    await closePopup(use.m)
  }
  check('no crash report landed', crashFiles().length === 0, crashFiles().join(','))
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
    check('the boundary\'s one quiet line paints where the popup stands, no raw render error', has(painted.lines, FALLBACK) && !has(painted.lines, 'RENDER ERROR') && !has(painted.lines, 'MERCURY_JEV_FIXTURE_FAULT'), painted.lines.filter(l => l.trim() !== '').slice(0, 6).join(' | '))
    await closePopup(painted.m)
  }
  const reports = crashFiles()
  check('exactly one crash report landed, with the settings-popup origin and the fault named', reports.length === 1 && reports[0]!.includes('-settings-popup.json') && (JSON.parse(readFileSync(join(crashesDir, reports[0]!), 'utf8')) as { origin?: string; message?: string }).origin === 'settings-popup' && (JSON.parse(readFileSync(join(crashesDir, reports[0]!), 'utf8')) as { message?: string }).message === 'MERCURY_JEV_FIXTURE_FAULT', reports.join(','))
  check('no app-root report landed', !reports.some(name => name.includes('-app-root.json')))
}

section(`§${n + 3} the source pins`)
{
  const slotSrc = readFileSync(join(REPO, 'src/components/SettingsPopupSlot.tsx'), 'utf8')
  check('the popup slot wraps the shell in the row boundary with the settings-popup origin', slotSrc.includes('<RowErrorBoundary key={open} origin="settings-popup">') && slotSrc.includes('<Settings key={open} request={request} geometry={geometry} />') && slotSrc.includes('</RowErrorBoundary>'))
  const boundary = readFileSync(join(REPO, 'src/components/RowErrorBoundary.tsx'), 'utf8')
  check('the boundary files the report under the origin it was given, message-boundary by default', boundary.includes("persistCrashReport(error, errorInfo, this.props.origin ?? 'message-boundary')"))
  const readerSrc = readFileSync(join(REPO, 'src/services/jev/jevSessionFacts.ts'), 'utf8')
  check('the reader decodes the row through the one total decoder', readerSrc.includes('const facts = jevFactsOfRow(getFocusedSessionConnector().usage().jev)') && readerSrc.includes('export function jevFactsOfRow(value: unknown): JevFactsV1 | undefined'))
  const allowed = new Set(['session.facts.spendUsd', 'settings.allowanceUsd', 'facts.spendUsd', 'facts.session.facts.spendUsd', 'facts.settings.allowanceUsd', 'JEV_MAX_CALL_USD', 'JEV_DEFAULT_ALLOWANCE_USD', 'usd'])
  const offenders = ['src/components/Settings/Jev.tsx', 'src/components/Settings/Usage.tsx'].flatMap(rel => [...readFileSync(join(REPO, rel), 'utf8').matchAll(/jevUsdLabel\(([^()]*)\)/g)].map(m => m[1]!.trim()).filter(arg => !allowed.has(arg)).map(arg => `${rel}: ${arg}`))
  check('Jev.tsx and Usage.tsx hand jevUsdLabel only the decoded facts, the settings or a constant', offenders.length === 0, offenders.join(' | '))
  const contractSrc = readFileSync(join(REPO, 'src/services/jev/jevContract.ts'), 'utf8')
  check('jevUsdLabel keeps its number type: the type forbids undefined, the reader owns the absence words', contractSrc.includes('export function jevUsdLabel(usd: number): string'))
}

slot._resetFocusedSessionConnectorForTesting()
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jev-facts-total: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
