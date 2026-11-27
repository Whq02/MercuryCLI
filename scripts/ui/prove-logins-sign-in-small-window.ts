#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import type { LoginsFlowPaneV1 } from '../../src/screen/boot-face/logins/flowLines.js'

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
const DEVICE_URL = 'https://signin.example/device?user_code=FIXT-CODE'
const DEVICE_CODE = 'FIXT-CODE'
const OPENAI_DEVICE_CODE = 'FIXT-12345'
const OPENAI_DEVICE_HINT = 'Open https://auth.openai.example/codex/device and enter the code.'

const never = <T,>(): Promise<T> => new Promise<T>(() => {})
const handlesOf = (authorizeUrl: string) => () => ({ authorizeUrl, result: never(), completeWithRedirect: () => {}, cancel: () => {}, boundLoopbackPort: () => undefined })
const deviceRun = async (opts: { onEvent: (event: unknown) => void }): Promise<never> => {
  opts.onEvent({ phase: 'waiting', start: { userCode: DEVICE_CODE, verificationUri: DEVICE_URL, expiresAtMs: Date.now() + 600_000 }, polls: 1 })
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
mock.module('../../src/models/roads/openai/openaiAccounts.js', () => ({
  ...openaiAccounts,
  beginOpenaiBrowserConnect: handlesOf(OPENAI_URL),
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

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { KEY, mountOffscreen, painted, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { BootLoginsScreen, collectLoginsScreenFacts, loginsMenuModelOf } = await import('../../src/screen/boot-face/BootLoginsScreen.js')
const { loginsFlowPaneLines } = await import('../../src/screen/boot-face/logins/flowLines.js')
const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')

const FIX = 'src/screen/boot-face/logins/menuModel.ts marks a waiting sign-in must-read-whole and hands the composer loginsFlowNoticeOf(flow) as detailOverrideWhole; assets/splash/splash-core.mjs paints those words in the block and leaves the wide layout where the pane still does not fit'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail} | fix: ${FIX}` : ''}`)
}

const rowsOf = (frame: string): string[] => frame.split('\n').map(row => row.replace(/[│╭╮╰╯]/g, ' ').trim())
const joined = (frame: string): string => rowsOf(frame).join('')
const words = (frame: string): string => rowsOf(frame).filter(Boolean).join(' ').replace(/\s+/g, ' ')
const cursorRow = (frame: string): string => frame.split('\n').find(row => row.includes('❯')) ?? ''
const SMALL: ReadonlyArray<readonly [number, number]> = [[80, 24], [100, 30]]
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
  { id: 'Hugging Face device code', family: 'huggingface', picks: [/Sign in with Hugging Face/], says: ['On the sign-in page, enter this code:', 'If nothing opened, visit:'], tail: 'c copies the URL', url: DEVICE_URL, code: DEVICE_CODE },
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
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? 'prove-logins-sign-in-small-window: ALL PASS' : `prove-logins-sign-in-small-window: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
