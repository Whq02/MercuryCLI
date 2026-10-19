import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pinScratchHome, pinSourceRef, releaseScratchHome, mountOffscreen, waitFor, KEY } from '../lib/settingsPopupHarness.ts'

const sourceRef = pinSourceRef()
const home = pinScratchHome('first-run-sign-in-window')
const { resolveCaptureDriver, captureEngineEntry } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.reason)
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
process.env.TERM_PROGRAM = 'Apple_Terminal'
for (const name of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN|MERCURY_MODEL|MERCURY_HOME|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR/.test(name)) delete process.env[name]
}
const React = await import('react')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Onboarding } = await import('../../src/components/Onboarding.js')
const { BootSplashScreen } = await import('../../src/components/BootSplashScreen.js')
const { loginFamilyRows, SIGN_IN_LATER_ROW } = await import('../../src/components/loginFamilyRows.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const h = React.createElement
const options = [...loginFamilyRows({ engineLegs: true }), SIGN_IN_LATER_ROW]
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function Journey() {
  const [done, setDone] = React.useState(false)
  return done ? h(BootSplashScreen) : h(Onboarding, { onDone: () => setDone(true) })
}
if (process.argv.includes('--pty-child')) {
  const { render } = await import('../../src/ink.js')
  await render(h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Journey))))
  await new Promise(() => {})
}
for (const [cols, rows] of [[80, 24], [64, 20]]) {
  const cfg = join(home, `pty-${cols}.json`)
  writeFileSync(cfg, JSON.stringify({
    argv: [process.execPath, import.meta.path, '--pty-child', ...(sourceRef ? ['--source-ref', sourceRef] : [])],
    cols: 177, rows: 49, total: 120, out: join(home, `pty-${cols}-grid.json`),
    sends: [
      { data: '\r', awaitText: 'Choose your theme', requireAwait: true, awaitSettleTicks: 2 },
      { data: '\x1b[H', awaitText: 'sign in · 2/', requireAwait: true, awaitSettleTicks: 2, mark: 'list' },
      { data: '\x1b[F', afterPrevTicks: 5, requireAwait: true, awaitText: '↑↓ move · ↵ choose · esc back', awaitSettleTicks: 2 },
    ],
    resizes: [{ afterMark: 'list', afterMs: 0, cols, rows }],
    readyText: '❯ Sign in later', readySettleTicks: 2,
  }))
  try {
    const grid = execFileSync(driver.python, [captureEngineEntry(driver, join(import.meta.dir, '../..')), cfg], { encoding: 'utf8', timeout: 120000, env: { ...process.env, TMPDIR: home } })
    check(`PTY ${cols}x${rows}: live resize then End shows the later row`, grid.includes('❯ Sign in later'))
    if (frames) writeFileSync(join(frames, `pty-${cols}x${rows}.txt`), grid)
  } catch (error) { check(`PTY ${cols}x${rows}: live resize then End shows the later row`, false, String(error).slice(0, 200)) }
}
for (const [cols, rows, shrink] of [[177, 49, false], [100, 30, false], [80, 24, false], [64, 20, false], [80, 24, true], [64, 20, true]] as const) {
  const tag = `${cols}x${rows}${shrink ? '-resized' : '-fresh'}`
  const element = h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Journey)))
  const scene = await mountOffscreen(element, shrink ? 177 : cols, shrink ? 49 : rows)
  let liveCols: number = shrink ? 177 : cols
  let liveRows: number = shrink ? 49 : rows
  const resize = (columns: number, height: number) => { liveCols = columns; liveRows = height; scene.resize(element, columns, height) }
  const cursor = () => scene.lines().find(line => /❯/.test(line)) ?? ''
  const at = (index: number) => cursor().includes(options[index]!.label.slice(0, 18))
  const save = (name: string) => { if (frames) writeFileSync(join(frames, `${tag}-${name}.txt`), scene.screen()) }
  const focused = async (index: number, why: string) => {
    const visible = await waitFor(() => at(index) && scene.lines().filter(line => line.includes('╰')).length >= 2, 2000)
    check(`${tag}: ${why}: cursor on ${options[index]!.value}`, visible, cursor() || 'no visible cursor')
    check(`${tag}: ${why}: the cursor row keeps the glyph's gap and ends inside the frame`, /❯ \S/.test(cursor()) && stringWidth(cursor()) <= liveCols, cursor())
    const lines = scene.lines()
    check(`${tag}: closed frame stays within the terminal`, lines.length <= liveRows && lines.every(line => stringWidth(line) <= liveCols) && lines.some(line => line.includes('↑↓ move')) && lines.filter(line => line.includes('╰')).length >= 2)
  }
  try {
    check(`${tag}: first-run theme painted`, await waitFor(() => scene.screen().includes('Choose your theme'), 15000))
    scene.push(KEY.enter)
    check(`${tag}: first-run sign-in painted`, await waitFor(() => /sign in · 2\//.test(scene.screen()), 15000))
    if (shrink) resize(cols, rows)
    await focused(0, 'opening')
    save('opening')
    for (let i = 1; i < options.length; i++) { scene.push(KEY.down); await focused(i, 'down') }
    save('later')
    resize(177, 49)
    await focused(options.length - 1, 'grow with selection held')
    resize(cols, rows)
    await focused(options.length - 1, 'shrink with selection held')
    scene.push('\x1b[H'); await focused(0, 'Home')
    scene.push('\x1b[<65;10;10M'); await focused(1, 'wheel down')
    scene.push(KEY.up); await focused(0, 'up')
    scene.push('\x1b[6~')
    check(`${tag}: PageDown keeps a moved cursor in view`, await waitFor(() => cursor() !== '' && !at(0), 2000))
    scene.push('\x1b[5~'); await focused(0, 'PageUp')
    scene.push('\x1b[F'); await focused(options.length - 1, 'End')
    scene.push('\x1b[<64;10;10M'); await focused(options.length - 2, 'wheel up')
    scene.push('\x1b[F'); await focused(options.length - 1, 'End after wheel')
    scene.push(KEY.enter)
    check(`${tag}: later continues without a credential`, await waitFor(() => scene.screen().includes('Guardrails'), 15000))
    scene.push(KEY.enter)
    check(`${tag}: terminal setup offers its existing skip`, await waitFor(() => scene.screen().includes('not now; use /keysetup later'), 15000))
    scene.push(KEY.enter)
    check(`${tag}: continuing reaches the home screen`, await waitFor(() => scene.screen().includes('New Session'), 15000))
    save('home')
  } finally { scene.unmount() }
}
await releaseScratchHome(home)
console.log(failures ? `first-run-sign-in-window: ${failures} FAILURE(S)` : 'first-run-sign-in-window: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
