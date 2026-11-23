import * as React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('logins-refusal-frames')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN|MERCURY_MODEL/.test(key)) delete process.env[key]
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { writeStoredOpenrouterApiKey, writeStoredDeepseekApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
const { captureSignInRequest, observeSignInResponse, readSignInRefusal } = await import('../../src/models/roads/signInRefusal.js')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const { call } = await import('../../src/commands/logins/login.js')
const { closeSettingsPopup } = await import('../../src/screen/cockpit/settingsPopup.js')
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const h = React.createElement
let failures = 0
function check(label: string, ok: boolean, detail = '') { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`) }
const estates = [
  { family: 'openrouter', label: 'OpenRouter', store: writeStoredOpenrouterApiKey },
  { family: 'deepseek', label: 'DeepSeek', store: writeStoredDeepseekApiKey },
]
try {
  for (const estate of estates) {
    const key = `fixture-${estate.family}-frame-key`
    estate.store(key)
    observeSignInResponse(captureSignInRequest(estate.family, key), 401)
    const time = new Date(readSignInRefusal(estate.family)!.at).toISOString().replace(/\.\d{3}Z$/, 'Z')
    for (const [cols, rows] of [[177, 49], [100, 30], [80, 24], [64, 20], [64, 12]]) {
      const ref = React.createRef<import('../../src/screen/themedRenderer.js').DOMElement>()
      const element = h(AppStateProvider as never, {}, h(ThemeProvider as never, {}, h(KeybindingSetup, {}, h(Box, { width: cols, height: rows, flexDirection: 'column' }, h(Box, { ref, height: rows, flexDirection: 'column' }, ...Array.from({ length: rows }, (_, i) => h(Text, { key: i }, 'CONTEXT'))), h(SettingsPopupSlot, { overlay: true, hostRef: ref })))))
      const scene = await mountOffscreen(element, cols!, rows!)
      const flat = () => scene.screen().replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ')
      const truth = () => flat().includes(`key refused (HTTP 401) at ${time} · /logins ${estate.family} reconnects`)
      const save = (part: string) => { if (frames) writeFileSync(join(frames, `${estate.family}-${cols}x${rows}-${part}.txt`), scene.screen()) }
      try {
        await call(() => {}, { onChangeAPIKey() {}, setMessages() {}, getAppState: () => ({}), setAppState() {} } as never, estate.family)
        check(`${estate.family} ${cols}x${rows}: menu shows full timed refusal and remedy`, await waitFor(truth, 10000), `${scene.screen()}\nthe /logins popup must show the line signInRefusalWords builds from src/models/roads/signInRefusal.ts for ${estate.family}; the screen above is what it drew`)
        check(`${estate.family} ${cols}x${rows}: the refused family stays selected`, scene.lines().some(line => line.includes(`❯ ${estate.label}`)), `${estate.label} row has no cursor; the /logins popup opened by src/commands/logins/login.tsx must start with the refused family selected`)
        save('menu')
        scene.push(KEY.enter)
        check(`${estate.family} ${cols}x${rows}: account keeps full refusal beside the sign-in action`, await waitFor(() => truth() && scene.screen().includes('Sign in / re-login'), 10000), `${scene.screen()}\nthe account page in src/models/sign-in/flow-cards/LoginAccountCard.tsx must keep the refusal line beside the Sign in / re-login action`)
        save('account')
        scene.push(KEY.esc)
        check(`${estate.family} ${cols}x${rows}: back returns to the refused family`, await waitFor(() => truth() && scene.lines().some(line => line.includes(`❯ ${estate.label}`)), 10000), `${scene.screen()}\nEsc on the account page (src/models/sign-in/flow-cards/LoginAccountCard.tsx) must return to the family list with the refusal still shown`)
      } finally { closeSettingsPopup(); scene.unmount() }
    }
    estate.store(null)
  }
} finally { await releaseScratchHome(home) }
console.log(failures ? `logins-refusal-frames: ${failures} FAILURE(S)` : 'logins-refusal-frames: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
