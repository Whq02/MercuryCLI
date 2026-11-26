import React from 'react'
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('named-endpoint-logins')
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider: { east: { baseUrl: 'http://127.0.0.1:1/east/v1', models: ['Fixture'] }, west: { baseUrl: 'http://127.0.0.1:1/west/v1', models: ['Fixture'] } } }))
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const notifications = await import('../../src/screen/notifications/notifications.js')
mock.module('../../src/screen/notifications/notifications.js', () => ({ ...notifications, useNotifications: () => ({ addNotification() {}, removeNotification() {} }) }))
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { PopupHost } = await import('../../src/screen/overlays/PopupHost.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const popup = await import('../../src/screen/cockpit/settingsPopup.js')
const { call } = await import('../../src/commands/logins/login.js')
const { loginFamilyRows } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { readStoredCompatApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
let failures = 0
function check(name: string, pass: boolean, detail = '') { if (!pass) failures++; console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${!pass ? ` ${detail}` : ''}`) }
const rows = loginFamilyRows({ engineLegs: true })
check('the live logins roster includes both endpoint names', rows.some(row => row.value === 'compat/east') && rows.some(row => row.value === 'compat/west'), 'hint: loginFamilyRows in src/models/sign-in/flow-cards/loginFamilyRows.ts must list a compat/<name> row for each named endpoint of configuredCompatEndpoints; rows: ' + rows.map(row => row.value).join(','))
try {
  for (const [columns, height] of [[80, 24], [120, 40]]) {
    let receipt = ''
    const host = React.createRef<import('../../src/screen/themedRenderer.js').DOMElement>()
    const mounted = await mountOffscreen(React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(KeybindingSetup, {},
      React.createElement(Box, { width: columns, height, flexDirection: 'column' },
        React.createElement(Box, { ref: host, height, flexDirection: 'column' }, React.createElement(Text, {}, 'Fixture chat')),
        React.createElement(PopupHost, { hostRef: host, children: host => React.createElement(SettingsPopupSlot, { host, overlay: true }) }),
      )))), columns!, height!)
    await call((text: string | undefined) => { receipt = text ?? '' }, { onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} } as never, 'compat/east')
    try {
      check(`${columns} columns: the requested endpoint is in view and focused`, await waitFor(() => mounted.screen().includes('east (east)'), 3000), 'hint: the login call with compat/east must focus the east row of the logins list (src/commands/logins/login.tsx, src/models/sign-in/flow-cards/loginFamilyRows.ts); screen: ' + mounted.screen())
      mounted.push(KEY.enter)
      check(`${columns} columns: Enter opens the endpoint key field`, await waitFor(() => mounted.screen().includes('Endpoint east — API key') && mounted.screen().includes('Key:'), 3000), 'hint: Enter on the endpoint row must open the key field drawn by src/models/sign-in/flow-cards/CompatConnect.tsx; screen: ' + mounted.screen())
      const fixture = 'proof-key-east-login-fixture-not-a-real-key'
      mounted.push(fixture)
      check(`${columns} columns: key entry is masked`, await waitFor(() => /Key: \*+/.test(mounted.screen()), 3000) && !mounted.screen().includes(fixture), 'hint: the key field in src/models/sign-in/flow-cards/CompatConnect.tsx must show asterisks, never the typed key; screen: ' + mounted.screen())
      mounted.push(KEY.enter)
      check(`${columns} columns: the stored-key receipt is visible`, await waitFor(() => mounted.screen().includes('east API key stored'), 3000), 'hint: Enter on the key must store it and show the receipt of src/models/roads/openaicompat/compatLogin.ts; screen: ' + mounted.screen())
      mounted.push(KEY.enter)
      check(`${columns} columns: the real writer stores only east and returns its receipt`, await waitFor(() => receipt.includes('east API key stored'), 3000) && readStoredCompatApiKey('east') === fixture && readStoredCompatApiKey('west') === undefined, 'hint: the writer in src/models/roads/openaicompat/compatLogin.ts must store the key for east only and hand its receipt back through the login call (src/commands/logins/login.tsx); receipt: ' + receipt)
    } finally { popup.closeSettingsPopup(); mounted.unmount() }
  }
  console.log(failures ? `NAMED ENDPOINT LOGINS RED (${failures})` : 'NAMED ENDPOINT LOGINS GREEN')
} finally { await releaseScratchHome(home) }
process.exit(failures ? 1 : 0)
