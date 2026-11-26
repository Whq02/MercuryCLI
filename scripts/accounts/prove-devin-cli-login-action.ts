#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-devin-cli-action-'))
const configHome = join(scratch, 'config')
const homeDir = join(scratch, 'home')
const xdgData = join(scratch, 'xdg-data')
const xdgConfig = join(scratch, 'xdg-config')
const fakeBin = join(scratch, 'fake-bin')
const emptyBin = join(scratch, 'empty-bin')
const logFile = join(scratch, 'invocations.jsonl')
mkdirSync(configHome, { recursive: true })
mkdirSync(homeDir, { recursive: true })
mkdirSync(join(xdgData, 'devin'), { recursive: true })
mkdirSync(xdgConfig, { recursive: true })
mkdirSync(fakeBin, { recursive: true })
mkdirSync(emptyBin, { recursive: true })

const DECOY_SECRET = 'devin-session-token$synthetic-decoy-99999'
writeFileSync(join(xdgData, 'devin', 'credentials.toml'), `windsurf_api_key = "${DECOY_SECRET}"\n`, 'utf8')

const stubPath = join(fakeBin, 'devin')
const stubSource = `#!/bin/sh
printf '{"argv":["%s","%s"]}\\n' "$1" "$2" >> "${logFile}"
exit 0
`
writeFileSync(stubPath, stubSource, 'utf8')
chmodSync(stubPath, 0o755)

const baseSystemPath = ['/usr/bin', '/bin'].filter(dir => existsSync(dir)).join(delimiter)
const withStubPath = `${fakeBin}${delimiter}${baseSystemPath}`
const withoutStubPath = `${emptyBin}${delimiter}${baseSystemPath}`

process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.HOME = homeDir
process.env.USERPROFILE = homeDir
process.env.XDG_DATA_HOME = xdgData
process.env.XDG_CONFIG_HOME = xdgConfig
process.env.TMPDIR = scratch
process.env.PATH = withStubPath
process.env.FORCE_COLOR = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_CLIPBOARD_FILE = join(scratch, 'clipboard.txt')
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN|WINDSURF_API_KEY)$/.test(name)) {
    delete process.env[name]
  }
}
process.env.ANTHROPIC_API_KEY = 'sk-ant-synthetic-mercury-only-0000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

