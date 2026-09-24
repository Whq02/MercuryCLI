#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
const HOME = pinScratchHome('jev-faces')
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
const BACKSPACE = '\x7f'
const PROOF_KEY = 'proof-key-jev-faces-not-a-real-key-0007'
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
const secrets = await import('../../src/utils/router/providerSecrets.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const jevCommand = (await import('../../src/commands/jev/index.js')).default
const { call: jevCall, jevPopupRequest } = await import('../../src/commands/jev/jev.js')
const jevBody = await import('../../src/components/Settings/Jev.js')
const { BootSettingsScreen, JEV_BOOT_DETAIL_WIDTH, jevBootDetailLines, withJevRow } = await import('../../src/components/BootSettingsScreen.js')
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.js')

const configFile = join(HOME, '.mercury.json')
const storedJev = (): Record<string, unknown> | undefined => {
  if (!existsSync(configFile)) return undefined
  return (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>).jev as Record<string, unknown> | undefined
}
const filesMentioning = (needle: string): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (readFileSync(p, 'utf8').includes(needle)) out.push(p)
      } catch {
        continue
      }
    }
  }
  walk(HOME)
  return out
}

const frames: Array<{ name: string; note: string; lines: string[] }> = []
function keepFrame(name: string, note: string, m: Mounted): string[] {
  const lines = m.lines()
  frames.push({ name, note, lines })
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), lines.join('\n') + '\n')
  return lines
}
const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const BORDERS = /[│╭╮╰╯─]/g
const popupText = (lines: string[]): string => collapse(lines.map(line => line.replace(BORDERS, ' ')).join(' '))
function paneLines(lines: string[], title: string, width: number): string[] {
  const header = lines.find(line => line.includes(title))
  if (header === undefined) return []
  const left = header.indexOf(title) - 2
  return lines.map(line => Array.from(line).slice(left + 1, left + width - 1).join('').trim())
}
const paneText = (lines: string[], title: string, width: number): string => collapse(paneLines(lines, title, width).join(' '))

async function mountPopup(overlay: boolean): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay }))),
  )
  return mountOffscreen(element, COLS, ROWS)
}
async function openJev(overlay = true): Promise<Mounted> {
  const m = await mountPopup(overlay)
  await jevCall('', {} as never)
  await waitFor(() => m.screen().includes('Mercury · jev'), 4000)
  await settle(150)
  return m
}
async function openConfig(): Promise<Mounted> {
  const m = await mountPopup(true)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes('Mercury · config'), 4000)
  await settle(150)
  return m
}
async function openBootFace(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(BootSettingsScreen as never, { fullScene: { columns: COLS, rows: ROWS }, onClose: () => {} })),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  await waitFor(() => m.screen().includes('CONTROL PLANE'), 4000)
  await settle(250)
  return m
}
async function closePopup(m: Mounted): Promise<void> {
  store.closeSettingsPopup()
  m.unmount()
  await settle(60)
}
async function press(m: Mounted, data: string, ms = 120): Promise<void> {
  if (typeof data !== 'string' || data === '') throw new Error('press: an empty key sequence feeds nothing')
  m.push(data)
  await settle(ms)
}
async function selectMarked(m: Mounted, mark: string, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (has(m.lines(), mark)) return true
    await press(m, KEY.down, 70)
  }
  return has(m.lines(), mark)
}
const jevRowMark = `${jevBody.JEV_ROW_MARK} `
const rowLine = (m: Mounted, label: string): string => (m.lines().find(line => line.includes(`${jevRowMark}${label}`)) ?? '').replace(BORDERS, ' ').trim()
const bootJevRow = (lines: string[]): string => lines.find(line => /❯ JEV\s+(?:on|off)\s/.test(line)) ?? ''
const said = (m: Mounted, words: string): boolean => popupText(m.lines()).includes(collapse(words))
const DETAIL_PANE = 'SETTING DETAIL'
const DETAIL_PANE_WIDTH = 46

