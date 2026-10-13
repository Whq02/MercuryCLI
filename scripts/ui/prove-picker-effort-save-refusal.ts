import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(import.meta.dir, '../..')
if (process.argv.includes('--child')) {
  const home = process.env.MERCURY_CONFIG_DIR!
  globalThis.fetch = (async () => { throw new Error('No network in the picker fixture') }) as typeof fetch
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const React = await import('react')
  const { Text, render } = await import('../../src/ink.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { useAppState } = await import('../../src/state/AppState.tsx')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
  const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
  const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
  const { getFocusedSessionConnector, setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { call } = await import('../../src/commands/model/mercuryModel.tsx')
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  const resting = getFocusedSessionConnector()
  setFocusedSessionConnector(new Proxy(resting, { get(target, key) {
    if (key === 'carrier') return 'in-process'
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }))
  const element = await call(() => {}, { messages: [], options: {} } as never, '')
  function State() { return React.createElement(Text, null, `active effort: ${useAppState(state => state.effortValue)}`) }
  const initialState = { ...getDefaultAppState(), engineModel: 'claude-fable-5-1', effortValue: 'high' as const }
  if (process.argv.includes('--refused')) {
    chmodSync(join(home, 'settings.json'), 0o444)
    chmodSync(home, 0o555)
  }
  await render(React.createElement(App, { initialState, getFpsMetrics: () => undefined } as never,
    React.createElement(KeybindingSetup, null, React.createElement(FullscreenLayout, {
      scrollable: React.createElement(Text, null, 'In-process model picker'),
      bottom: React.createElement(State), modal: element,
    } as never))), { exitOnCtrlC: true })
  await new Promise(() => {})
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'picker-effort-refusal-'))
  const frameAt = process.argv.indexOf('--frames')
  const frames = frameAt < 0 ? null : process.argv[frameAt + 1]!
  if (frames) mkdirSync(frames, { recursive: true })
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') throw new Error(`PTY driver unavailable: ${driver.kind}`)
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failures++ }
  const LINES = {
    refused: 'Effort set to xhigh · not saved as your default: ~/mercury/settings.json — permission denied',
    saved: 'Effort set to xhigh · saved as your default for future sessions',
  } as const
  try {
    for (const mode of ['refused', 'saved'] as const) {
      if (mode === 'refused' && asRoot) {
        console.log('SKIP refused: this user is root, and mode bits never refuse root a write')
        continue
      }
      const userHome = join(scratch, mode)
      const home = join(userHome, 'mercury')
      const cwd = join(scratch, 'project')
      mkdirSync(cwd, { recursive: true })
      seedFirstRun(home, [cwd])
      const settings = join(home, 'settings.json')
      const before = JSON.stringify({ engine: { model: 'claude-fable-5-1', effort: 'high' }, view: { reducedMotion: true } })
      writeFileSync(settings, before)
      const out = join(scratch, `${mode}.json`)
      const cfg = join(scratch, `${mode}-capture.json`)
      writeFileSync(cfg, JSON.stringify({ argv: [process.execPath, import.meta.filename, '--child', ...(mode === 'refused' ? ['--refused'] : [])], cwd, cols: 160, rows: 45, total: 180, readyText: 'active effort: xhigh', readySettleTicks: 6, out, sends: [{ requireAwait: true, awaitText: 'ctrl+e changes it', minTick: 3, awaitSettleTicks: 5, data: '\u0005' }] }))
      const env = { ...process.env, HOME: userHome, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_FULLSCREEN: '1', MERCURY_REDUCED_MOTION: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true', TMPDIR: scratch }
      for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'NODE_ENV', 'CI', 'MERCURY_CRITTER']) delete (env as Record<string, unknown>)[key]
      const capture = spawnSync(driver.python, [captureEngineEntry(driver, root), cfg], { cwd, env, encoding: 'utf8', timeout: vshotBudgetMs(90_000) })
      type Grid = Array<Array<{ c: string }>>
      const payload = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid } : {}
      const rows = (payload.grid ?? []).map(row => row.map(cell => cell.c).join('').trimEnd())
      const text = rows.join('\n')
      console.log(text)
      if (frames) writeFileSync(join(frames, `effort-save-${mode}.txt`), text.replaceAll(scratch, '<scratch>') + '\n')
      check(`${mode}: the in-process picker took ctrl+e and the live effort moved to xhigh`, capture.status === 0 && text.includes('active effort: xhigh'), `status ${capture.status}`)
      const said = rows.filter(row => row.includes(LINES[mode]))
      check(`${mode}: the picker's footer says it once and whole: "${LINES[mode]}"`, said.length === 1, rows.filter(row => row.includes('Effort set to')).join(' | '))
      if (mode === 'refused') {
        check('the refused line never reads as a save', !text.includes('· saved as your default'))
        check('the line carries neither the writer\'s prefix nor the OS path tail', !text.includes('Failed to update settings file') && !text.includes("open '"))
        check('the read-only settings bytes stay unchanged', readFileSync(settings, 'utf8') === before)
      } else {
        check('no refusal is said on a saved write', !text.includes('not saved'))
        check('the saved default follows the live choice', JSON.parse(readFileSync(settings, 'utf8')).engine.effort === 'xhigh')
      }
      if (capture.status !== 0) console.log(capture.stderr.slice(-1500))
      chmodSync(home, 0o755)
      chmodSync(settings, 0o644)
    }
  } finally {
    for (const mode of ['refused', 'saved']) {
      const home = join(scratch, mode, 'mercury')
      if (existsSync(home)) chmodSync(home, 0o755)
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(failures ? 1 : 0)
}
