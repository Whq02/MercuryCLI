import assert from 'node:assert/strict'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'
const HOME = pinScratchHome('search-opt-in')
delete process.env.MERCURY_SEARCH_KEYLESS
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const { duckduckgoScrapingEnabled } = await import('../../src/services/search/searchSetting.js')
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
  await waitFor(() => m.screen().includes('off by default'), 4000)
  return m
}
try {
  assert.equal(duckduckgoScrapingEnabled(), false)
  let m = await open()
  assert.match(m.screen(), /DuckDuckGo scraping\s+off/)
  assert.ok(m.screen().includes('terms'))
  m.push(KEY.right)
  await waitFor(() => duckduckgoScrapingEnabled(), 4000)
  assert.match(m.screen(), /DuckDuckGo scraping\s+on/)
  m.push(KEY.esc)
  await waitFor(() => !duckduckgoScrapingEnabled(), 4000)
  m.push(KEY.esc); await settle(120); m.unmount(); await settle(60)
  m = await open(); m.push(KEY.right)
  await waitFor(() => duckduckgoScrapingEnabled(), 4000)
  m.push(KEY.enter); await settle(160)
  assert.ok(duckduckgoScrapingEnabled()); m.unmount()
  console.log('PASS actual config row: default off, terms displayed, toggle effective immediately, escape reverts, Enter saves')
} finally { releaseScratchHome(HOME) }