section('§0 the command and the row objects')
check('/jev is a local, screen-seat, user-private command that is unavailable non-interactively', jevCommand.type === 'local' && jevCommand.seat === 'screen' && jevCommand.userPrivate === true && jevCommand.supportsNonInteractive === false)
{
  const table = readFileSync(join(REPO, 'src/commands.ts'), 'utf8')
  check('/jev is registered beside /usage', table.includes("import jev from './commands/jev/index.js'") && /^\s+jev,$/m.test(table))
  const request = jevPopupRequest()
  check('the request opens the one popup store as the jev view, content-sized, 120 wide', request.view === 'jev' && request.width === jevBody.JEV_POPUP_WIDTH && request.rows === null && request.hint === jevBody.JEV_POPUP_HINT)
  const rows = withJevRow(STARTUP_MENU)
  const at = rows.findIndex(row => row.env === 'jev')
  check('the Boot Menu row joins the AGENTS group of the startup table (one header, beside Sub-agents and Workflows)', at > 0 && rows[at - 1]?.group === 'agents' && rows[at]?.group === 'agents' && rows.length === STARTUP_MENU.length + 1, String(at))
  check('the detail width is the SETTING DETAIL text width and every detail line fits it', JEV_BOOT_DETAIL_WIDTH === 41 && jevBootDetailLines().every(line => stringWidth(line) <= JEV_BOOT_DETAIL_WIDTH), jevBootDetailLines().join(' | '))
}

section('§1 /jev off with no key (frame a)')
check('a fresh home is off, keyless, with no jev key on disk', setting.jevEnabled() === false && keyOwner.jevKeyPresence().present === false && storedJev() === undefined)
{
  const m = await openJev()
  const lines = keepFrame('jev-off-no-key-178x51', '/jev on a fresh home: the switch off, no key, the ledger at zero; the Switch row selected with its note', m)
  const statusLine = status.jevStatusLine()
  check('the status line is the resolver\'s verbatim: off', status.jevStatus().kind === 'off' && popupText(lines).includes(collapse(statusLine)), statusLine)
  check('the Switch row reads off and is selected', rowLine(m, 'Switch').trim().endsWith('off'), rowLine(m, 'Switch'))
  check('the Key row reads the owner\'s words: no key', lines.some(line => /\bKey\s+no key\b/.test(line)), lines.filter(line => line.includes('Key')).join(' | '))
  check('the Spend row is Mercury\'s count, labelled so, at zero', lines.some(line => /Spend\s+spend so far: \$0\.00 · 0 calls · 0 unconfirmed/.test(line)) && has(lines, jevBody.JEV_SPEND_LABEL))
  check('the allowance, pace, ceiling and sub-agents rows carry the setting lines\' values', lines.some(line => /Allowance\s+\$20\.00 — a runaway stop, not a budget/.test(line)) && lines.some(line => /Pace\s+10 requests a minute/.test(line)) && lines.some(line => /Request ceiling\s+off/.test(line)) && lines.some(line => /Sub-agents\s+off/.test(line)))
  check('the doors line names the three surfaces', has(lines, setting.JEV_DOORS))
  check('the context line carries the switch, the key and the spend against the allowance', has(lines, jevBody.jevPopupLine()))
  check('the hint is the popup\'s own', has(lines, '↑↓ select · ←/→ change · ↵ act on the row'))
  check('the selected row\'s note names the one switch and the permission law', popupText(lines).includes('the same switch as the JEV row of /config and the JEV row of the Boot Menu') && popupText(lines).includes('never answers a permission request'))
  await closePopup(m)
}

