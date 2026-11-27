#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import type { LoginsFlowPaneV1 } from '../../src/screen/boot-face/logins/flowLines.js'
import type { Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/screen/themedRenderer.js'
import type { LocalJSXCommandContext } from '../../src/commands/catalogue/command.js'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-logins-sign-in-small-'))
process.env['MERCURY_CONFIG_DIR'] = scratch
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['FORCE_COLOR'] = '0'
process.env['MERCURY_CRITTER_IDLE'] = '0'
process.env['MERCURY_CRITTER_GAZE'] = '0'
process.env['MERCURY_CRITTER_SLEEP'] = '0'
process.env['MERCURY_LIVE_CLOCK'] = '0'
process.env['MERCURY_LIVE_GLYPHS'] = '0'
process.env['MERCURY_RECESS'] = '0'
process.env['MERCURY_LOCAL_PROBE_TARGETS'] = 'none'
process.env['MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
process.env['BROWSER'] = '/usr/bin/true'
process.env['SSH_CONNECTION'] = '10.0.0.2 50000 10.0.0.1 22'
for (const name of ['TMUX', 'TERM_PROGRAM', 'LC_TERMINAL', 'MERCURY_CLIPBOARD_FILE']) delete process.env[name]
const clipboardFile = join(scratch, 'clipboard.txt')
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN|OAUTH_CLIENT_ID)$/.test(name)) {
    delete process.env[name]
  }
}

const OPENAI_URL =
  'https://auth.openai.example/oauth/authorize?' +
  new URLSearchParams({
    response_type: 'code',
    client_id: 'app_FIXTUREfixtureFIXTUREfix',
    redirect_uri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    code_challenge: 'fixtureChallenge0123456789abcdefghijklmnopq',
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: 'fixtureState0123456789abcdefghijklmnopqrstu',
    originator: 'mercury',
  }).toString()
const OPENROUTER_URL =
  'https://openrouter.example/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fcallback&code_challenge=fixtureChallenge0123456789abcdefghijklmnopq&code_challenge_method=S256'
const GEMINI_URL =
  'https://accounts.google.example/o/oauth2/v2/auth?client_id=fixture-client.apps.googleusercontent.example&redirect_uri=http%3A%2F%2F127.0.0.1%3A8085%2Foauth2callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.example%2Fauth%2Fcloud-platform+openid+email&code_challenge=fixtureChallenge0123456789abcdefghijklmnopq&code_challenge_method=S256&access_type=offline&prompt=consent&state=fixtureState0123456789abcdef'
const CLAUDE_URL =
  'https://claude.example/oauth/authorize?code=true&client_id=fixture-0000-1111-2222-333344445555&response_type=code&redirect_uri=https%3A%2F%2Fconsole.example%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=fixtureChallenge0123456789abcdefghijklmnopq&code_challenge_method=S256&state=fixtureState0123456789abcdefghijklmnopqrstu'
const DEVICE_URL = 'https://signin.example/device/verify?user_code=FIXT-CODE&client=fixture-client-0123456789abcdefghijklmnopqrstuvwxyz'
const DEVICE_CODE = 'FIXT-CODE'
const OPENAI_DEVICE_CODE = 'FIXT-12345'
const OPENAI_DEVICE_HINT = 'Open https://auth.openai.example/codex/device and enter the code.'

const never = <T,>(): Promise<T> => new Promise<T>(() => {})
const handlesOf = (authorizeUrl: string) => () => ({ authorizeUrl, result: never(), completeWithRedirect: () => {}, cancel: () => {}, boundLoopbackPort: () => undefined })
const deviceRun = async (opts: { onEvent: (event: unknown) => void }): Promise<never> => {
  opts.onEvent({ phase: 'waiting', start: { userCode: DEVICE_CODE, verificationUri: DEVICE_URL, expiresAtMs: Date.now() + 600_000 }, polls: 0 })
  return never()
}

const openaiAccounts = await import('../../src/models/roads/openai/openaiAccounts.js')
const openrouterAccounts = await import('../../src/models/roads/openrouter/openrouterAccounts.js')
const geminiAccounts = await import('../../src/models/roads/gemini/geminiAccounts.js')
const xaiLogin = await import('../../src/models/roads/xai/xaiLogin.js')
const metaLogin = await import('../../src/models/roads/meta/metaLogin.js')
const nousLogin = await import('../../src/models/roads/nous/nousLogin.js')
const orcarouterLogin = await import('../../src/models/roads/orcarouter/orcarouterLogin.js')
const kimiLogin = await import('../../src/models/roads/moonshot/moonshotLogin.js')
const hfLogin = await import('../../src/models/roads/huggingface/huggingfaceLogin.js')
let openaiUrl = OPENAI_URL
mock.module('../../src/models/roads/openai/openaiAccounts.js', () => ({
  ...openaiAccounts,
  beginOpenaiBrowserConnect: () => handlesOf(openaiUrl)(),
  beginOpenaiDeviceConnect: async () => ({ userCode: OPENAI_DEVICE_CODE, verifyHint: OPENAI_DEVICE_HINT, result: never() }),
}))
mock.module('../../src/models/roads/openrouter/openrouterAccounts.js', () => ({ ...openrouterAccounts, beginOpenrouterConnect: handlesOf(OPENROUTER_URL) }))
mock.module('../../src/models/roads/gemini/geminiAccounts.js', () => ({ ...geminiAccounts, beginGeminiBrowserConnect: handlesOf(GEMINI_URL), beginGeminiPlanBrowserConnect: handlesOf(GEMINI_URL) }))
mock.module('../../src/models/roads/xai/xaiLogin.js', () => ({ ...xaiLogin, runXaiDeviceLogin: deviceRun }))
mock.module('../../src/models/roads/meta/metaLogin.js', () => ({ ...metaLogin, runMetaDeviceLogin: deviceRun }))
mock.module('../../src/models/roads/nous/nousLogin.js', () => ({ ...nousLogin, runNousDeviceLogin: deviceRun }))
mock.module('../../src/models/roads/orcarouter/orcarouterLogin.js', () => ({ ...orcarouterLogin, runOrcarouterDeviceLogin: deviceRun }))
mock.module('../../src/models/roads/moonshot/moonshotLogin.js', () => ({ ...kimiLogin, runKimiDeviceLogin: deviceRun }))
mock.module('../../src/models/roads/huggingface/huggingfaceLogin.js', () => ({ ...hfLogin, runHuggingfaceDeviceLogin: deviceRun }))
mock.module('../../src/platform/host-os/browser.js', () => ({ openBrowser: async () => false, openPath: async () => false }))
const lentTerminal: null | typeof import('../../src/screen/boot-face/logins/lentTerminal.js') = await import('../../src/screen/boot-face/logins/lentTerminal.js').catch(() => null)
const shown: string[] = []
let lineStreams: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } | null = null
const realLentTerminal = lentTerminal === null ? null : { ...lentTerminal }
if (realLentTerminal !== null) {
  mock.module('../../src/screen/boot-face/logins/lentTerminal.js', () => ({
    ...realLentTerminal,
    showSignInAddressLine: async (address: string) => {
      shown.push(address)
      return lineStreams === null ? true : realLentTerminal.showSignInAddressLine(address, lineStreams)
    },
  }))
}

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { KEY, mountOffscreen, painted, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { AlternateScreen } = await import('../../src/screen/renderer/elements/AlternateScreen.js')
const { isMouseTrackingEnabled } = await import('../../src/screen/fullscreen-layout/fullscreen.js')
const { default: screenInstances } = await import('../../src/screen/renderer/instances.js')
const { PopupHost } = await import('../../src/screen/overlays/PopupHost.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const { ScrollKeybindingHandler } = await import('../../src/screen/scroll-keys/ScrollKeybindingHandler.js')
const popupStore = await import('../../src/screen/cockpit/settingsPopup.js')
const { call: openLoginsPopup } = await import('../../src/commands/logins/login.js')
const { setClipboardWithReceipt, subscribeClipboardReceipts } = await import('../../src/screen/renderer/termio/osc.js')
let receipts = 0
subscribeClipboardReceipts(() => {
  receipts++
})
const { waitingCard } = await import('../../src/models/sign-in/flow-cards/flowCards.js')
const { useMercuryTokens } = await import('../../src/screen/widgets/useMercuryTokens.js')
const { anthropicFlowPaneLines } = await import('../../src/screen/boot-face/logins/anthropicLines.js')
const signInCopy: null | typeof import('../../src/models/sign-in/signInCopy.js') = await import('../../src/models/sign-in/signInCopy.js').catch(() => null)
const { BootLoginsScreen, collectLoginsScreenFacts, loginsMenuModelOf } = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { loginsFlowPaneLines } = await import('../../src/screen/boot-face/logins/flowLines.js')
const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')

const FIX_PANE = 'src/screen/boot-face/logins/menuModel.ts marks a waiting sign-in must-read-whole and hands the composer loginsFlowNoticeOf(flow) as detailOverrideWhole; assets/splash/splash-core.mjs paints those words in the block and leaves the wide layout where the pane still does not fit'
const FIX_FLOOR = 'src/screen/boot-face/logins/menuModel.ts hands the composer detailOverrideWholeElse (loginsFlowNoticeWhereCutOf) while the unconfirmed sentence stands; composeBootMenuClassic in assets/splash/splash-core.mjs then lets the notice take the list rows it needs and paints those words where the address still does not fit; the other ending is signInCopyNoteWhereCut in src/models/sign-in/signInCopy.ts'
const FIX_LINE = 'src/screen/boot-face/logins/lentTerminal.ts: showSignInAddressLine lends the terminal (lendTerminal), writes the address alone on its line and waits for Enter or Esc by a listener the renderer owns (returnPressedWhileLent in src/screen/renderer/instance/stdin.ts), never by a blocking read, and never lends a terminal already lent; flowKeys.ts, SignInFlow.tsx and SignInCopyLine.tsx call it on a second c; BootLoginsScreen.tsx claims a press on a row that holds the address (loginsAddressRows): a drag from it copies by copyFlowAddress in flowKeys.ts, never by the keys, and a click (isClickSlop of the press and the release, the test every screen asks) does nothing; a resize while the line is up writes it again'
const FIX_COPY = 'src/models/sign-in/signInCopy.ts decides what c may say (signInCopyAnswerOf) and words it; boot-face/logins/flowKeys.ts, widgets/faces/anthropicLoginModel.ts and flow-cards/SignInCopyLine.tsx read it, and SignInCopyLine and BootLoginsScreen hand the mouse back while the sentence stands'
let fix = FIX_PANE
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail} | fix: ${fix}` : ''}`)
}