function readInvocations(): Array<{ argv: string[] }> {
  if (!existsSync(logFile)) return []
  const raw = readFileSync(logFile, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map(line => JSON.parse(line) as { argv: string[] })
}

function clearInvocations(): void {
  writeFileSync(logFile, '', 'utf8')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

import type { Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/screen/themedRenderer.js'
import type { LocalJSXCommandContext } from '../../src/commands/catalogue/command.js'

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { KEY, mountOffscreen, painted, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { PopupHost } = await import('../../src/screen/overlays/PopupHost.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const { ScrollKeybindingHandler } = await import('../../src/screen/scroll-keys/ScrollKeybindingHandler.js')
const popupStore = await import('../../src/screen/cockpit/settingsPopup.js')
const { call: openLoginsPopup, parseFamilyFocus } = await import('../../src/commands/logins/login.js')
const { loginFamilyRows } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.js')
const { BootLoginsScreen, collectLoginsScreenFacts, loginsCatalogue, loginsFamilyCounts } = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { PROVIDER_ID_SPACES } = await import('../../src/models/roads/routeLaw.js')
const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.js')
const { deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.js')
const { SIGN_IN_WORDS } = await import('../../src/boot/first-run/Onboarding.js')
const { providerAuthList } = await import('../../src/commands/verbs/providerAuth.js')
const { devinCliInstallHint, runDevinCliAction } = await import('../../src/screen/boot-face/logins/devinCliAction.js')

async function send(m: Mounted, data: string): Promise<void> {
  m.push(data)
  await painted(60)
}

try {
  console.log('§1 — PROVIDER COUNT & NEGATIVE IDENTITY INVARIANTS')
  {
    const defaultRows = loginFamilyRows({ engineLegs: true })
    const catalogue = loginsCatalogue()
    const counts = loginsFamilyCounts(deriveFamilySlotGroups())
    const usability = resolveProviderUsability()
    const providerIds = PROVIDER_ID_SPACES.map(space => space.route)
    const authRows = (await providerAuthList({ json: false }, { writeOut: () => {}, writeErr: () => {} })).rows
    check('model provider catalogue stays at 22 families with no Devin provider id', catalogue.length === 22 && counts.familyIds.length === 22 && defaultRows.length === 22 && !providerIds.some(id => id.includes('devin')) && !Object.keys(usability).some(id => id.includes('devin')), `catalogue=${catalogue.length} counts=${counts.familyIds.length} defaultRows=${defaultRows.length}`)
    check('Onboarding intro and terminal providerAuthList exclude Devin external agent', !SIGN_IN_WORDS.intro.includes('Devin') && !authRows.some(row => row.id.includes('devin') || row.name.includes('Devin')))
    check('zero child invocations from importing/collecting provider facts', readInvocations().length === 0, `invocations=${readInvocations().length}`)
  }

  console.log('§2 — BOOT LOGINS/KEYS SCREEN (Devin CLI external agent door, zero auto-run, logout confirm, missing binary)')
  {
    clearInvocations()
    let closedCount = 0
    let signedInCount = 0
    const facts = collectLoginsScreenFacts()
    const el = h(AppStateProvider, {
      children: h(ThemeProvider, {
        children: h(KeybindingSetup, {
          children: h(
            Box,
            { width: 120, height: 42, flexDirection: 'column' },
            h(BootLoginsScreen, {
              facts,
              fullScene: { columns: 120, rows: 42 },
              onClose: () => { closedCount++ },
              onSignedIn: () => { signedInCount++ },
            }),
          ),
        }),
      }),
    })
    const m = await mountOffscreen(el, 120, 42)
    const rosterUp = await waitFor(() => m.screen().includes('Families') && m.screen().includes('22'), 1500)
    check('Boot Logins keeps Families at 22 while zero child runs on mount', rosterUp && readInvocations().length === 0, `invocations=${readInvocations().length}`)

    await send(m, '\x1b[F')
    await waitFor(() => m.screen().includes('Devin CLI (external agent)'), 1500)
    const focusedFrame = m.screen()
    check('Boot Logins shows Devin CLI (external agent) row at bottom under external agents', focusedFrame.includes('Devin CLI (external agent)') && focusedFrame.includes('/crew attach devin') && !focusedFrame.includes(DECOY_SECRET))
    check('navigating and focusing Devin CLI triggers zero child invocations', readInvocations().length === 0)

    await send(m, KEY.enter)
    const menuReady = await waitFor(() => m.screen().includes('devin auth login') && m.screen().includes('devin auth status') && m.screen().includes('devin auth logout'), 1500)
    check('Enter opens distinct operator choices (login, status, logout) with zero child invocations', menuReady && readInvocations().length === 0)

    await send(m, KEY.esc)
    const backOnRoster = await waitFor(() => m.screen().includes('Families'), 1500)
    check('Esc returns to Boot Logins roster without closing or spawning', backOnRoster && closedCount === 0 && readInvocations().length === 0)

    await send(m, KEY.enter)
    await waitFor(() => m.screen().includes('devin auth logout'), 1500)
    await send(m, KEY.down)
    await send(m, KEY.down)
    await send(m, KEY.enter)
    const confirmShown = await waitFor(() => m.screen().includes('Confirm sign out'), 1500)
    check('destructive logout asks confirmation first and runs zero children before confirmation', confirmShown && readInvocations().length === 0)

    await send(m, KEY.enter)
    const backToDevinMenu = await waitFor(() => m.screen().includes('devin auth login'), 1500)
    check('declining logout confirmation keeps credentials untouched (zero logout invocations)', backToDevinMenu && readInvocations().length === 0)

    process.env.PATH = withoutStubPath
    await send(m, KEY.enter)
    const missingShown = await waitFor(() => m.screen().includes('cli.devin.ai/install.sh') || m.screen().includes('static.devin.ai/cli/setup.ps1'), 2000)
    check('missing devin binary shows official vendor install line and spawns nothing', missingShown && readInvocations().length === 0)
    await send(m, KEY.enter)
    await waitFor(() => m.screen().includes('Families'), 1500)
    check('returning from Devin receipt never fires onSignedIn or closes Boot Logins', signedInCount === 0 && closedCount === 0 && readInvocations().length === 0)

    process.env.PATH = withStubPath
    await send(m, KEY.enter)
    await waitFor(() => m.screen().includes('devin auth status'), 1500)
    await send(m, KEY.down)
    await send(m, KEY.enter)
    const nonTtyRefusal = await waitFor(() => m.screen().includes('interactive terminal'), 2000)
    check('without a real attached terminal, status refuses honestly and spawns nothing in background', nonTtyRefusal && readInvocations().length === 0)
    m.unmount()
  }

  console.log('§3 — CHAT /logins POPUP (SignInFlow + login.tsx)')
  {
    clearInvocations()
    const devinFocus = parseFamilyFocus('devin')
    check('parseFamilyFocus resolves devin to external agent row', devinFocus === 'external/devin', String(devinFocus))

    const receipts: string[] = []
    let keyChanges = 0
    const signedHistory = [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 't', signature: 'sig-1' }, { type: 'text', text: 'ok' }] } }]
    let currentMessages = signedHistory
    const ctx = Object.assign(Object.create(null), {
      onChangeAPIKey() { keyChanges++ },
      setMessages(update: (messages: typeof signedHistory) => typeof signedHistory) { currentMessages = update(currentMessages) },
      getAppState: () => ({}),
      setAppState() {},
    }) as LocalJSXCommandContext

    const hostRef = React.createRef<DOMElement>()
    const el = h(AppStateProvider, {
      children: h(ThemeProvider, {
        children: h(KeybindingSetup, {
          children: h(
            Box,
            { width: 120, height: 40, flexDirection: 'column' },
            h(Box, { ref: hostRef, height: 40, flexDirection: 'column' }, h(Text, {}, 'CHAT')),
            h(ScrollKeybindingHandler, { isActive: true, scrollRef: { current: null } }),
            h(PopupHost, { hostRef, children: host => h(SettingsPopupSlot, { host, overlay: true }) }),
          ),
        }),
      }),
    })
    const m = await mountOffscreen(el, 120, 40)
    await settle(60)
    await openLoginsPopup(receipt => { receipts.push(receipt ?? '') }, ctx, 'devin')
    const popupUp = await waitFor(() => m.screen().includes('Devin CLI (external agent)'), 3000)
    check('/logins devin opens popup focused on Devin CLI (external agent) with zero child runs', popupUp && m.screen().includes('❯ Devin CLI (external agent)') && readInvocations().length === 0)

    await send(m, KEY.enter)
    const cardUp = await waitFor(() => m.screen().includes('devin auth login') && m.screen().includes('devin auth status') && m.screen().includes('devin auth logout'), 2000)
    check('/logins Devin CLI card lists all three distinct actions with zero child runs', cardUp && readInvocations().length === 0)

    await send(m, KEY.down)
    await send(m, KEY.down)
    await send(m, KEY.enter)
    const chatConfirm = await waitFor(() => m.screen().includes('Confirm sign out'), 1500)
    check('/logins destructive logout asks confirmation first and runs zero children', chatConfirm && readInvocations().length === 0)
    await send(m, KEY.enter)
    await waitFor(() => m.screen().includes('devin auth login'), 1500)

    process.env.PATH = withoutStubPath
    await send(m, KEY.enter)
    const missingChat = await waitFor(() => m.screen().includes('cli.devin.ai/install.sh') || m.screen().includes('static.devin.ai/cli/setup.ps1'), 2000)
    check('/logins missing binary shows vendor install line and spawns nothing', missingChat && readInvocations().length === 0)
    process.env.PATH = withStubPath

    await send(m, KEY.enter)
    await waitFor(() => m.screen().includes('devin auth login'), 1500)
    await send(m, KEY.esc)
    await waitFor(() => m.screen().includes('OpenAI — ChatGPT'), 1500)
    await send(m, KEY.esc)
    const closed = await waitFor(() => !popupStore.isSettingsPopupOpen(), 1500)
    check('closing /logins after external CLI action leaves Mercury provider credentials and signed history untouched', closed && keyChanges === 0 && currentMessages === signedHistory && readInvocations().length === 0)
    popupStore.closeSettingsPopup()
    m.unmount()
  }

  console.log('§4 — NON-TTY REFUSAL & PLATFORM INSTALL INSTRUCTIONS')
  {
    clearInvocations()
    const nonTtyIn = { isTTY: false } as NodeJS.ReadStream
    const nonTtyOut = { isTTY: false } as NodeJS.WriteStream
    for (const action of ['login', 'status', 'logout'] as const) {
      const refused = await runDevinCliAction(action, {
        world: { platform: process.platform, path: withStubPath },
        stdin: nonTtyIn,
        stdout: nonTtyOut,
      })
      check(`non-TTY devin auth ${action} refuses honestly and never spawns in background`, refused.kind === 'refused' && refused.ok === false && refused.receipt.includes('interactive terminal') && readInvocations().length === 0, JSON.stringify(refused))
    }
    check('platform install lines match official docs for macOS, Linux and Windows', devinCliInstallHint('darwin').includes('cli.devin.ai/install.sh') && devinCliInstallHint('darwin').includes('brew install --cask devin-cli') && devinCliInstallHint('linux').includes('cli.devin.ai/install.sh') && devinCliInstallHint('win32').includes('static.devin.ai/cli/setup.ps1'))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-devin-cli-login-action: ALL PASS' : `\nprove-devin-cli-login-action: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