section('§2 the Boot Settings face: the JEV row selected, its detail pane, the toggle (frame d)')
{
  const m = await openBootFace()
  const found = await selectMarked(m, '❯ JEV')
  check('↓ reaches the JEV row', found, m.lines().filter(line => line.includes('JEV')).join(' | '))
  const lines = keepFrame('boot-settings-jev-row-178x51', 'the Boot Settings face at 178x51 with the JEV row selected under AGENTS: the CONTROL PLANE row (off) and the SETTING DETAIL pane with the status, the key and the setting lines', m)
  const row = bootJevRow(lines)
  const rowAt = lines.indexOf(row)
  check('the row sits under the AGENTS header beside Workflows', rowAt > 0 && (lines[rowAt - 1] ?? '').includes('Workflows'), `${lines[rowAt - 1] ?? ''} / ${row}`)
  check('the row\'s value column reads off', /❯ JEV\s+off\s/.test(row), row)
  const pane = paneText(lines, DETAIL_PANE, DETAIL_PANE_WIDTH)
  check('the detail pane carries the status line verbatim, wrapped at the pane width', pane.includes(collapse(status.jevStatusLine())), pane)
  check('the detail pane carries the key words', pane.includes(keyOwner.jevKeySourceWords(keyOwner.jevKeyPresence())))
  check('the detail pane names the row\'s What it controls and the permission law', pane.includes('What it controls') && pane.includes('never answers a permission request'))
  check('the pane wraps the allowance sentence instead of clipping it', pane.includes('session allowance: $20.00 — a runaway stop, not a budget') && !paneLines(lines, DETAIL_PANE, DETAIL_PANE_WIDTH).some(line => line.includes('session allowance') && line.endsWith('…')))
  await press(m, KEY.enter, 300)
  check('↵ flips the one switch through the owner: the config file carries jev.enabled true', storedJev()?.enabled === true && setting.jevEnabled() === true, JSON.stringify(storedJev()))
  check('the config file is the only file under the home that carries the switch', filesMentioning('"jev"').length === 1 && filesMentioning('"jev"')[0] === configFile, filesMentioning('"jev"').join(','))
  const after = keepFrame('boot-settings-jev-row-on-178x51', 'the same face after ↵ on the JEV row: the value column on, the status bar carrying the owner\'s receipt, the detail pane now reading no key', m)
  check('the value column now reads on', /❯ JEV\s+on\s/.test(bootJevRow(after)), bootJevRow(after))
  check('the status bar carries the receipt words (JEV on — JevEval joins the roster …)', has(after, 'JEV on — JevEval joins the roster'), after.filter(line => line.includes('System ready')).join(' | '))
  check('the detail pane now reads the resolver\'s no-key words', status.jevStatus().kind === 'no-key' && paneText(after, DETAIL_PANE, DETAIL_PANE_WIDTH).includes(collapse(status.jevStatusLine())), status.jevStatusLine())
  check('boot-env.json never carries the switch (the row is config-backed)', !existsSync(join(HOME, 'boot-env.json')) || !readFileSync(join(HOME, 'boot-env.json'), 'utf8').includes('jev'))
  await press(m, KEY.enter, 300)
  check('a second ↵ flips it back off, the receipt saying nothing is sent', setting.jevEnabled() === false && has(m.lines(), 'nothing is sent'), m.lines().filter(line => line.includes('System ready')).join(' | '))
  await press(m, KEY.enter, 300)
  check('and on again for the next surface', setting.jevEnabled() === true && storedJev()?.enabled === true)
  m.unmount()
  await settle(60)
}