const rowsOf = (frame: string): string[] => frame.split('\n').map(row => row.replace(/[│╭╮╰╯]/g, ' ').trim())
const joined = (frame: string): string => rowsOf(frame).join('')
const words = (frame: string): string => rowsOf(frame).filter(Boolean).join(' ').replace(/\s+/g, ' ')
const cursorRow = (frame: string): string => frame.split('\n').find(row => row.includes('❯')) ?? ''
const paneWords = (frame: string): string =>
  frame
    .split('\n')
    .map(row => (row.includes('│') ? row.slice(row.lastIndexOf('│') + 1) : row).trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
const SMALL: ReadonlyArray<readonly [number, number]> = [[80, 24], [100, 30]]
const SENT = 'sent to your terminal — if nothing pastes,'
const AGAIN = 'press c again for the URL on one line'
const SENT_URL = `${SENT} ${AGAIN}`
const SENT_CODE = `${SENT} select the code above`
const NOTHING_URL = `nothing copied — ${AGAIN}`
const MOUSE_ON = '\x1b[?1000h'
const MOUSE_OFF = '\x1b[?1000l'
type ClipboardRoad = 'unconfirmed' | 'no-road' | 'confirmed'
function takeRoad(road: ClipboardRoad): void {
  rmSync(clipboardFile, { force: true })
  delete process.env['MERCURY_CLIPBOARD_FILE']
  delete process.env['TERM_PROGRAM']
  if (road === 'confirmed') process.env['MERCURY_CLIPBOARD_FILE'] = clipboardFile
  if (road === 'no-road') process.env['TERM_PROGRAM'] = 'Apple_Terminal'
}
const clipboardHeld = (): string => (existsSync(clipboardFile) ? readFileSync(clipboardFile, 'utf8') : '')
const screenOf = (): { on: () => boolean; bytes: () => string } => {
  const ink = [...screenInstances.values()].at(-1) as unknown as { isMouseTrackingEnabled(): boolean; options: { stdout: { writes: string[] } } }
  return { on: () => ink.isMouseTrackingEnabled(), bytes: () => ink.options.stdout.writes.join('') }
}
const lastMouseWrite = (bytes: string): 'on' | 'off' | 'none' => {
  const on = bytes.lastIndexOf(MOUSE_ON)
  const off = bytes.lastIndexOf(MOUSE_OFF)
  return on === -1 && off === -1 ? 'none' : on > off ? 'on' : 'off'
}
const PANE_W = 38
const holdsAddress = (frame: string, url: string): boolean => {
  if (joined(frame).includes(url)) return true
  const paneRows: string[] = []
  for (let at = 0; at < url.length; at += PANE_W) paneRows.push(url.slice(at, at + PANE_W))
  return paneRows.every(row => frame.includes(row))
}
const uncut = (frame: string, tail: string): boolean => !frame.includes('taller terminal') && frame.replace(/\s+/g, ' ').includes(tail)

type Road = { id: string; family: string; picks: RegExp[]; then?: string; says: string[]; tail: string; url?: string; code?: string }
const ROADS: Road[] = [
  { id: 'ChatGPT browser sign-in', family: 'openai', picks: [/browser sign-in/], says: ['Finish signing in in the browser.', 'If nothing opened, visit:', 'paste:'], tail: 'paste: ▌', url: OPENAI_URL },
  { id: 'ChatGPT device code', family: 'openai', picks: [/browser sign-in/], then: 'd', says: ['enter this one-time code:', OPENAI_DEVICE_HINT, 'Waiting for approval'], tail: 'c copies the code', code: OPENAI_DEVICE_CODE },
  { id: 'OpenRouter browser sign-in', family: 'openrouter', picks: [/Sign in with the browser/], says: ['Finish signing in in the browser.', 'If nothing opened, visit:'], tail: 'paste: ▌', url: OPENROUTER_URL },
  { id: 'OpenRouter headless', family: 'openrouter', picks: [/Headless/], says: ['Open this URL on any signed-in browser', 'URL:', 'code:'], tail: 'code: ▌', url: OPENROUTER_URL },
  { id: 'Gemini plan sign-in', family: 'gemini', picks: [/Sign in with Google/], says: ['If nothing opened, visit:', 'paste:'], tail: 'paste: ▌', url: GEMINI_URL },
  { id: 'Kimi device code', family: 'moonshot', picks: [/Sign in with Kimi/, /Global/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
  { id: 'Hugging Face device code', family: 'huggingface', picks: [/Sign in/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
  { id: 'Grok device code', family: 'xai', picks: [/Sign in with your Grok account/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
  { id: 'Nous Portal device code', family: 'nous', picks: [/Sign in with your Nous Portal account/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
  { id: 'OrcaRouter device code', family: 'orcarouter', picks: [/Sign in with your OrcaRouter account/], says: ['On the sign-in page, enter this code:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
  { id: 'Meta device code', family: 'meta', picks: [/Sign in with Meta/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
]
const holds = (frame: string, road: Road): boolean =>
  road.says.every(sentence => words(frame).includes(sentence)) && (road.url === undefined || joined(frame).includes(road.url)) && (road.code === undefined || frame.includes(road.code))

try {
  const facts = collectLoginsScreenFacts()

  console.log('§1 — THE MOUNTED BOOT LOGINS SCREEN WITH A SIGN-IN WAITING: 80x24, 100x30, AND A WIDE WINDOW THAT IS NOT TALL (120x30)')
  for (const road of ROADS) {
    for (const [columns, rows] of [...SMALL, [120, 30] as const, [120, 40] as const]) {
      const m = await mountOffscreen(
        h(AppStateProvider, {
          children: h(ThemeProvider, {
            children: h(KeybindingSetup, {
              children: h(Box, { width: columns, height: rows, flexDirection: 'column' }, h(BootLoginsScreen, { facts, family: road.family, fullScene: { columns, rows } })),
            }),
          }),
        }),
        columns,
        rows,
      )
      await waitFor(() => m.screen().includes('logins') && cursorRow(m.screen()) !== '', 2000)
      m.push(KEY.enter)
      await painted(160)
      let reached = true
      for (const want of road.picks) {
        let found = false
        for (let step = 0; step < 8 && !found; step++) {
          if (want.test(cursorRow(m.screen()))) found = true
          else {
            m.push(KEY.down)
            await painted(80)
          }
        }
        reached = reached && found
        if (found) {
          m.push(KEY.enter)
          await painted(160)
        }
      }
      if (road.then !== undefined) {
        m.push(road.then)
        await painted(160)
      }
      const wide = columns >= 120
      const opening = road.says[0]!.split(' ').slice(0, 2).join(' ')
      const whole = (frame: string): boolean => (road.url === undefined || holdsAddress(frame, road.url)) && (road.code === undefined || frame.includes(road.code)) && uncut(frame, road.tail)
      const up = await waitFor(() => (rows === 30 && wide ? whole(m.screen()) : wide ? m.screen().includes(opening) : holds(m.screen(), road)), 2500)
      const frame = m.screen()
      if (wide && rows === 30) {
        check(
          `${road.id} at ${columns}x${rows}: ${road.url !== undefined ? 'the address whole, ' : ''}${road.code !== undefined ? 'the code, ' : ''}the pane's last line, and no cut`,
          reached && up && whole(frame) && cursorRow(frame) !== '',
          words(frame).slice(0, 260),
        )
      } else if (wide) {
        check(
          `${road.id} at ${columns}x${rows}: the pane holds the sign-in's words`,
          reached && up && (road.url === undefined || frame.includes(road.url.slice(0, 30))) && (road.code === undefined || frame.includes(road.code)),
          words(frame).slice(0, 260),
        )
      } else {
        check(
          `${road.id} at ${columns}x${rows}: what to do${road.url !== undefined ? ', the address whole' : ''}${road.code !== undefined ? ', the code' : ''}, and the roster still under it`,
          reached && up && holds(frame, road) && cursorRow(frame) !== '' && frame.includes('esc'),
          words(frame).slice(0, 260),
        )
      }
      m.unmount()
    }
  }

  console.log('§2 — EVERY SIGN-IN PANE COMPOSED: WHOLE AT EVERY SIZE FROM 20 ROWS, AND EVERY FRAME THAT WAS WHOLE CELL FOR CELL AS IT WAS')
  {
    const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
    const environment = { model: 'model', critter: 'crab', critterHue: 'crimson', dirBase: 'work', dirTail: '' }
    const frame = (columns: number, rows: number, model: unknown): string => (core.composeBootMenu(columns, rows, model) as { lines: string[] }).lines.map(line => stripAnsi(line)).join('\n')
    const device = (family: 'moonshot' | 'huggingface' | 'xai' | 'nous' | 'orcarouter' | 'meta'): LoginsFlowPaneV1 => ({
      kind: 'device',
      nowMs: 0,
      device: { family, phase: 'waiting', userCode: DEVICE_CODE, verificationUri: DEVICE_URL, expiresAtMs: 600_000, polls: 1, copied: false },
    })
    const handles = (leg: 'openai-browser' | 'openrouter-browser' | 'openrouter-headless' | 'gemini-oauth' | 'gemini-plan', authorizeUrl: string): LoginsFlowPaneV1 => ({
      kind: 'handles',
      draftLen: 0,
      handles: { leg, phase: 'waiting', authorizeUrl, copied: false },
    })
    const panes: Array<{ name: string; flow: LoginsFlowPaneV1; says: string[]; tail: string; url?: string; code?: string }> = [
      {
        name: 'Claude subscription',
        flow: {
          kind: 'anthropic',
          draftLen: 0,
          snap: { flow: { name: 'waiting', url: CLAUDE_URL, loginWithClaudeAi: true, forcedMethod: null }, pastePromptUp: true, noCodeYet: false, browserOpened: null, copied: false, shadowWarning: null, accountLabel: null },
        },
        says: ['Use this URL:', 'Paste code here if prompted:'],
        tail: 'esc cancels the wait',
        url: CLAUDE_URL,
      },
      { name: 'ChatGPT browser', flow: handles('openai-browser', OPENAI_URL), says: ['Finish signing in in the browser.', 'If nothing opened, visit:'], tail: 'paste: ▌', url: OPENAI_URL },
      { name: 'OpenRouter browser', flow: handles('openrouter-browser', OPENROUTER_URL), says: ['If nothing opened, visit:'], tail: 'paste: ▌', url: OPENROUTER_URL },
      { name: 'OpenRouter headless', flow: handles('openrouter-headless', OPENROUTER_URL), says: ['Open this URL on any signed-in browser', 'URL:'], tail: 'code: ▌', url: OPENROUTER_URL },
      { name: 'Gemini own client', flow: handles('gemini-oauth', GEMINI_URL), says: ['If nothing opened, visit:'], tail: 'paste: ▌', url: GEMINI_URL },
      { name: 'Gemini plan', flow: handles('gemini-plan', GEMINI_URL), says: ['If nothing opened, visit:'], tail: 'paste: ▌', url: GEMINI_URL },
      { name: 'ChatGPT device code', flow: { kind: 'opdevice', opdevice: { userCode: OPENAI_DEVICE_CODE, verifyHint: OPENAI_DEVICE_HINT, copied: false } }, says: ['enter this one-time code:', OPENAI_DEVICE_HINT], tail: 'c copies the code', code: OPENAI_DEVICE_CODE },
      ...(['moonshot', 'huggingface', 'xai', 'nous', 'orcarouter', 'meta'] as const).map(family => ({
        name: `${family} device code`,
        flow: device(family),
        says: ['On the sign-in page, enter this code:'],
        tail: 'c copies the URL',
        url: DEVICE_URL,
        code: DEVICE_CODE,
      })),
    ]
    for (const pane of panes) {
      const model = loginsMenuModelOf(facts, { selIdx: 0, environment, flow: pane.flow })
      const readable = (columns: number, rows: number): boolean => {
        const painted = frame(columns, rows, model)
        return pane.says.every(sentence => words(painted).includes(sentence)) && (pane.url === undefined || joined(painted).includes(pane.url)) && (pane.code === undefined || painted.includes(pane.code))
      }
      check(`${pane.name}: what to do, the address whole and the code at 80x24 and at 100x30`, readable(80, 24) && readable(100, 30), words(frame(80, 24, model)).slice(0, 260))
      const whole = (painted: string): boolean => (pane.url === undefined || holdsAddress(painted, pane.url)) && (pane.code === undefined || painted.includes(pane.code)) && uncut(painted, pane.tail)
      const unmarked = { ...model, detailOverrideConfirms: false, detailOverrideWhole: undefined, noticeLine: loginsFlowPaneLines(pane.flow, Number.MAX_SAFE_INTEGER).filter(Boolean).join(' ') }
      const cut: string[] = []
      const moved: string[] = []
      for (const columns of [110, 120, 160]) {
        for (let rows = 20; rows <= 44; rows++) {
          const painted = frame(columns, rows, model)
          if (!whole(painted)) cut.push(`${columns}x${rows}`)
          const before = frame(columns, rows, unmarked)
          if (whole(before) && before !== painted) moved.push(`${columns}x${rows}`)
        }
      }
      check(`${pane.name}: whole at 110, 120 and 160 columns at every height from 20 to 44 rows (the address, the code, the pane's last line, no cut)`, cut.length === 0, `cut at ${cut.slice(0, 12).join(' ')}`)
      check(`${pane.name}: every frame of those 75 that was whole without the mark is cell for cell the same with it`, moved.length === 0 && frame(120, 50, model) === frame(120, 50, unmarked) && frame(120, 50, model).includes(pane.says[0]!.split(' ').slice(0, 2).join(' ')), `moved at ${moved.slice(0, 12).join(' ')}`)
    }

    const waiting = handles('openai-browser', OPENAI_URL)
    const late = 'A sign-in you cancelled earlier has just landed.'
    check(
      'while a sign-in waits, its address keeps the block over a notice that arrives; the notice stands once the sign-in is closed',
      joined(frame(80, 24, loginsMenuModelOf(facts, { selIdx: 0, environment, flow: waiting, notice: late }))).includes(OPENAI_URL) &&
        words(frame(80, 24, loginsMenuModelOf(facts, { selIdx: 0, environment, notice: late }))).includes(late),
    )
    const others: Array<[string, LoginsFlowPaneV1]> = [
      ['a pick', { kind: 'pick', pick: 'openai', pickSel: 0 }],
      ['a key prompt', { kind: 'key', leg: 'gemini-key', note: null, draftLen: 0, storing: false }],
      ['a provider receipt', { kind: 'receipt', receipt: 'fixture receipt', ok: false }],
    ]
    const handed = (flow: LoginsFlowPaneV1): unknown => {
      const model = loginsMenuModelOf(facts, { selIdx: 0, environment, flow }) as { noticeLine?: unknown; detailOverrideWhole?: unknown; detailOverrideConfirms?: unknown }
      return model.noticeLine ?? model.detailOverrideWhole ?? model.detailOverrideConfirms ?? null
    }
    check(
      'a pick, a key prompt and a provider receipt hand the block nothing and are not marked: they paint as before',
      others.every(([, flow]) => handed(flow) === null),
      others.map(([name, flow]) => `${name}: ${String(handed(flow))}`).join(' / '),
    )
  }
  const bootHosted = (columns: number, rows: number): React.ReactElement =>
    h(AppStateProvider, {
      children: h(ThemeProvider, {
        children: h(KeybindingSetup, {
          children: h(
            AlternateScreen,
            { mouseTracking: isMouseTrackingEnabled() },
            h(Box, { width: columns, height: rows, flexDirection: 'column' }, h(BootLoginsScreen, { facts, family: 'openai', fullScene: { columns, rows } })),
          ),
        }),
      }),
    })
  const waitingChatgpt = async (columns: number, rows: number, device = false): Promise<Mounted> => {
    const m = await mountOffscreen(bootHosted(columns, rows), columns, rows, { mouseTracking: true })
    await waitFor(() => m.screen().includes('logins') && cursorRow(m.screen()) !== '', 2000)
    m.push(KEY.enter)
    await painted(160)
    m.push(KEY.enter)
    await waitFor(() => m.screen().includes('paste:'), 2000)
    if (device) {
      m.push('d')
      await waitFor(() => m.screen().includes(OPENAI_DEVICE_CODE), 2000)
    }
    return m
  }
  fix = FIX_COPY
  console.log('§3 — c ON A WAITING SIGN-IN, BOOT LOGINS UNDER THE HOST THE PRODUCT GIVES IT: IT SAYS ONLY WHAT IT KNOWS')
  {
    takeRoad('unconfirmed')
    const m = await waitingChatgpt(80, 24)
    const screen = screenOf()
    check('mouse reporting is on while a sign-in waits (the host wrote ?1000h and the screen says so)', screen.bytes().includes(MOUSE_ON) && screen.on() && lastMouseWrite(screen.bytes()) === 'on', lastMouseWrite(screen.bytes()))
    m.push('c')
    const told = await waitFor(() => words(m.screen()).includes(SENT), 2000)
    check(
      'c with no clipboard tool to answer (an SSH login) never says it copied: one line says the copy went to the terminal and that a second c shows the URL on one line',
      told && words(m.screen()).includes(SENT_URL) && !m.screen().includes('copied to clipboard') && !words(m.screen()).includes('select the URL above') && clipboardHeld() === '',
      words(m.screen()).slice(0, 300),
    )
    check('…the address stands whole above that line', joined(m.screen()).includes(OPENAI_URL) && joined(m.screen()).indexOf(OPENAI_URL) !== -1 && joined(m.screen()).indexOf(OPENAI_URL) < joined(m.screen()).indexOf('sent to your terminal'))
    await painted(200)
    check("…and for an address the mouse stays the screen's: a native drag over its rows is the copy a browser refuses", screen.on() && lastMouseWrite(screen.bytes()) === 'on', lastMouseWrite(screen.bytes()))
    await settle(2300)
    check('…the line still stands after the two seconds a confirmed copy shows for', words(m.screen()).includes(SENT_URL) && screen.on())
    const copiesSoFar = receipts
    const shownSoFar = shown.length
    m.push('c')
    const lineAsked = await waitFor(() => shown.length === shownSoFar + 1, 2000)
    check(
      'a second c while that line stands asks for the address on one line of the terminal: the whole address, once, and nothing is copied again',
      lineAsked && shown.at(-1) === OPENAI_URL && receipts === copiesSoFar && clipboardHeld() === '' && words(m.screen()).includes(SENT_URL),
      `asked=${shown.length - shownSoFar} copies=${receipts - copiesSoFar}`,
    )
    m.push(KEY.esc)
    const closed = await waitFor(() => !m.screen().includes('paste:'), 2000)
    check('when the sign-in ends the line is gone', closed && !words(m.screen()).includes(SENT) && screen.on())
    m.unmount()

    takeRoad('no-road')
    const named = await waitingChatgpt(80, 24)
    named.push('c')
    const nothing = await waitFor(() => words(named.screen()).includes(NOTHING_URL), 2000)
    check('in a terminal known to take no clipboard writes c says nothing was copied and that a second c shows the URL on one line', nothing && words(named.screen()).includes(NOTHING_URL) && !named.screen().includes('copied to clipboard'), words(named.screen()).slice(0, 300))
    named.unmount()

    takeRoad('confirmed')
    const sure = await waitingChatgpt(80, 24)
    const sureScreen = screenOf()
    sure.push('c')
    const copied = await waitFor(() => sure.screen().includes('copied to clipboard'), 2000)
    check('where a clipboard road answers, c says copied to clipboard as before, the clipboard holds the address, and the mouse stays with the screen', copied && clipboardHeld() === OPENAI_URL && sureScreen.on() && !words(sure.screen()).includes(SENT), words(sure.screen()).slice(0, 300))
    await settle(2300)
    check('…and that line leaves on its own after two seconds', !sure.screen().includes('copied to clipboard') && words(sure.screen()).includes('c copy · d device · esc cancel'))
    const shownBefore = shown.length
    const copiesBefore = receipts
    sure.push('c')
    const again = await waitFor(() => receipts === copiesBefore + 1 && sure.screen().includes('copied to clipboard'), 2000)
    check('after a confirmed copy a second c copies again: the one-line screen is never shown by itself', again && shown.length === shownBefore, `asked=${shown.length - shownBefore} copies=${receipts - copiesBefore}`)
    sure.unmount()

    takeRoad('unconfirmed')
    const code = await waitingChatgpt(80, 24, true)
    code.push('c')
    const codeScreen = screenOf()
    const codeTold = await waitFor(() => words(code.screen()).includes(SENT_CODE) && !codeScreen.on(), 2000)
    check(
      "the device code's c points at the code above and hands the mouse back, so the one short row can be selected",
      codeTold && words(code.screen()).includes(SENT_CODE) && code.screen().includes(OPENAI_DEVICE_CODE) && !code.screen().includes('copied to clipboard') && !codeScreen.on() && lastMouseWrite(codeScreen.bytes()) === 'off',
      words(code.screen()).slice(0, 300),
    )
    const codeShown = shown.length
    const codeCopies = receipts
    code.push('c')
    const codeAgain = await waitFor(() => receipts === codeCopies + 1, 2000)
    check('…and a second c on a code copies it again: a code has no one-line screen', codeAgain && shown.length === codeShown)
    code.unmount()

    const wide = await waitingChatgpt(120, 40)
    wide.push('c')
    const wideTold = await waitFor(() => wide.screen().includes('sent to your terminal'), 2000)
    check('at 120x40 the screen says it too, the address whole above it', wideTold && wide.screen().includes('press c again for the URL on') && holdsAddress(wide.screen(), OPENAI_URL) && !wide.screen().includes('copied to clipboard') && !wide.screen().includes('taller terminal'), words(wide.screen()).slice(-300))
    wide.unmount()
  }

  console.log('§4 — c ON EVERY SIGN-IN CARD OF /logins IN ITS COMPACT FORM (80x16): ONE RULE')
  {
    const QUIET = new Set(['xai', 'nous', 'orcarouter'])
    const NEVER_CUT = new Set(['orcarouter'])
    const openCard = async (road: Road): Promise<{ m: Mounted; reached: boolean }> => {
      const ctx = Object.assign(Object.create(null), { onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} }) as LocalJSXCommandContext
      const hostRef = React.createRef<DOMElement>()
      const m = await mountOffscreen(
        h(AppStateProvider, {
          children: h(ThemeProvider, {
            children: h(KeybindingSetup, {
              children: h(
                Box,
                { width: 80, height: 16, flexDirection: 'column' },
                h(Box, { ref: hostRef, height: 16, flexDirection: 'column' }, h(Text, {}, 'CHAT')),
                h(ScrollKeybindingHandler, { isActive: true, scrollRef: { current: null } }),
                h(PopupHost, { hostRef, children: host => h(SettingsPopupSlot, { host, overlay: true }) }),
              ),
            }),
          }),
        }),
        80,
        16,
        { mouseTracking: true },
      )
      await painted(60)
      await openLoginsPopup(() => {}, ctx, road.family)
      await waitFor(() => cursorRow(m.screen()) !== '', 3000)
      m.push(KEY.enter)
      await painted(200)
      let reached = true
      for (const want of road.picks) {
        let found = false
        for (let step = 0; step < 8 && !found; step++) {
          if (want.test(cursorRow(m.screen()))) found = true
          else {
            m.push(KEY.down)
            await painted(80)
          }
        }
        reached = reached && found
        if (found) {
          m.push(KEY.enter)
          await painted(250)
        }
      }
      if (road.then !== undefined) {
        m.push(road.then)
        await painted(300)
      }
      reached = reached && (await waitFor(() => (road.code !== undefined ? m.screen().includes(road.code) : m.screen().includes(road.url!.slice(0, 30))), 2500))
      return { m, reached }
    }
    const closeCard = async (m: Mounted): Promise<void> => {
      popupStore.closeSettingsPopup()
      await painted(100)
      m.unmount()
      await painted(40)
    }
    for (const road of ROADS) {
      const what = road.then === 'd' ? 'code' : 'URL'
      const copiedText = road.then === 'd' ? road.code! : road.url!

      takeRoad('unconfirmed')
      const { m, reached } = await openCard(road)
      const screen = screenOf()
      const cutBefore = road.then === 'd' || NEVER_CUT.has(road.family) || !joined(m.screen()).includes(road.url!)
      m.push('c')
      const sentence = (what === 'URL' ? SENT_URL : SENT_CODE).toLowerCase()
      const told = await waitFor(() => words(m.screen()).toLowerCase().includes(sentence) && screen.on() === (what === 'URL'), 2500)
      await painted(150)
      check(
        `${road.id}: an unconfirmed c says so, paints the ${what === 'URL' ? "address whole where the card cut it, and the mouse stays the screen's" : 'code, and hands the mouse back'}`,
        reached && cutBefore && told && !m.screen().includes('Copied to clipboard') && (what === 'code' ? m.screen().includes(road.code!) && !screen.on() && lastMouseWrite(screen.bytes()) === 'off' : joined(m.screen()).includes(road.url!) && screen.on()),
        `reached=${reached} cut before=${cutBefore} mouse=${screen.on() ? 'on' : 'off'} · ${words(m.screen()).slice(0, 240)}`,
      )
      const cardShown = shown.length
      const cardCopies = receipts
      m.push('c')
      const second = await waitFor(() => (what === 'URL' ? shown.length === cardShown + 1 : receipts === cardCopies + 1), 2500)
      check(
        `${road.id}: a second c ${what === 'URL' ? 'asks for the whole address on one line and copies nothing again' : 'copies the code again'}`,
        second && (what === 'URL' ? shown.at(-1) === road.url && receipts === cardCopies : shown.length === cardShown),
        `asked=${shown.length - cardShown} copies=${receipts - cardCopies}`,
      )
      await closeCard(m)

      takeRoad('confirmed')
      const sure = await openCard(road)
      const sureScreen = screenOf()
      sure.m.push('c')
      const landed = await waitFor(() => clipboardHeld() === copiedText, 2500)
      await painted(200)
      const quiet = QUIET.has(road.family)
      check(
        `${road.id}: a confirmed c ${quiet ? 'stays silent as before' : 'says Copied to clipboard'}, leaves the card as it was and the mouse with the screen`,
        sure.reached && landed && sure.m.screen().includes('Copied to clipboard') === !quiet && !words(sure.m.screen()).toLowerCase().includes(SENT) && (what === 'code' || NEVER_CUT.has(road.family) || !joined(sure.m.screen()).includes(road.url!)) && sureScreen.on(),
        `reached=${sure.reached} clipboard=${landed} · ${words(sure.m.screen()).slice(0, 240)}`,
      )
      await closeCard(sure.m)
    }
    takeRoad('unconfirmed')
  }

  console.log("§5 — CLAUDE'S PANE AND CARD, AND THE ONE RULE THAT DECIDES WHAT c MAY SAY")
  {
    const snap = (copyNote: string | null) => ({ flow: { name: 'waiting' as const, url: CLAUDE_URL, loginWithClaudeAi: true, forcedMethod: null }, pastePromptUp: true, noCodeYet: false, browserOpened: false as const, copied: false, copyNote, shadowWarning: null, accountLabel: null })
    const note = signInCopy?.signInCopyNote('offered', 'URL') ?? null
    check("Claude's Boot pane says the sentence in place of its copy hint", note !== null && anthropicFlowPaneLines(snap(note), 0).includes(note) && !anthropicFlowPaneLines(snap(note), 0).includes('c copies the URL') && anthropicFlowPaneLines(snap(null), 0).includes('c copies the URL'))
    const Card = ({ copyNote }: { copyNote: string | null }): React.ReactNode =>
      waitingCard({ state: snap(copyNote).flow, frame: children => children, compact: true, model: snap(copyNote) as never, columns: 76, tokens: useMercuryTokens(), pastePromptUp: true, copied: false, copyNote, code: '', setCode: () => {}, submitCode: () => {}, codeCursor: 0, setCodeCursor: () => {} } as never)
    const cardOf = async (copyNote: string | null): Promise<{ frame: string; mouse: boolean }> => {
      const m = await mountOffscreen(h(AppStateProvider, { children: h(ThemeProvider, { children: h(KeybindingSetup, { children: h(Box, { width: 78, height: 16, flexDirection: 'column' }, h(Card, { copyNote })) }) }) }), 78, 16, { mouseTracking: true })
      await waitFor(() => m.screen().includes('Paste code here'), 2000)
      const got = { frame: m.screen(), mouse: screenOf().on() }
      m.unmount()
      return got
    }
    const plain = await cardOf(null)
    const unsure = await cardOf(note)
    check(
      "Claude's compact card cuts the address until an unconfirmed c, then paints it whole with the sentence, the mouse still the screen's",
      note !== null && !joined(plain.frame).includes(CLAUDE_URL) && plain.mouse && joined(unsure.frame).includes(CLAUDE_URL) && words(unsure.frame).includes(`Sent to your terminal — if nothing pastes, ${AGAIN}`) && unsure.mouse,
      `plain: cut=${!joined(plain.frame).includes(CLAUDE_URL)} mouse=${plain.mouse} · unsure: whole=${joined(unsure.frame).includes(CLAUDE_URL)} mouse=${unsure.mouse} · ${words(unsure.frame).slice(0, 300)}`,
    )
    const truth: Array<[string, { settled: string[]; noRoad: boolean }, string]> = [
      ['a clipboard tool answered', { settled: ['pbcopy'], noRoad: false }, 'copied'],
      ['the clipboard file took it', { settled: ['file'], noRoad: false }, 'copied'],
      ["tmux's buffer alone", { settled: ['tmux-buffer'], noRoad: false }, 'offered'],
      ['the escape alone', { settled: [], noRoad: false }, 'offered'],
      ['the escape into a terminal known to drop it', { settled: [], noRoad: true }, 'none'],
    ]
    check(
      'confirmed means a clipboard tool or the clipboard file took the text: a tmux buffer or the escape alone is not confirmed',
      signInCopy !== null && truth.every(([, receipt, answer]) => signInCopy.signInCopyAnswerOf(receipt as never) === answer),
      signInCopy === null ? 'src/models/sign-in/signInCopy.ts is not there' : truth.map(([name, receipt]) => `${name}: ${signInCopy.signInCopyAnswerOf(receipt as never)}`).join(' / '),
    )
    const through: string[] = []
    for (const road of ['unconfirmed', 'no-road', 'confirmed'] as const) {
      takeRoad(road)
      through.push(signInCopy?.signInCopyAnswerOf(await setClipboardWithReceipt('fixture')) ?? 'absent')
    }
    takeRoad('unconfirmed')
    check("through the product's own clipboard function on the three roads: offered, none, copied", through.join(' ') === 'offered none copied', through.join(' '))
  }
  fix = FIX_FLOOR
  console.log("§6 — UNDER THE BLOCK'S FLOOR: THE SENTENCE IS NEVER MISSING, AND WHILE IT STANDS THE ADDRESS TAKES THE ROSTER'S ROWS")
  {
    const rosterRows = (frame: string): number => frame.split('\n').filter(row => /not signed in|no key|CLI-managed|↓ \d+ more/.test(row)).length
    for (const [columns, rows, length] of [[120, 14, 450], [80, 16, 450], [80, 17, 464]] as const) {
      openaiUrl = OPENAI_URL.slice(0, length)
      takeRoad('unconfirmed')
      const m = await waitingChatgpt(columns, rows)
      const before = m.screen()
      m.push('c')
      const told = await waitFor(() => words(m.screen()).includes(SENT_URL), 2000)
      const after = m.screen()
      check(
        `boot ${columns}x${rows} ssh, ChatGPT's address at ${length} characters: the sentence is on the screen and the address above it is whole`,
        told && !joined(before).includes(openaiUrl) && words(after).includes(SENT_URL) && joined(after).includes(openaiUrl) && after.split('\n').length <= rows,
        `before whole=${joined(before).includes(openaiUrl)} · after whole=${joined(after).includes(openaiUrl)} · ${words(after).slice(0, 260)}`,
      )
      check(`…it took its rows from the roster, and no more than it needed`, rosterRows(after) < rosterRows(before) && after.split('\n').filter(row => row.trim() !== '').length >= rows - 3, `roster rows ${rosterRows(before)} → ${rosterRows(after)}`)
      m.push(KEY.esc)
      await waitFor(() => !m.screen().includes('paste:'), 2000)
      takeRoad('confirmed')
      m.push(KEY.enter)
      await painted(160)
      m.push(KEY.enter)
      await waitFor(() => m.screen().includes('paste:'), 2000)
      m.push('c')
      const copied = await waitFor(() => m.screen().includes('copied to clipboard'), 2000)
      check(`…and with a confirmed copy the roster keeps its rows`, copied && rosterRows(m.screen()) === rosterRows(before) && !joined(m.screen()).includes(openaiUrl), `roster rows ${rosterRows(m.screen())} of ${rosterRows(before)}`)
      m.unmount()
    }
    openaiUrl = OPENAI_URL
    takeRoad('unconfirmed')

    const gemini = await mountOffscreen(
      h(AppStateProvider, {
        children: h(ThemeProvider, {
          children: h(KeybindingSetup, { children: h(Box, { width: 80, height: 14, flexDirection: 'column' }, h(BootLoginsScreen, { facts, family: 'gemini', fullScene: { columns: 80, rows: 14 } })) }),
        }),
      }),
      80,
      14,
    )
    await waitFor(() => gemini.screen().includes('logins') && cursorRow(gemini.screen()) !== '', 2000)
    gemini.push(KEY.enter)
    await painted(160)
    for (let step = 0; step < 8 && !/Sign in with Google/.test(cursorRow(gemini.screen())); step++) {
      gemini.push(KEY.down)
      await painted(80)
    }
    gemini.push(KEY.enter)
    const waiting = await waitFor(() => words(gemini.screen()).includes('Sign in with Google:'), 2500)
    gemini.push('c')
    const answered = await waitFor(() => words(gemini.screen()).includes(SENT_URL), 2000)
    check("Gemini's plan sign-in at 80x14, where c was answered by silence: the sentence is painted", waiting && answered, words(gemini.screen()).slice(0, 300))
    gemini.unmount()

    const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
    const environment = { model: 'model', critter: 'crab', critterHue: 'crimson', dirBase: 'work', dirTail: '' }
    const frame = (columns: number, rows: number, model: unknown): string => (core.composeBootMenu(columns, rows, model) as { lines: string[] }).lines.map(line => stripAnsi(line)).join('\n')
    const noteOf = (answer: 'offered' | 'none', what: 'URL' | 'code'): string => signInCopy?.signInCopyNote(answer, what) ?? ''
    type Said = { copied: boolean; copyNote: string | null }
    const panes: Array<{ name: string; what: 'URL' | 'code'; held: string; flow: (said: Said) => LoginsFlowPaneV1 }> = [
      { name: 'ChatGPT browser, 464 characters', what: 'URL', held: OPENAI_URL, flow: said => ({ kind: 'handles', draftLen: 0, handles: { leg: 'openai-browser', phase: 'waiting', authorizeUrl: OPENAI_URL, ...said } }) },
      { name: 'OpenRouter headless', what: 'URL', held: OPENROUTER_URL, flow: said => ({ kind: 'handles', draftLen: 0, handles: { leg: 'openrouter-headless', phase: 'waiting', authorizeUrl: OPENROUTER_URL, ...said } }) },
      { name: 'Gemini own client', what: 'URL', held: GEMINI_URL, flow: said => ({ kind: 'handles', draftLen: 0, handles: { leg: 'gemini-oauth', phase: 'waiting', authorizeUrl: GEMINI_URL, ...said } }) },
      { name: 'Gemini plan', what: 'URL', held: GEMINI_URL, flow: said => ({ kind: 'handles', draftLen: 0, handles: { leg: 'gemini-plan', phase: 'waiting', authorizeUrl: GEMINI_URL, ...said } }) },
      {
        name: 'Claude subscription',
        what: 'URL',
        held: CLAUDE_URL,
        flow: said => ({ kind: 'anthropic', draftLen: 0, snap: { flow: { name: 'waiting', url: CLAUDE_URL, loginWithClaudeAi: true, forcedMethod: null }, pastePromptUp: true, noCodeYet: false, browserOpened: null, shadowWarning: null, accountLabel: null, ...said } }),
      },
      { name: 'Kimi device code', what: 'URL', held: DEVICE_URL, flow: said => ({ kind: 'device', nowMs: 0, device: { family: 'moonshot', phase: 'waiting', userCode: DEVICE_CODE, verificationUri: DEVICE_URL, expiresAtMs: 600_000, polls: 1, ...said } }) },
      { name: 'ChatGPT device code', what: 'code', held: OPENAI_DEVICE_CODE, flow: said => ({ kind: 'opdevice', opdevice: { userCode: OPENAI_DEVICE_CODE, verifyHint: OPENAI_DEVICE_HINT, ...said } }) },
    ]
    const WIDTHS = [64, 72, 80, 90, 100, 110, 117, 121, 132, 150]
    let frames = 0
    let cut = 0
    const silent: string[] = []
    const overflow: string[] = []
    const neither: string[] = []
    for (const pane of panes) {
      for (const answer of ['offered', 'none'] as const) {
        const note = noteOf(answer, pane.what)
        const model = loginsMenuModelOf(facts, { selIdx: 0, environment, flow: pane.flow({ copied: false, copyNote: note }) })
        for (const columns of WIDTHS) {
          for (let rows = 13; rows <= 30; rows++) {
            const painted = frame(columns, rows, model)
            const whole = pane.what === 'code' ? painted.includes(pane.held) : holdsAddress(painted, pane.held) && !painted.includes('taller terminal')
            const tail = pane.what === 'URL' && painted.includes('…') && painted.includes(pane.held.slice(-24))
            frames++
            if (!whole) cut++
            if (note === '' || !(words(painted).includes(note) || paneWords(painted).includes(note))) silent.push(`${pane.name} ${answer} ${columns}x${rows}`)
            if (!whole && !tail) neither.push(`${pane.name} ${answer} ${columns}x${rows}`)
            if (painted.split('\n').length > rows) overflow.push(`${pane.name} ${columns}x${rows}`)
          }
        }
      }
    }
    check(`composed, ${panes.length} panes x two sentences x ${WIDTHS.length} widths x 13 to 30 rows: the sentence is on the screen in every frame`, silent.length === 0, `${silent.length} of ${frames}: ${silent.slice(0, 6).join(' · ')}`)
    check('…the address is whole, or its end stands behind an ellipsis, and that is met only at the smallest sizes; no frame is taller than its window', neither.length === 0 && overflow.length === 0 && cut > 0 && cut < frames / 10, `neither ${neither.slice(0, 4).join(' · ')} · overflow ${overflow.slice(0, 4).join(' · ')} · cut ${cut} of ${frames}`)
    const openai = panes[0]!
    const standing = loginsMenuModelOf(facts, { selIdx: 0, environment, flow: openai.flow({ copied: false, copyNote: noteOf('offered', 'URL') }) }) as Record<string, unknown>
    const plain = loginsMenuModelOf(facts, { selIdx: 0, environment, flow: openai.flow({ copied: false, copyNote: null }) }) as Record<string, unknown>
    const confirmed = loginsMenuModelOf(facts, { selIdx: 0, environment, flow: openai.flow({ copied: true, copyNote: null }) }) as Record<string, unknown>
    check(
      'only the standing sentence hands the composer the mark: with no c and with a confirmed copy it is absent, so nothing there can move',
      standing['detailOverrideOverList'] === true && !('detailOverrideOverList' in plain) && !('detailOverrideOverList' in confirmed),
      `standing=${String(standing['detailOverrideOverList'])} plain=${'detailOverrideOverList' in plain} confirmed=${'detailOverrideOverList' in confirmed}`,
    )
    const without = { ...standing, detailOverrideOverList: undefined }
    check(
      'where the sentence fits beside the roster the frame is the one without the mark, cell for cell (80x24, 100x30, 120x40)',
      ([[80, 24], [100, 30], [120, 40]] as const).every(([columns, rows]) => frame(columns, rows, standing) === frame(columns, rows, without)),
    )
    const claude450 = `${CLAUDE_URL}&state=${'fixtureState0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(6)}`.slice(0, 450)
    const claude = loginsMenuModelOf(facts, {
      selIdx: 0,
      environment,
      flow: { kind: 'anthropic', draftLen: 0, snap: { flow: { name: 'waiting', url: claude450, loginWithClaudeAi: true, forcedMethod: null }, pastePromptUp: true, noCodeYet: false, browserOpened: null, copied: false, copyNote: noteOf('offered', 'URL'), shadowWarning: null, accountLabel: null } },
    })
    for (const [columns, rows] of [[120, 14], [80, 17]] as const) {
      const painted = frame(columns, rows, claude)
      check(
        `boot ${columns}x${rows} ssh, Claude's address at 450 characters: the sentence is on the screen and the address above it is whole`,
        claude450.length === 450 && words(painted).includes(SENT_URL) && holdsAddress(painted, claude450) && !holdsAddress(frame(columns, rows, { ...claude, detailOverrideOverList: undefined }), claude450),
        words(painted).slice(0, 260),
      )
    }
    check(
      'at 64x13 the address cannot fit: its end stands behind an ellipsis and the sentence still says what gets it',
      !holdsAddress(frame(64, 13, standing), OPENAI_URL) && frame(64, 13, standing).includes('…') && frame(64, 13, standing).includes(OPENAI_URL.slice(-24)) && words(frame(64, 13, standing)).includes(SENT_URL),
      words(frame(64, 13, standing)).slice(0, 260),
    )
    check(
      'one sentence: for an address a second c, for a code the code above; no sentence tells a person to select an address',
      signInCopy !== null &&
        signInCopy.signInCopyNote('offered', 'URL') === SENT_URL &&
        signInCopy.signInCopyNote('none', 'URL') === NOTHING_URL &&
        signInCopy.signInCopyNote('offered', 'code') === SENT_CODE &&
        signInCopy.signInCopyNote('none', 'code') === 'nothing copied — select the code above' &&
        signInCopy.signInCopyNote('copied', 'URL') === null,
      signInCopy === null ? 'src/models/sign-in/signInCopy.ts is not there' : `${signInCopy.signInCopyNote('offered', 'URL')} / ${signInCopy.signInCopyNote('none', 'URL')}`,
    )
  }
  fix = FIX_LINE
  console.log("§7 — THE ONE-LINE SCREEN: THE ADDRESS ALONE ON A LINE OF THE TERMINAL'S OWN, THE LOOP STILL RUNNING, ENTER OR ESC TO RETURN")
  {
    const showLine = realLentTerminal?.showSignInAddressLine
    const stamps: number[] = []
    function Stream(): React.ReactNode {
      const [rows, setRows] = React.useState<number[]>([])
      React.useEffect(() => {
        const timer = setInterval(() => {
          stamps.push(Date.now())
          setRows(held => [...held, held.length + 1])
        }, 100)
        return () => clearInterval(timer)
      }, [])
      return h(Box, { flexDirection: 'column' }, rows.slice(-10).map(row => h(Text, { key: row }, `stream row ${row}`)))
    }
    const m = await mountOffscreen(
      h(AppStateProvider, { children: h(ThemeProvider, { children: h(KeybindingSetup, { children: h(AlternateScreen, { mouseTracking: true }, h(Box, { width: 80, height: 24, flexDirection: 'column' }, h(Stream))) }) }) }),
      80,
      24,
      { mouseTracking: true },
    )
    const [out, ink] = [...screenInstances.entries()].at(-1) as unknown as [{ writes: string[]; emit(event: string): boolean; listenerCount(event: string): number }, { options: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }; isMouseTrackingEnabled(): boolean; editorHandoverDepth: number }]
    const streams = { stdin: ink.options.stdin, stdout: ink.options.stdout }
    await waitFor(() => m.screen().includes('stream row 2'), 2000)
    for (const [key, name] of [[KEY.esc, 'Esc'], [KEY.enter, 'Enter']] as const) {
      const from = out.writes.length
      const listening = out.listenerCount('resize')
      const startedAt = Date.now()
      let returned: boolean | null = null
      const up = showLine === undefined ? Promise.resolve(false) : showLine(OPENAI_URL, streams).then(lent => (returned = lent))
      await settle(1200)
      const written = out.writes.slice(from)
      const line = written.findIndex(write => write.includes(OPENAI_URL))
      const handover = written.slice(0, Math.max(0, line)).join('')
      check(
        `the address is written alone on its line, from the first column, a blank line above it and the return words under a blank one (${name})`,
        line !== -1 && written[line] === `\n${OPENAI_URL}\n\nPress Enter to return to Mercury… ` && handover.includes('\x1b[2J') && handover.includes('\x1b[H'),
        JSON.stringify(written[line] ?? written.join('').slice(0, 200)).slice(0, 240),
      )
      check(`…outside Mercury's screen the mouse and the focus reports are off, so going to the browser sends the wait nothing (${name})`, handover.includes('\x1b[?1004l') && handover.includes(MOUSE_OFF), JSON.stringify(handover).slice(0, 200))
      const during = stamps.filter(at => at > startedAt)
      const gaps = during.map((at, index) => at - (index === 0 ? startedAt : during[index - 1]!))
      check(
        `THE LOOP DOES NOT STAND STILL: while the line is up for 1.2 s the stand-in stream goes on at its own pace, and nothing of it is painted over the line (${name})`,
        returned === null && during.length >= 8 && Math.max(...gaps) < 450 && !written.slice(line + 1).join('').includes('stream row'),
        `returned=${String(returned)} rows during=${during.length} longest gap=${gaps.length > 0 ? Math.max(...gaps) : -1} ms`,
      )
      if (line !== -1) out.writes.splice(from + line, 1)
      m.push('\x1b[O')
      await settle(120)
      m.push('x')
      await settle(120)
      check(`…a focus report and a stray key do not end it (${name})`, returned === null)
      const resizedAt = out.writes.length
      out.emit('resize')
      await settle(80)
      const again = out.writes.slice(resizedAt)
      check(
        `the window resized while the line is up: the screen is cleared and the one write is written again, and nothing else is written (${name})`,
        returned === null && again.length === 1 && again[0] === `\x1b[2J\x1b[H\n${OPENAI_URL}\n\nPress Enter to return to Mercury… `,
        `${again.length} writes · ${JSON.stringify(again[0] ?? '').slice(0, 160)}`,
      )
      out.writes.splice(resizedAt, again.length)
      const keyAt = out.writes.length
      m.push(key)
      out.emit('resize')
      const ended = await Promise.race([up, settle(1500).then(() => null)])
      check(
        `…a resize in the instant of ${name} writes no line after the return, and off the line a resize is the screen's own again (${name})`,
        ended === true && !out.writes.slice(keyAt).some(write => write.includes(OPENAI_URL)) && out.listenerCount('resize') === listening,
        `ended=${String(ended)} listeners ${listening} → ${out.listenerCount('resize')}`,
      )
      const last = stamps.length
      const back = await waitFor(() => m.screen().includes(`stream row ${last}`), 2000)
      check(
        `${name} returns: the screen is painted again with every row that arrived meanwhile, in order, and the mouse is the screen's again`,
        ended === true && back && m.screen().includes(`stream row ${last - 1}`) && m.screen().indexOf(`stream row ${last - 1}`) < m.screen().indexOf(`stream row ${last}`) && ink.isMouseTrackingEnabled() && lastMouseWrite(out.writes.join('')) === 'on',
        `ended=${String(ended)} back=${back} last=${last}`,
      )
    }
    const linesTaken = (from: number): number => {
      let lines = 0
      for (let index = out.writes.length - 1; index >= from; index--) {
        if (!out.writes[index]!.includes(OPENAI_URL)) continue
        lines++
        out.writes.splice(index, 1)
      }
      return lines
    }
    const readers = streams.stdin.listenerCount('readable')
    const rawWas = streams.stdin.isRaw
    const twiceFrom = out.writes.length
    const first = showLine === undefined ? Promise.resolve(false) : showLine(OPENAI_URL, streams)
    const second = showLine === undefined ? Promise.resolve(false) : showLine(OPENAI_URL, streams)
    await settle(300)
    const secondSaid = await Promise.race([second, settle(50).then(() => 'still up' as const)])
    const twiceLines = linesTaken(twiceFrom)
    m.push(KEY.enter)
    const firstSaid = await Promise.race([first, settle(1500).then(() => 'still up' as const)])
    await settle(200)
    check(
      'A TERMINAL ALREADY LENT IS NEVER LENT AGAIN: two calls in one turn of the loop write ONE line, the second answers false at once, and ONE Enter gives the keyboard back whole (the reader on, raw mode and the mouse as they were)',
      twiceLines === 1 && secondSaid === false && firstSaid === true && streams.stdin.listenerCount('readable') === readers && streams.stdin.isRaw === rawWas && ink.isMouseTrackingEnabled(),
      `lines ${twiceLines} · second ${String(secondSaid)} · first ${String(firstSaid)} · readers ${readers} → ${streams.stdin.listenerCount('readable')} · raw ${String(rawWas)} → ${String(streams.stdin.isRaw)}`,
    )
    const lend = realLentTerminal?.lendTerminal
    const depths: number[] = []
    const work = (): number => depths.push(ink.editorHandoverDepth)
    const [one, two] = await Promise.all([lend === undefined ? null : lend(work, streams), lend === undefined ? null : lend(work, streams)])
    await settle(200)
    check(
      "a lend whose work is done before it returns (the Devin row's) is over before the next begins: two calls in one turn run one after the other, never one inside the other, and the reader is on after both",
      one !== null && two !== null && depths.join() === '1,1' && streams.stdin.listenerCount('readable') === readers && streams.stdin.isRaw === rawWas,
      `depths ${depths.join()} · readers ${readers} → ${streams.stdin.listenerCount('readable')} · raw ${String(rawWas)} → ${String(streams.stdin.isRaw)}`,
    )
    const before = out.writes.length
    const nowhere = showLine === undefined ? null : await showLine(OPENAI_URL)
    check('with no terminal to lend (no screen on the process output) nothing is written and it says so', nowhere === false && out.writes.slice(before).every(write => !write.includes(OPENAI_URL)), String(nowhere))
    m.unmount()
  }

  console.log('§8 — THE MOUSE ON THE ADDRESS: A DRAG COPIES THE WHOLE ADDRESS, NEVER ONE ROW; A CLICK DOES NOTHING; NOTHING OF A GESTURE IS EVER TYPED')
  {
    const withSelection = (columns: number, rows: number): React.ReactElement =>
      h(AppStateProvider, {
        children: h(ThemeProvider, {
          children: h(KeybindingSetup, {
            children: h(
              AlternateScreen,
              { mouseTracking: true },
              h(
                Box,
                { width: columns, height: rows, flexDirection: 'column' },
                h(BootLoginsScreen, { facts, family: 'openai', fullScene: { columns, rows } }),
                h(ScrollKeybindingHandler, { isActive: true, scrollRef: { current: null } }),
              ),
            ),
          }),
        }),
      })
    const mouse = (code: number, col: number, row: number, up = false): string => `\x1b[<${code};${col + 1};${row + 1}${up ? 'm' : 'M'}`
    const span = (m: Mounted): { first: number; last: number; col: number; lastCol: number } => {
      const lines = m.screen().split('\n')
      const first = lines.findIndex(row => row.includes(OPENAI_URL.slice(0, 30)))
      const col = lines[first]!.indexOf('https://')
      let last = first
      while (last + 1 < lines.length && OPENAI_URL.includes(lines[last + 1]!.slice(col).trim()) && lines[last + 1]!.slice(col).trim().length > 0) last++
      return { first, last, col, lastCol: lines[last]!.trimEnd().length - 1 }
    }
    const waiting = async (columns: number, rows: number): Promise<{ m: Mounted; first: number; last: number; col: number; lastCol: number }> => {
      const m = await mountOffscreen(withSelection(columns, rows), columns, rows, { mouseTracking: true })
      await waitFor(() => m.screen().includes('logins') && cursorRow(m.screen()) !== '', 2000)
      m.push(KEY.enter)
      await painted(160)
      m.push(KEY.enter)
      await waitFor(() => m.screen().includes('paste:'), 2000)
      return { m, ...span(m) }
    }
    const drag = async (at: { m: Mounted; first: number; last: number; col: number; lastCol: number }): Promise<void> => {
      at.m.push(mouse(0, at.col + 2, at.first))
      await painted(40)
      for (let row = at.first; row <= at.last; row++) {
        at.m.push(mouse(32, row === at.last ? at.lastCol : at.col + 40, row))
        await painted(30)
      }
      at.m.push(mouse(0, at.lastCol, at.last, true))
    }
    const click = async (m: Mounted, col: number, row: number): Promise<void> => {
      m.push(mouse(0, col, row))
      await painted(40)
      m.push(mouse(0, col, row, true))
      await settle(500)
    }
    const draft = (frame: string): number => /paste: (•*)▌/.exec(frame)?.[1]?.length ?? -1
    for (const [columns, rows] of [[80, 24], [120, 40]] as const) {
      takeRoad('confirmed')
      const at = await waiting(columns, rows)
      const copies = receipts
      await drag(at)
      const whole = await waitFor(() => clipboardHeld() === OPENAI_URL, 2000)
      await settle(500)
      check(
        `${columns}x${rows}: a drag from the address's first row to its last copies the WHOLE address, once, and says what c says`,
        at.last > at.first && whole && clipboardHeld() === OPENAI_URL && receipts === copies + 1 && at.m.screen().includes('copied to clipboard'),
        `rows ${at.first}..${at.last} · clipboard ${clipboardHeld().length} of ${OPENAI_URL.length} chars ${JSON.stringify(clipboardHeld().slice(0, 60))} · copies ${receipts - copies}`,
      )
      rmSync(clipboardFile, { force: true })
      await click(at.m, at.col + 5, at.first + 1)
      check(`${columns}x${rows}: a click on a row of the address does nothing: no copy, and no row of it handed to the clipboard`, clipboardHeld() === '' && receipts === copies + 1 && at.m.screen().includes('paste:'), `clipboard ${clipboardHeld().length} chars · copies ${receipts - copies}`)
      if (at.col > 40) {
        await click(at.m, 8, at.first + 1)
        check(`${columns}x${rows}: a click on the roster's cells of a row that holds the address does nothing either`, clipboardHeld() === '' && receipts === copies + 1 && at.m.screen().includes('paste:'), `clipboard ${clipboardHeld().length} chars · copies ${receipts - copies}`)
      }
      at.m.unmount()
    }
    takeRoad('confirmed')
    const sure = await waiting(80, 24)
    const answered = receipts
    for (let n = 1; n <= 3; n++) {
      sure.m.push('c')
      await waitFor(() => receipts === answered + n, 2000)
    }
    await click(sure.m, sure.col + 5, sure.first)
    check('a clipboard that answers: c, c, c, then one click on the address: three copies, not four', receipts === answered + 3, `copies ${receipts - answered}`)
    const quiet = await waitFor(() => !sure.m.screen().includes('copied to clipboard'), 4000)
    sure.m.push(mouse(0, sure.col + 5, sure.first))
    await painted(40)
    sure.m.push(mouse(0, sure.col + 6, sure.first, true))
    await settle(500)
    check(
      'a press that slips one cell before its release is a click, as on every other screen: still three copies and no ack',
      quiet && receipts === answered + 3 && !sure.m.screen().includes('copied to clipboard'),
      `copies ${receipts - answered} · ack ${sure.m.screen().includes('copied to clipboard')}`,
    )
    sure.m.push(mouse(0, sure.col + 5, sure.first))
    await painted(40)
    sure.m.push(mouse(32, sure.col + 9, sure.first))
    await painted(40)
    sure.m.push(mouse(0, sure.col + 5, sure.first, true))
    await settle(500)
    check('…and a press that wanders and is released where it began is a click too', receipts === answered + 3, `copies ${receipts - answered}`)
    sure.m.push('x')
    sure.m.push('y')
    const typed = await waitFor(() => draft(sure.m.screen()) === 2, 2000)
    const withDraft = receipts
    rmSync(clipboardFile, { force: true })
    await click(sure.m, sure.col + 5, sure.first)
    check(
      'two letters in the paste field, then a click on the address: the draft is still two letters and nothing was copied',
      typed && draft(sure.m.screen()) === 2 && receipts === withDraft && clipboardHeld() === '',
      `draft ${draft(sure.m.screen())} · copies ${receipts - withDraft}`,
    )
    await drag({ m: sure.m, ...span(sure.m) })
    const dragged = await waitFor(() => clipboardHeld() === OPENAI_URL, 2000)
    await settle(300)
    check(
      "…and a drag from the address's first row to its last with those two letters typed: one copy of the whole address, the draft still two",
      dragged && receipts === withDraft + 1 && draft(sure.m.screen()) === 2,
      `draft ${draft(sure.m.screen())} · copies ${receipts - withDraft} · clipboard ${clipboardHeld().length} chars`,
    )
    sure.m.unmount()
    takeRoad('unconfirmed')
    const at = await waiting(80, 24)
    const asked = shown.length
    await drag(at)
    const told = await waitFor(() => words(at.m.screen()).includes(SENT_URL), 2000)
    check('with no clipboard in reach a drag over the address says the sentence, as c does', told && shown.length === asked && clipboardHeld() === '', words(at.m.screen()).slice(0, 260))
    await click(at.m, at.col + 5, span(at.m).first)
    check('…a click while the sentence stands does nothing: the one-line screen is not shown', shown.length === asked && words(at.m.screen()).includes(SENT_URL), `asked=${shown.length - asked}`)
    const row = span(at.m)
    at.m.push(mouse(0, row.col + 2, row.first))
    await painted(40)
    at.m.push(mouse(32, row.col + 12, row.first))
    await painted(40)
    at.m.push(mouse(0, row.col + 12, row.first, true))
    const inRow = await waitFor(() => shown.length === asked + 1, 2000)
    check('…a drag of ten cells inside one row of it is the second c: the whole address on one line', inRow && shown.at(-1) === OPENAI_URL, `asked=${shown.length - asked}`)
    await drag({ m: at.m, ...span(at.m) })
    const second = await waitFor(() => shown.length === asked + 2, 2000)
    check('…and so is a drag from its first row to its last', second && shown.at(-1) === OPENAI_URL, `asked=${shown.length - asked}`)
    const roster = at.m.screen().split('\n').findIndex(row => row.includes('❯'))
    const copies = receipts
    const askedAgain = shown.length
    at.m.push(mouse(0, 8, roster))
    await painted(40)
    at.m.push(mouse(32, 30, roster + 1))
    await painted(40)
    at.m.push(mouse(0, 30, roster + 1, true))
    await settle(400)
    check('a drag that begins on a row that holds no address is not c', receipts === copies && shown.length === askedAgain, `copies=${receipts - copies} asked=${shown.length - askedAgain}`)
    at.m.unmount()

    takeRoad('unconfirmed')
    const live = await waiting(80, 24)
    live.m.push('c')
    const standing = await waitFor(() => words(live.m.screen()).includes(SENT_URL), 2000)
    const [liveOut, liveInk] = [...screenInstances.entries()].at(-1) as unknown as [{ writes: string[] }, { options: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }; isMouseTrackingEnabled(): boolean }]
    const liveIn = liveInk.options.stdin
    const linesUp = (from: number): number => {
      let lines = 0
      for (let index = liveOut.writes.length - 1; index >= from; index--) {
        if (!liveOut.writes[index]!.includes(OPENAI_URL)) continue
        lines++
        liveOut.writes.splice(index, 1)
      }
      return lines
    }
    const whole = (): boolean => liveIn.listenerCount('readable') === readers && liveIn.isRaw === rawWas && liveInk.isMouseTrackingEnabled()
    const readers = liveIn.listenerCount('readable')
    const rawWas = liveIn.isRaw
    const wholeDrag = (): string => {
      const rows = span(live.m)
      return mouse(0, rows.col + 2, rows.first) + mouse(32, rows.col + 20, rows.last) + mouse(0, rows.col + 20, rows.last, true)
    }
    lineStreams = { stdin: liveIn, stdout: liveInk.options.stdout }
    let from = liveOut.writes.length
    live.m.push(`c${wholeDrag()}`)
    await settle(400)
    const keyAndDrag = linesUp(from)
    live.m.push(KEY.enter)
    await settle(500)
    check(
      'a c and a whole drag in ONE read while the sentence stands lend the terminal ONCE: one line, and ONE Enter gives the keyboard back whole',
      standing && keyAndDrag === 1 && whole() && words(live.m.screen()).includes(SENT_URL),
      `lines ${keyAndDrag} · readers ${readers} → ${liveIn.listenerCount('readable')} · raw ${String(rawWas)} → ${String(liveIn.isRaw)} · mouse ${String(liveInk.isMouseTrackingEnabled())}`,
    )
    from = liveOut.writes.length
    live.m.push('c\x1b[Ic')
    await settle(400)
    const keyReportKey = linesUp(from)
    live.m.push(KEY.enter)
    await settle(500)
    check(
      'c, a focus report and c in ONE read lend it ONCE too: one line, one Enter, the keyboard whole',
      keyReportKey === 1 && whole() && draft(live.m.screen()) === 0,
      `lines ${keyReportKey} · draft ${draft(live.m.screen())} · readers ${readers} → ${liveIn.listenerCount('readable')} · raw ${String(rawWas)} → ${String(liveIn.isRaw)}`,
    )
    from = liveOut.writes.length
    live.m.push('cc')
    const twoLetters = await waitFor(() => draft(live.m.screen()) === 2, 2000)
    check('…and what is typed next reaches the paste field: cc in ONE read is two letters there and no line, as on 1.1.0', twoLetters && linesUp(from) === 0, `draft ${draft(live.m.screen())}`)
    from = liveOut.writes.length
    live.m.push(`ccc${wholeDrag()}${wholeDrag()}`)
    await settle(400)
    const lettersAndDrags = linesUp(from)
    live.m.push(KEY.enter)
    await settle(500)
    live.m.push('z')
    const afterAll = await waitFor(() => draft(live.m.screen()) === 6, 2000)
    check(
      'three c and two whole drags in ONE read: the letters are typed, the terminal is lent ONCE, and one Enter gives the keyboard back whole',
      lettersAndDrags === 1 && afterAll && whole(),
      `lines ${lettersAndDrags} · draft ${draft(live.m.screen())} · readers ${readers} → ${liveIn.listenerCount('readable')} · raw ${String(rawWas)} → ${String(liveIn.isRaw)} · mouse ${String(liveInk.isMouseTrackingEnabled())}`,
    )
    lineStreams = null
    live.m.unmount()
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? 'prove-logins-sign-in-small-window: ALL PASS' : `prove-logins-sign-in-small-window: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
