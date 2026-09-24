#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
const HOME = pinScratchHome('jev-facts-ride')
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
const PROOF_KEY = 'proof-key-jev-facts-ride-not-a-real-key-0003'
const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.js')
cap._setHeldMachineSeatReadingForTesting(6, { cores: 8, availableBytes: 6 * cap.SEAT_COST_BYTES.runner, read: 'vm_stat', sampledAt: 0 })
const setting = await import('../../src/services/jev/jevSetting.js')
const status = await import('../../src/services/jev/jevStatus.js')
const keyOwner = await import('../../src/services/jev/jevKey.js')
const ledger = await import('../../src/services/jev/jevLedger.js')
const contract = await import('../../src/services/jev/jevContract.js')
const reader = await import('../../src/services/jev/jevSessionFacts.js')
const wire = await import('../../src/services/engine-connector/seatWire.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { CREDITS_UNREPORTED_WORDS } = await import('../../src/services/providers/providerUsage.js')
const usage = await import('../../src/components/Settings/Usage.js')
const jevBody = await import('../../src/components/Settings/Jev.js')
const { call: jevCall } = await import('../../src/commands/jev/jev.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
type JevFactsV1 = import('../../src/services/engine-connector/types.js').JevFactsV1

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
function stubConnector(jev: JevFactsV1 | undefined): InstanceType<typeof NoSessionConnector> {
  return Object.assign(new NoSessionConnector(), { sessionId: () => 'proof-session', usage: () => (jev === undefined ? ZERO_USAGE : { ...ZERO_USAGE, jev }) })
}

const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const BORDERS = /[│╭╮╰╯─]/g
const popupText = (lines: string[]): string => collapse(lines.map(line => line.replace(BORDERS, ' ')).join(' '))
const spendRow = (m: Mounted): string => (m.lines().find(line => /\bSpend\s{2,}\S/.test(line)) ?? '').replace(BORDERS, ' ').trim()
async function mountPopup(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  return mountOffscreen(element, COLS, ROWS)
}
async function openJev(): Promise<Mounted> {
  const m = await mountPopup()
  await jevCall('', {} as never)
  await waitFor(() => m.screen().includes('Mercury · jev'), 4000)
  await settle(150)
  return m
}
async function openConfig(): Promise<Mounted> {
  const m = await mountPopup()
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes('Mercury · config'), 4000)
  await settle(150)
  return m
}
async function closePopup(m: Mounted): Promise<void> {
  store.closeSettingsPopup()
  m.unmount()
  await settle(60)
}
async function press(m: Mounted, data: string, ms = 120): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function leaveConfig(m: Mounted): Promise<void> {
  await press(m, KEY.esc, 250)
  if (store.isSettingsPopupOpen()) store.closeSettingsPopup()
  m.unmount()
  await settle(60)
}
async function selectMarked(m: Mounted, mark: string, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (has(m.lines(), mark)) return true
    await press(m, KEY.down, 70)
  }
  return has(m.lines(), mark)
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const T0 = Date.UTC(2026, 0, 15, 14, 30)
const RELAYED: JevFactsV1 = {
  spendUsd: 0.42,
  calls: 3,
  attempts: 4,
  inputTokens: 10_000_000,
  unconfirmedCharges: 1,
  holdUntilMs: 0,
  refusals: 0,
  lastAnsweredAtMs: T0 + 2000,
  lastModel: 'jev-1.13.0',
  status: { kind: 'allowance-hit', words: 'allowance hit — a fixture sentence' },
}
let reported: JevFactsV1 = RELAYED
const baseAnswer = {
  model: { effective: 'claude-fable-5-1', setting: null },
  usage: ZERO_USAGE,
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default',
  workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
  queue: [],
}

section('§1 the wire: the row crosses under usage.jev in snake_case and decodes back in the internal spelling')
{
  const encoded = wire.sessionFactsToWire({ ...baseAnswer, usage: { ...ZERO_USAGE, jev: RELAYED } } as never) as { usage: Record<string, unknown> }
  const row = encoded.usage.jev as Record<string, unknown> | undefined
  check('the row rides under usage.jev and every key on it is snake_case', row !== undefined && Object.keys(row).every(key => SNAKE.test(key)), j(row))
  check('the renamed keys carry the figures', row !== undefined && row.spend_usd === 0.42 && row.unconfirmed_charges === 1 && row.hold_until_ms === 0 && row.last_answered_at_ms === T0 + 2000 && row.last_model === 'jev-1.13.0' && row.input_tokens === 10_000_000, j(row))
  check('the keys that were already one word ride as they are, the status nested with kind and words', row !== undefined && row.calls === 3 && row.attempts === 4 && row.refusals === 0 && j(row.status) === j(RELAYED.status), j(row))
  check('no internal spelling survives on the wire', row !== undefined && ['spendUsd', 'unconfirmedCharges', 'holdUntilMs', 'lastAnsweredAtMs', 'lastModel', 'inputTokens'].every(key => !(key in row)), j(row))
  const back = wire.sessionFactsFromWire(JSON.parse(JSON.stringify(encoded)))
  check('the seat decodes the row back deep-equal in the internal spelling', back !== null && j(back.usage.jev) === j(RELAYED), j(back?.usage.jev))
  const bare = wire.sessionFactsToWire(baseAnswer as never) as { usage: Record<string, unknown> }
  const bareBack = wire.sessionFactsFromWire(JSON.parse(JSON.stringify(bare)))
  check("an older runner's answer mints no jev key and reads back without one (absent stays absent, never zero)", !('jev' in bare.usage) && bareBack !== null && !('jev' in bareBack.usage))
  check('the resting connector answers no jev row', slot.hasFocusedSession() === false && slot.getFocusedSessionConnector().usage().jev === undefined)
}

section('§2 the runner-side fold: the ledger and the resolver become the facts row')
{
  setting.setJevEnabled(true)
  keyOwner.storeJevApiKey(PROOF_KEY)
  setting.setJevAllowanceUsd(0.4)
  ledger.resetJevLedger()
  ledger.noteJevAttempt(T0)
  ledger.settleJevCall({ input_tokens: 4_000_000, output_tokens: 0 }, 'jev-1.13.0', T0)
  ledger.noteJevAttempt(T0 + 1000)
  ledger.settleJevCall({ input_tokens: 4_000_000, output_tokens: 0 }, 'jev-1.13.0', T0 + 1000)
  ledger.noteJevAttempt(T0 + 2000)
  ledger.settleJevCall({ input_tokens: 2_000_000, output_tokens: 0 }, 'jev-1.13.0', T0 + 2000)
  ledger.noteJevAttempt(T0 + 3000)
  ledger.noteJevWireFailure({ kind: 'parse-failed', status: 200, detail: 'not json' }, T0 + 3000, () => 0.5)
  const folded = reader.jevFactsOf(ledger.jevLedgerSnapshot(T0 + 4000), status.jevStatus(undefined, T0 + 4000))
  check('the fold carries the ledger figures: $0.42, 3 calls, 4 attempts, 1 unconfirmed, the last answer and the served model', contract.jevUsdLabel(folded.spendUsd) === '$0.42' && folded.calls === 3 && folded.attempts === 4 && folded.unconfirmedCharges === 1 && folded.inputTokens === 10_000_000 && folded.lastAnsweredAtMs === T0 + 2000 && folded.lastModel === 'jev-1.13.0', j(folded))
  check("the fold carries the unreadable reply's hold and refusal streak", folded.holdUntilMs === T0 + 3000 + ledger.JEV_COOL_DOWN_BASE_MS && folded.refusals === 1, j(folded))
  check("the fold carries the resolver's status verbatim: allowance hit in Mercury's count", folded.status.kind === 'allowance-hit' && folded.status.words.startsWith('allowance hit — Mercury counts $0.42 of the $0.40 session allowance'), folded.status.words)
  check('the fold names exactly the keys the wire table and the type declare', Object.keys(folded).sort().join(',') === 'attempts,calls,holdUntilMs,inputTokens,lastAnsweredAtMs,lastModel,refusals,spendUsd,status,unconfirmedCharges', Object.keys(folded).join(','))
  reported = folded
  ledger.resetJevLedger()
}

const expectedRow = `${usage.JEV_USAGE_LABEL}: $0.42 · 3 calls (1 unconfirmed) · allowance $0.40 · allowance hit · credits: ${CREDITS_UNREPORTED_WORDS}`
section("§3 a focused session reports its facts while the cockpit's own ledger is empty: the surfaces paint the session's figures")
{
  check('the local ledger is empty going in', ledger.jevLedgerSnapshot().spendUsd === 0 && ledger.jevLedgerSnapshot().calls === 0 && status.jevStatus().kind === 'ready')
  slot.setFocusedSessionConnector(stubConnector(reported))
  const session = reader.jevSessionFacts()
  check('the reader answers the reported facts', slot.hasFocusedSession() && session.state === 'reported' && j(session.facts) === j(reported), j(session))
  check("the reader's status is the runner's, verbatim", j(reader.jevSessionStatus()) === j(reported.status), j(reader.jevSessionStatus()))
  const row = usage.jevUsageRow()
  check("the /usage row paints the session's count, calls, unconfirmed charge and the allowance-hit headword", row === expectedRow, row)
  check('the row fits the popup body', stringWidth(row) <= 146, String(stringWidth(row)))
  const facts = jevBody.jevFacts()
  check("the /jev facts carry the runner's words and the popup line reads the session's spend against the allowance", facts.status.words === reported.status.words && jevBody.jevPopupLine(facts) === 'switch on · key stored · spend $0.42 of $0.40 · allowance hit', jevBody.jevPopupLine(facts))
  const m = await openJev()
  const lines = m.lines()
  check("the /jev popup's status line is the runner's words verbatim", popupText(lines).includes(collapse(status.jevStatusLine(reported.status))), popupText(lines))
  check("the Spend row is the session's count with its last answer and served model", /Spend\s+spend so far: \$0\.42 · 3 calls · 1 unconfirmed/.test(spendRow(m)) && spendRow(m).includes(`last answered ${contract.jevClockLabel(T0 + 2000)} · jev-1.13.0`), spendRow(m))
  check('the context line is painted', has(lines, jevBody.jevPopupLine(facts)))
  check('the frame paints no zero count and no ready word', !has(lines, 'spend so far: $0.00') && !has(lines, 'JEV ready'))
  check('the key value appears nowhere on the frame', !lines.join('\n').includes(PROOF_KEY))
  await closePopup(m)
  const c = await openConfig()
  const found = await selectMarked(c, `${CONFIG_ROW_MARK} JEV`)
  check("/config's JEV row warns with the runner's status words", found && popupText(c.lines()).includes(collapse(status.jevStatusLine(reported.status))), popupText(c.lines()).slice(0, 400))
  check('/config paints no local resolution beside it', !has(c.lines(), 'JEV ready'))
  await leaveConfig(c)
}

section("§4 the reverse: the cockpit's own ledger carries spend while the focused session omits the row — the not-reported words, never the local figures")
{
  ledger.resetJevLedger()
  ledger.noteJevAttempt(T0)
  ledger.settleJevCall({ input_tokens: 10_000_000, output_tokens: 0 }, 'jev-1.13.0', T0)
  check('the local ledger now carries $0.42 and its own resolver says allowance hit', contract.jevUsdLabel(ledger.jevLedgerSnapshot().spendUsd) === '$0.42' && status.jevStatus().kind === 'allowance-hit')
  slot.setFocusedSessionConnector(stubConnector(undefined))
  const session = reader.jevSessionFacts()
  check('the reader answers unknown for a session whose runner omitted the row', slot.hasFocusedSession() && session.state === 'unknown', j(session))
  check('the status falls to what shared state supports: ready (switch on, key stored), never the local allowance hit', j(reader.jevSessionStatus()) === j({ kind: 'ready', words: 'ready' }), j(reader.jevSessionStatus()))
  const row = usage.jevUsageRow()
  check('the /usage row says the session spend is not reported, keeps the shared allowance and the shared headword', row === `${usage.JEV_USAGE_LABEL}: ${reader.JEV_SPEND_UNREPORTED_WORDS} · allowance $0.40 · ready · credits: ${CREDITS_UNREPORTED_WORDS}`, row)
  check('the row carries none of the local figures', !row.includes('$0.42') && !row.includes('1 call') && !row.includes('allowance hit'))
  const facts = jevBody.jevFacts()
  check('the popup line names the absence in its short form beside the allowance', jevBody.jevPopupLine(facts) === `switch on · key stored · ${reader.JEV_SPEND_UNREPORTED_SHORT_WORDS} · allowance $0.40 · ready`, jevBody.jevPopupLine(facts))
  const m = await openJev()
  const lines = m.lines()
  check('the Spend row reads the not-reported words', new RegExp(`Spend\\s+${reader.JEV_SPEND_UNREPORTED_WORDS}`).test(spendRow(m)), spendRow(m))
  check('the status line is the shared reading', has(lines, 'JEV ready'))
  check('the frame paints none of the local figures', !has(lines, '$0.42') && !has(lines, 'spend so far') && !has(lines, 'allowance hit'))
  await closePopup(m)
  const c = await openConfig()
  const found = await selectMarked(c, `${CONFIG_ROW_MARK} JEV`)
  check("/config's JEV row warns with the shared reading, never the local allowance hit", found && has(c.lines(), 'JEV ready') && !has(c.lines(), 'allowance hit'), popupText(c.lines()).slice(0, 400))
  await leaveConfig(c)
}

section('§5 no session in the slot: the honest no-chat form')
{
  slot.releaseFocusedSessionConnector()
  const session = reader.jevSessionFacts()
  check('the reader answers no-session while the slot rests', !slot.hasFocusedSession() && session.state === 'no-session', j(session))
  const row = usage.jevUsageRow()
  check('the /usage row says no chat is open beside the shared parts', row === `${usage.JEV_USAGE_LABEL}: ${reader.JEV_NO_SESSION_WORDS} · allowance $0.40 · ready · credits: ${CREDITS_UNREPORTED_WORDS}`, row)
  check('the local ledger still carries spend and the row still paints none of it', contract.jevUsdLabel(ledger.jevLedgerSnapshot().spendUsd) === '$0.42' && !row.includes('$0.42'))
  const facts = jevBody.jevFacts()
  check('the popup line (short form) and the Spend row (full words) read no chat', jevBody.jevPopupLine(facts) === `switch on · key stored · ${reader.JEV_NO_SESSION_SHORT_WORDS} · allowance $0.40 · ready` && jevBody.jevRowWords('spend', facts) === reader.JEV_NO_SESSION_WORDS, jevBody.jevPopupLine(facts))
  const m = await openJev()
  check('the mounted popup paints the no-chat words on the Spend row', new RegExp(`Spend\\s+${reader.JEV_NO_SESSION_WORDS}`).test(spendRow(m)) && !has(m.lines(), '$0.42'), spendRow(m))
  await closePopup(m)
  setting.setJevEnabled(false)
  check('with the switch off the shared reading is off, in the resolver\'s words', j(reader.jevSessionStatus()) === j(status.jevStatus()) && reader.jevSessionStatus().kind === 'off')
  keyOwner.storeJevApiKey(null)
  setting.setJevEnabled(true)
  check('with no key the shared reading is no key, in the resolver\'s words', j(reader.jevSessionStatus()) === j(status.jevStatus()) && reader.jevSessionStatus().kind === 'no-key')
  setting.setJevEnabled(false)
}

section('§6 the source pins')
{
  const surfaces = ['src/components/Settings/Usage.tsx', 'src/components/Settings/Jev.tsx', 'src/components/Settings/Config.tsx'].map(rel => [rel, readFileSync(join(REPO, rel), 'utf8')] as const)
  check('the three screen surfaces read no ledger snapshot and run no local resolver', surfaces.every(([, src]) => !src.includes('jevLedgerSnapshot') && !src.includes('jevLedger.js') && !src.includes('resolveJevStatus') && !/\bjevStatus\(/.test(src)), surfaces.filter(([, src]) => src.includes('jevLedgerSnapshot') || src.includes('resolveJevStatus') || /\bjevStatus\(/.test(src)).map(([rel]) => rel).join(','))
  check('each of the three reads the one session reader', surfaces.every(([, src]) => src.includes("from '../../services/jev/jevSessionFacts.js'")))
  check('each of the three repaints when the focused facts move', surfaces.every(([, src]) => src.includes('useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)')))
  const printSrc = readFileSync(join(REPO, 'src/cli/print.ts'), 'utf8')
  const caseStart = printSrc.indexOf("case 'session_facts':")
  const answerer = printSrc.slice(caseStart, printSrc.indexOf("case '", caseStart + 1))
  check('the runner answers usage.jev from its own ledger snapshot and its own resolver', caseStart > 0 && answerer.includes('jev: jevFactsOf(jevLedgerSnapshot(factsNow), jevStatus(undefined, factsNow)),') && printSrc.includes("import { jevLedgerSnapshot } from '../services/jev/jevLedger.js'") && printSrc.includes("import { jevStatus } from '../services/jev/jevStatus.js'"))
  const types = readFileSync(join(REPO, 'src/services/engine-connector/types.ts'), 'utf8')
  check('the field is declared OPTIONAL on UsageFactsV1 and the kind rides a type-only import', /^\s+jev\?: JevFactsV1$/m.test(types) && types.includes("import type { JevStatusKind } from '../jev/jevContract.js'") && !/^import \{[^}]*\} from '\.\.\/jev\//m.test(types))
  const wireSrc = readFileSync(join(REPO, 'src/services/engine-connector/seatWire.ts'), 'utf8')
  check('the wire table names every renamed key and the usage codec applies it', ["spendUsd: 'spend_usd'", "inputTokens: 'input_tokens'", "unconfirmedCharges: 'unconfirmed_charges'", "holdUntilMs: 'hold_until_ms'", "lastAnsweredAtMs: 'last_answered_at_ms'", "lastModel: 'last_model'"].every(needle => wireSrc.includes(needle)) && wireSrc.includes('if (isRow(jev)) out.jev = renamed(jev, jevTable)') && wireSrc.includes('t(LANE_WINDOW), laneWindowKeys, t(JEV))'))
  const readerSrc = readFileSync(join(REPO, 'src/services/jev/jevSessionFacts.ts'), 'utf8')
  check('the reader answers from the focused slot alone, never a ledger snapshot', readerSrc.includes('getFocusedSessionConnector().usage().jev') && readerSrc.includes('if (!hasFocusedSession()) return { state: \'no-session\' }') && !readerSrc.includes('jevLedgerSnapshot'))
  const boot = readFileSync(join(REPO, 'src/components/BootSettingsScreen.tsx'), 'utf8')
  check('the Boot Settings face (outside any chat) keeps the settings-and-key line and reads no session facts', boot.includes('jevStatusLine()') && !boot.includes('jevSessionFacts'))
  const outside = ['src/daemon', 'src/services/switchboard'].flatMap(rel => walk(join(REPO, rel))).filter(p => readFileSync(p, 'utf8').includes('jev'))
  check('the daemon and the switchboard never name jev (the row rides the facts untouched)', outside.length === 0, outside.join(','))
}

slot._resetFocusedSessionConnectorForTesting()
ledger.resetJevLedger()
keyOwner.storeJevApiKey(null)
setting.setJevEnabled(false)
setting.setJevAllowanceUsd(setting.JEV_DEFAULT_ALLOWANCE_USD)
cap._setHeldMachineSeatReadingForTesting(null)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jev-facts-ride: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