section('§3 /config: the JEV row, its warning, the toggle and the esc-revert (frame c)')
{
  const m = await openConfig()
  const found = await selectMarked(m, `${CONFIG_ROW_MARK} JEV`)
  check('↓ reaches the JEV row', found)
  const lines = keepFrame('config-jev-row-178x51', 'the /config popup at 178x51 with the JEV row selected (on, as the Boot Settings face left it) and its warning: the status line and the setting lines', m)
  const row = lines.find(line => line.includes(`${CONFIG_ROW_MARK} JEV`)) ?? ''
  check('the row reads on — the value written by the Boot Settings face', /JEV\s+on\b/.test(row), row)
  const warning = [status.jevStatusLine(), ...setting.jevSettingLines()].join(' · ')
  check('the warning is the status line and the setting lines, the doors included', popupText(lines).includes(collapse(warning)), warning)
  check('the status words on this surface are the resolver\'s verbatim (no key)', status.jevStatus().kind === 'no-key' && has(lines, 'JEV no key — no TypeSafe API key is stored'))
  await press(m, KEY.right, 250)
  const rowOff = m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} JEV`)) ?? ''
  check('→ flips the switch off at once through the owner (the config file agrees)', /JEV\s+off\b/.test(rowOff) && storedJev() === undefined && setting.jevEnabled() === false, `${rowOff} · ${JSON.stringify(storedJev())}`)
  check('the warning now reads the off words', has(m.lines(), 'JEV off — the JEV switch is off'))
  await press(m, KEY.esc, 300)
  const rowBack = m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} JEV`)) ?? ''
  check('the first esc REVERTS jev to the mount-time snapshot (on) and the popup stays', store.isSettingsPopupOpen() && /JEV\s+on\b/.test(rowBack) && storedJev()?.enabled === true && setting.jevEnabled() === true, `${rowBack} · ${JSON.stringify(storedJev())}`)
  await press(m, KEY.esc, 250)
  check('the second esc closes', !store.isSettingsPopupOpen())
  m.unmount()
  await settle(60)
}

section('§4 /jev on with no key, then the key pasted through the masked entry (frames a2, g)')
{
  const m = await openJev()
  const lines = keepFrame('jev-on-no-key-178x51', '/jev after the Boot Settings face turned the switch on: the honest no-key state, nothing sent', m)
  check('the switch reads on and the status is the resolver\'s no-key words', rowLine(m, 'Switch').trim().endsWith('on') && popupText(lines).includes(collapse(status.jevStatusLine())), rowLine(m, 'Switch'))
  await press(m, KEY.down)
  check('↓ selects the Key row', rowLine(m, 'Key') !== '')
  await press(m, KEY.enter, 250)
  const entry = keepFrame('jev-key-entry-178x51', 'the masked key entry opened from the Key row, nothing typed yet', m)
  check('↵ on the Key row opens the masked entry with its prompt', has(entry, 'input is masked') && has(entry, 'esc cancels'))
  await press(m, KEY.esc, 250)
  check('esc cancels the entry — nothing written, the popup stays', store.isSettingsPopupOpen() && said(m, 'Key entry cancelled — nothing written') && keyOwner.jevKeyPresence().present === false, m.lines().filter(line => line.includes('entry')).join(' | '))
  await press(m, KEY.enter, 250)
  await press(m, PROOF_KEY, 250)
  check('the typed value is masked on screen (never the whole key)', !m.screen().includes(PROOF_KEY))
  await press(m, KEY.enter, 350)
  check('↵ stores the key through storeJevApiKey: the store holds it', secrets.readStoredTypesafeApiKey() === PROOF_KEY)
  check('the receipt names the store and the clear road, never the value', said(m, `TypeSafe API key stored (auth-scoped, mode 600): ${secrets.providerSecretsPathForDisplay()}`) && said(m, '⌫ on the Key row clears it') && !m.screen().includes(PROOF_KEY), m.lines().filter(line => line.includes('stored')).join(' | '))
  check('the Key row now reads the owner\'s stored words', /Key\s+key stored \(the credential store; the value is never shown\)/.test(rowLine(m, 'Key')), rowLine(m, 'Key'))
  check('the status is ready', status.jevStatus().kind === 'ready' && has(m.lines(), 'JEV ready'))
  check('only the secrets file holds the key (no sign-in, no second store)', filesMentioning(PROOF_KEY).length === 1 && filesMentioning(PROOF_KEY)[0] === secrets.providerSecretsPathForDisplay(), filesMentioning(PROOF_KEY).join(','))
  await closePopup(m)
}

