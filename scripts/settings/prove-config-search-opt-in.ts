import assert from 'node:assert/strict'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'
const HOME = pinScratchHome('search-opt-in')
delete process.env.MERCURY_SEARCH_KEYLESS
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT } = await import('../../src/screen/settings/Config.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
const { duckduckgoScrapingEnabled } = await import('../../src/tools/engines/web-search/searchSetting.js')
enableConfigs()
const open = async () => {
  const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: 178, height: 51 }, React.createElement(SettingsPopupSlot, { overlay: true }))))
  const m = await mountOffscreen(element, 178, 51)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  m.push('/'); await settle(80)
  for (const ch of 'DuckDuckGo') { m.push(ch); await settle(25) }
  m.push(KEY.down)
  await waitFor(() => m.screen().includes('on by default'), 4000)
  return m
}
try {
  assert.equal(duckduckgoScrapingEnabled(), true)
  let m = await open()
  const screenBefore = m.screen()
  assert.match(screenBefore, /DuckDuckGo page scraping\s+on/)
  assert.ok(screenBefore.includes('terms'), `src/screen/settings/Config.tsx DuckDuckGo row missing 'terms' notice: ${screenBefore.slice(0, 160)}`)
  assert.ok(screenBefore.includes('off keeps general queries to the official sources and your keys'), `src/screen/settings/Config.tsx DuckDuckGo row missing off-meaning description: ${screenBefore.slice(0, 160)}`)
  m.push(KEY.right)
  await waitFor(() => !duckduckgoScrapingEnabled(), 4000)
  assert.match(m.screen(), /DuckDuckGo page scraping\s+off/)
  m.push(KEY.esc)
  await waitFor(() => duckduckgoScrapingEnabled(), 4000)
  m.push(KEY.esc); await settle(120); m.unmount(); await settle(60)
  m = await open(); m.push(KEY.right)
  await waitFor(() => !duckduckgoScrapingEnabled(), 4000)
  m.push(KEY.enter); await settle(160)
  assert.equal(duckduckgoScrapingEnabled(), false); m.unmount()
  console.log('PASS actual config row: default on, terms and the off meaning displayed, toggle effective immediately, escape reverts, Enter saves the off')
} finally { releaseScratchHome(HOME) }
