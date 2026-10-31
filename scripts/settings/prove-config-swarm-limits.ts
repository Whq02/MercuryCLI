import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('swarm-limits-popup')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const work = join(home, 'project')
mkdirSync(work, { recursive: true })
process.chdir(work)
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(work)
bootstrap.setCwdState(work)
bootstrap.setProjectRoot(work)
const React = await import('react')
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const { configPopupRequest } = await import('../../src/commands/config/config.tsx')
const { CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { getSettingsForSource, updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')
enableConfigs()
const cols = 120, rows = 44
let checks = 0
function check(label: string, truth: unknown): void { assert(truth, label); checks++; console.log(`PASS ${label}`) }
const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { width: cols, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true }))))
const mounted = await mountOffscreen(element, cols, rows)
const key = async (text: string) => { mounted.push(text); await settle(100) }
const open = async () => {
  popup.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  assert(await waitFor(() => mounted.screen().includes(CONFIG_POPUP_HINT), 4000), mounted.screen())
  await settle(150)
  await key('/')
  await key('swarm')
  await key(KEY.enter)
}
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
async function capture(name: string): Promise<void> {
  if (!frames) return
  mkdirSync(frames, { recursive: true })
  const lines = mounted.screen().split('\n')
  const grid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => {
    const style = mounted.styleAt(x, y)
    return { c: Array.from(lines[y] ?? '')[x] ?? ' ', fg: style?.fg, bg: style?.bg, bold: style?.bold, rev: style?.inverse }
  }))
  const path = join(frames, name)
  writeFileSync(`${path}.txt`, mounted.screen() + '\n')
  writeFileSync(`${path}.json`, JSON.stringify({ grid, cols, rows }))
  const { gridToPng } = await import('../ui/gridToPng.ts')
  await gridToPng(`${path}.json`, `${path}.png`)
  console.log(`Frame: ${path}.png`)
}
try {
  await open()
  check('the filtered popup shows the summary with exact default words', mounted.screen().includes('Swarm limits') && mounted.screen().includes('200,000 per agent · 500,000 per wave · 4 posts/min'))
  for (const label of ['Tokens per agent', 'Tokens per wave', 'Posts per minute', 'Posts per agent per wave', 'Characters per post']) check(`the group contains ${label}`, mounted.screen().includes(label))
  await capture('swarm-default-120x44')
  await key(KEY.down)
  await key(KEY.down)
  await key(KEY.right)
  check('the agent row edits user settings only', getSettingsForSource('userSettings')?.swarm?.seatAllowance === 201000 && getSettingsForSource('localSettings')?.swarm === undefined)
  await key(KEY.down)
  await key(KEY.right)
  await key(KEY.down)
  await key(KEY.right)
  await key(KEY.down)
  await key(KEY.right)
  await key(KEY.down)
  await key(KEY.right)
  const changed = getSettingsForSource('userSettings')?.swarm
  check('all five numeric controls write their step', changed?.seatAllowance === 201000 && changed.waveAllowance === 501000 && changed.postsPerMinute === 5 && changed.postsPerSeat === 130 && changed.postChars === 4400)
  await key(KEY.enter)
  check('enter saves and closes', !popup.isSettingsPopupOpen() && getSettingsForSource('userSettings')?.swarm?.postsPerSeat === 130)
  updateSettingsForSource('userSettings', { swarm: { seatAllowance: 12000, waveAllowance: 50000, postsPerMinute: 10, postsPerSeat: 120 } })
  await open()
  check('the summary follows configured values', mounted.screen().includes('12,000 per agent · 50,000 per wave · 10 posts/min'))
  await capture('swarm-custom-120x44')
  await key(KEY.down)
  await key(KEY.down)
  await key(KEY.right)
  await key(KEY.esc)
  check('escape reverts edited limits while preserving the other fields', getSettingsForSource('userSettings')?.swarm?.seatAllowance === 12000 && getSettingsForSource('userSettings')?.swarm?.waveAllowance === 50000)
  await key(KEY.esc)
  updateSettingsForSource('userSettings', { swarm: { seatAllowance: 1000, waveAllowance: 1000, postsPerMinute: 1, postsPerSeat: 10 } })
  await open()
  await key(KEY.down)
  await key(KEY.down)
  await key(KEY.left)
  check('below the seat floor selects no limit', getSettingsForSource('userSettings')?.swarm?.seatAllowance === 0 && mounted.screen().includes('no limit per agent'))
  await key(KEY.right)
  await key(KEY.right)
  check('raising the seat also raises a smaller wave allowance', getSettingsForSource('userSettings')?.swarm?.seatAllowance === 2000 && getSettingsForSource('userSettings')?.swarm?.waveAllowance === 2000)
  await key(KEY.down)
  await key(KEY.left)
  check('below the wave floor selects no limit', getSettingsForSource('userSettings')?.swarm?.waveAllowance === 0 && mounted.screen().includes('no limit per wave'))
  await key(KEY.esc)
  check('escape restores both coupled fields', getSettingsForSource('userSettings')?.swarm?.seatAllowance === 1000 && getSettingsForSource('userSettings')?.swarm?.waveAllowance === 1000)
  await key(KEY.esc)
  updateSettingsForSource('userSettings', { swarm: { seatAllowance: 0, waveAllowance: 0, postChars: 0 } })
  await open()
  check('the zero summary and post length show no limit', mounted.screen().includes('no limit per agent · no limit per wave') && mounted.lines().some(line => line.includes('Characters per post') && line.includes('no limit')))
  await capture('swarm-uncapped-120x44')
  await key(KEY.esc)
  updateSettingsForSource('userSettings', { swarm: { enabled: true, seatAllowance: 200000, waveAllowance: 500000, postChars: 4000, postsPerMinute: 4, postsPerSeat: 120 } })
  let liveUncap = false
  const listeners = new Set<() => void>()
  focused.setFocusedSessionConnector(new Proxy(focused.getFocusedSessionConnector(), {
    get(target, key) {
      if (key === 'swarmBoard') return () => ({ on: true, events: [], snapshot: 0, omitted: 0, admitted: 0, peerTurns: 0, uncapped: liveUncap })
      if (key === 'subscribeWork') return (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  await open()
  liveUncap = true
  for (const listener of listeners) listener()
  await settle(150)
  check('an open filtered popup follows the focused worker’s uncap override', mounted.screen().includes('no limit per agent · no limit per wave · 4 posts/min') && getSettingsForSource('userSettings')?.swarm?.seatAllowance === 200000)
  await capture('swarm-live-uncap-120x44')
  liveUncap = false
  for (const listener of listeners) listener()
  await settle(150)
  check('restoring caps refreshes the same popup', mounted.screen().includes('200,000 per agent · 500,000 per wave · 4 posts/min'))
  console.log(`${checks} swarm config checks passed`)
} finally {
  mounted.unmount()
  focused.releaseFocusedSessionConnector()
  popup.closeSettingsPopup()
  await releaseScratchHome(home)
}
process.exit(0)