section('§5 /jev on with a stored key and spend on the ledger (frame b); a refused value (frame e)')
{
  const T0 = Date.UTC(2026, 0, 15, 14, 30)
  ledger.resetJevLedger()
  ledger.noteJevAttempt(T0)
  ledger.settleJevCall({ input_tokens: 4000, output_tokens: 0 }, 'jev-1.13.0', T0)
  ledger.noteJevAttempt(T0 + 1000)
  ledger.settleJevCall({ input_tokens: 6000, output_tokens: 0 }, 'jev-1.13.0', T0 + 1000)
  ledger.noteJevAttempt(T0 + 2000)
  ledger.noteJevWireFailure({ kind: 'parse-failed', status: 200, detail: 'not json' }, T0 + 2000, () => 0.5)
  const snap = ledger.jevLedgerSnapshot()
  const m = await openJev()
  const lines = keepFrame('jev-on-key-spend-178x51', '/jev with the switch on, a key stored and spend on the ledger (two answered calls, one unconfirmed charge): the Spend row with Mercury\'s count, the last answer and the served model', m)
  const spendWords = jevBody.jevSpendWords(snap)
  check('the Spend row is the ledger\'s figures: $0.003108 · 2 calls · 1 unconfirmed', spendWords === `spend so far: ${contract.jevUsdLabel(snap.spendUsd)} · 2 calls · 1 unconfirmed` && contract.jevUsdLabel(snap.spendUsd) === '$0.003108' && has(lines, spendWords), spendWords)
  check('the last answer and the served model are on the row', has(lines, `last answered ${contract.jevClockLabel(T0 + 1000)} · jev-1.13.0`))
  check('the row is labelled Mercury\'s count — the provider publishes no balance', has(lines, jevBody.JEV_SPEND_LABEL))
  check('the status is ready and the context line carries the spend against the allowance', has(lines, 'JEV ready') && has(lines, `spend ${contract.jevUsdLabel(snap.spendUsd)} of the $20.00 allowance`))
  await press(m, KEY.down)
  await press(m, KEY.down)
  await press(m, KEY.down)
  check('↓↓↓ selects the Allowance row', rowLine(m, 'Allowance') !== '', m.lines().filter(line => line.includes(jevRowMark)).join(' | '))
  await press(m, KEY.enter, 250)
  check('↵ opens the typed entry for the allowance', has(m.lines(), 'Type the session allowance in dollars (now $20.00)'))
  await press(m, '-')
  await press(m, '3')
  await press(m, KEY.enter, 350)
  const refused = keepFrame('jev-refused-178x51', '/jev after a typed allowance of -3: the setter refused it and the message is painted; nothing was written', m)
  check('the setter\'s refusal is painted verbatim', popupText(refused).includes('the JEV session allowance is a positive dollar amount, not -3'), refused.filter(line => line.includes('allowance')).join(' | '))
  check('nothing landed: the allowance is still the default and the file carries no allowance', setting.readJevSettings().allowanceUsd === 20 && storedJev()?.allowanceUsd === undefined, JSON.stringify(storedJev()))
  await press(m, KEY.enter, 250)
  await press(m, 'a')
  await press(m, 'b')
  await press(m, 'c')
  await press(m, KEY.enter, 350)
  check('a non-number is refused with the typed text named', said(m, 'the JEV session allowance is a positive dollar amount, not "abc"'), m.lines().filter(line => line.includes('allowance')).join(' | '))
  await press(m, KEY.right, 250)
  check('→ walks the allowance to the next rung ($50.00) through the owner', setting.readJevSettings().allowanceUsd === 50 && storedJev()?.allowanceUsd === 50 && said(m, 'session allowance: $50.00'), JSON.stringify(storedJev()))
  await press(m, BACKSPACE, 250)
  check('⌫ returns the allowance to its default (not stored)', setting.readJevSettings().allowanceUsd === 20 && storedJev()?.allowanceUsd === undefined)
  await press(m, KEY.down)
  await press(m, KEY.right, 250)
  check('→ on Pace moves it by one (11)', setting.readJevSettings().pacePerMinute === 11 && storedJev()?.pacePerMinute === 11 && said(m, 'pace: 11 requests a minute'))
  await press(m, KEY.left, 250)
  check('← returns it to 10, which is not stored', setting.readJevSettings().pacePerMinute === 10 && storedJev()?.pacePerMinute === undefined)
  await press(m, KEY.down)
  await press(m, KEY.right, 250)
  check('→ on the ceiling turns off into the first rung (10 requests a session)', setting.readJevSettings().requestCeiling === 10 && /Request ceiling\s+10 requests a session/.test(rowLine(m, 'Request ceiling')), rowLine(m, 'Request ceiling'))
  await press(m, KEY.left, 250)
  check('← from the first rung is off again', setting.readJevSettings().requestCeiling === null && storedJev()?.requestCeiling === undefined)
  await press(m, KEY.enter, 250)
  await press(m, '4')
  await press(m, '0')
  await press(m, KEY.enter, 350)
  check('a typed ceiling of 40 lands', setting.readJevSettings().requestCeiling === 40 && storedJev()?.requestCeiling === 40, JSON.stringify(storedJev()))
  await press(m, KEY.enter, 250)
  await press(m, 'o')
  await press(m, 'f')
  await press(m, 'f')
  await press(m, KEY.enter, 350)
  check('a typed off clears it', setting.readJevSettings().requestCeiling === null && storedJev()?.requestCeiling === undefined)
  await press(m, KEY.down)
  await press(m, KEY.enter, 250)
  check('↵ on Sub-agents turns them on, the words naming the 2-call budget on the same allowance', setting.readJevSettings().subagents === true && /Sub-agents\s+on — 2 calls each, on the same allowance/.test(rowLine(m, 'Sub-agents')), rowLine(m, 'Sub-agents'))
  await press(m, BACKSPACE, 250)
  check('⌫ turns them off again (not stored)', setting.readJevSettings().subagents === false && storedJev()?.subagents === undefined)
  for (let i = 0; i < 6; i++) await press(m, KEY.up, 60)
  await press(m, KEY.enter, 300)
  check('↵ on the Switch row turns JEV off; the receipt says nothing is sent', setting.jevEnabled() === false && said(m, setting.jevReceiptWords(setting.readJevSettings())) && said(m, status.jevStatusLine()), m.lines().filter(line => line.includes('JEV off')).join(' | '))
  check('every other setting at its default, the whole jev key leaves the file (one store, nothing stale)', storedJev() === undefined, JSON.stringify(storedJev()))
  await press(m, KEY.down)
  await press(m, BACKSPACE, 300)
  check('⌫ on the Key row clears the stored key and says so', secrets.readStoredTypesafeApiKey() === undefined && keyOwner.jevKeyPresence().present === false && said(m, `stored TypeSafe API key cleared from ${secrets.providerSecretsPathForDisplay()}`), m.lines().filter(line => line.includes('clear')).join(' | '))
  check('no file under the home still carries the proof key', filesMentioning(PROOF_KEY).length === 0, filesMentioning(PROOF_KEY).join(','))
  await closePopup(m)
  ledger.resetJevLedger()
}

section('§6 the other doors read the /jev switch-off; the inline popup (frame f)')
{
  const m = await openConfig()
  await selectMarked(m, `${CONFIG_ROW_MARK} JEV`)
  const row = m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} JEV`)) ?? ''
  check('/config reads off after /jev turned it off, with the off words', /JEV\s+off\b/.test(row) && has(m.lines(), 'JEV off — the JEV switch is off'), row)
  await press(m, KEY.esc, 250)
  m.unmount()
  await settle(60)
  const boot = await openBootFace()
  await selectMarked(boot, '❯ JEV')
  check('the Boot Settings face reads off too', /❯ JEV\s+off\s/.test(bootJevRow(boot.lines())), bootJevRow(boot.lines()))
  boot.unmount()
  await settle(60)
  const inline = await openJev(false)
  const lines = keepFrame('jev-inline-178x51', '/jev on the sequential (non-fullscreen) road: the same popup painted in the flow (FullscreenLayout mounts SettingsPopupSlot overlay=false there)', inline)
  check('the inline road paints the same popup with the same words', has(lines, 'Mercury · jev') && popupText(lines).includes(collapse(status.jevStatusLine())) && has(lines, setting.JEV_DOORS))
  await closePopup(inline)
}

section('§7 the laws over every frame and every file')
{
  check('every frame fits 178 columns and 51 rows', frames.every(frame => frame.lines.length <= ROWS && frame.lines.every(line => stringWidth(line) <= COLS)), frames.map(frame => `${frame.name}:${frame.lines.length}x${Math.max(...frame.lines.map(line => stringWidth(line)))}`).join(' '))
  check('the key value appears in no frame', frames.every(frame => !frame.lines.join('\n').includes(PROOF_KEY)))
  check('no frame says experimental', frames.every(frame => !/experimental/i.test(frame.lines.join('\n'))))
  check('no frame reports a render error', frames.every(frame => !frame.lines.join('\n').includes('RENDER ERROR')))
  const own = ['src/components/Settings/Jev.tsx', 'src/commands/jev/index.ts', 'src/commands/jev/jev.tsx', 'src/components/BootSettingsScreen.tsx', 'src/components/Settings/Config.tsx']
  check('no owned file says experimental', own.every(rel => !/experimental/i.test(readFileSync(join(REPO, rel), 'utf8'))))
  const jevSrc = readFileSync(join(REPO, 'src/components/Settings/Jev.tsx'), 'utf8')
  check('the /jev body never reads the key value: only presence, words and the store door', !jevSrc.includes('readStoredTypesafeApiKey') && !jevSrc.includes('resolveJevApiKey') && jevSrc.includes('storeJevApiKey(') && jevSrc.includes('jevKeySourceWords('))
  check('the /jev body holds no copy of a setting: every fact is read from the owner on each render', jevSrc.includes('const facts = jevFacts()') && !/useState<JevSettings>/.test(jevSrc))
  const boot = readFileSync(join(REPO, 'src/components/BootSettingsScreen.tsx'), 'utf8')
  check('the Boot Settings face reads and writes through the owner (the Motion precedent)', boot.includes('withJevRow(STARTUP_MENU)') && boot.includes('isJevRow') && boot.includes('setJevEnabled(next)') && boot.includes('jevReceiptWords(settings)') && boot.includes('jevValueWords(jevSettings)') && boot.includes('jevStatusLine()') && boot.includes('jevSettingLines(settings)'))
  check('the Boot Settings face keeps the Seats and Motion rows exactly where the motion pin reads them', /SEATS_MENU_ROW as MenuRow, MOTION_MENU_ROW as MenuRow\]/.test(boot))
  const config = readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the /config row is the Motion construction: the owner\'s words, the owner\'s writer, the touched key for the esc-revert', config.includes("id: 'jev'") && config.includes('jevValueWords(jevSettings)') && config.includes('setJevEnabled(next)') && config.includes("globalTouchedRef.current.add('jev')") && config.includes('jevStatusLine()'))
  check('no second writer of the jev key outside the owner', ['src/components/Settings/Jev.tsx', 'src/components/BootSettingsScreen.tsx', 'src/components/Settings/Config.tsx', 'src/commands/jev/jev.tsx'].every(rel => !/saveGlobalConfig\([^)]*jev/.test(readFileSync(join(REPO, rel), 'utf8'))))
  const layout = readFileSync(join(REPO, 'src/components/FullscreenLayout.tsx'), 'utf8')
  check('the popup host mounts on both roads, so /jev is never a dead command inline', layout.includes('<SettingsPopupSlot overlay={false} />') && layout.includes('<SettingsPopupSlot overlay={true} />'))
}

if (frameDir !== undefined) {
  const index = ['Source renders of the three JEV surfaces at a 178x51 terminal (the ink renderer replayed through the ANSI emulator; no PTY, no build, no product boot). One file per state.', ...frames.map(frame => `${frame.name}.txt | ${frame.note}`)]
  writeFileSync(join(frameDir, 'index.txt'), index.join('\n') + '\n')
  console.log(`\nframes: ${frames.length} written to ${frameDir}`)
}
cap._setHeldMachineSeatReadingForTesting(null)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jev-faces: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
