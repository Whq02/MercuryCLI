import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { mountOffscreen, pinSourceRef, waitFor } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Use a scratch MERCURY_CONFIG_DIR (it outranks MERCURY_HOME, so a pinned suite home is fine)')
pinSourceRef()
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.BROWSER = '/usr/bin/true'
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(key)) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const React = await import('react')
const { Box } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { ModalContext } = await import('../../src/context/modalContext.tsx')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const rung = await import('../../src/utils/model/defaultProviderRung.ts')
let switched = ''
mock.module('../../src/utils/model/defaultProviderRung.ts', () => ({ ...rung, switchDefaultProvider: (family: string) => { switched = family; return true } }))
const defaults = await import('../../src/utils/model/computedDefault.ts')
mock.module('../../src/utils/model/computedDefault.ts', () => ({ ...defaults, computedDefault: () => ({ provider: null, row: 'No sign-in yet', considered: [] }), describeComputedDefault: () => 'No sign-in yet' }))
const usage = await import('../../src/services/providers/providerUsage.ts')
mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...usage, providerFamilyPresences: () => [] }))
const { call } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const h = React.createElement
let failures = 0
let checks = 0
const check = (name: string, good: boolean, detail = '') => { checks++; if (!good) failures++; console.log(`[${good ? 'PASS' : 'FAIL'}] ${name}${!good ? ' — ' + detail : ''}`) }
for (const modal of [true, false]) for (const cols of [80, 120]) {
  let closed = false
  switched = ''
  const body = await call(() => { closed = true }, {} as never, '')
  const host = modal ? h(ModalContext.Provider, { value: { rows: 20, columns: cols - 4, scrollRef: null } }, h(Box, { width: cols - 4, height: 20, flexDirection: 'column' }, body)) : h(Box, { width: cols, height: 24, flexDirection: 'column' }, body)
  const scene = await mountOffscreen(h(ThemeProvider, {}, h(AppStateProvider, {}, h(KeybindingSetup, {}, host))), cols, 24)
  const focus = () => scene.lines()[scene.cursor().y]?.trim() ?? ''
  try {
    await settledFrame(scene, text => text.includes('Default provider'))
    const first = focus()
    check(`${cols}: footer teaches move, page, select and close within the host`, /↑↓ move/.test(scene.screen()) && /pgup\/pgdn page/.test(scene.screen()) && /↵ sets · esc closes/.test(scene.screen()), scene.screen())
    check(`${cols}: hidden providers have a separate lower edge marker`, scene.lines().some(line => /↓\s*$/.test(line) && !/↑↓/.test(line)), scene.screen())
    scene.push('\x1b[6~')
    check(`${cols}: PageDown moves to a visible provider`, await waitFor(() => focus() !== first && /not connected/.test(focus()), 1800), scene.screen())
    const page = focus()
    check(`${cols}: one page does not skip the whole catalogue`, !page.includes('Qwen'), page)
    check(`${cols}: the explanation is not overlapped by the list`, scene.screen().replace(/\s+/g, ' ').includes('Explicit /model picks always win.'), scene.screen())
    scene.push('\x1b[5~')
    check(`${cols}: PageUp restores the first provider`, await waitFor(() => focus() === first, 1800), scene.screen())
    scene.push('\x1b[F')
    await settledFrame(scene)
    check(`${cols}: the final provider and close guide remain reachable`, /not connected/.test(focus()) && scene.screen().includes('esc closes'), scene.screen())
    if (frames) {
      const name = join(frames, `defaultprovider-${modal ? 'modal' : 'standalone'}-${cols}`)
      writeFileSync(name + '.txt', scene.screen())
      const grid = scene.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const style = scene.styleAt(x, y); return { c, fg: style?.fg ?? 'default', bg: style?.bg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
      writeFileSync(name + '.json', JSON.stringify({ grid, cols, rows: 24 }))
      await gridToPng(name + '.json', name + '.png')
    }
    scene.push('\r')
    check(`${cols}: Enter switches only the injected provider callback`, await waitFor(() => switched !== '' && closed, 1800), switched)
    assert.notEqual(page, '')
  } finally { scene.unmount() }
}
console.log(`defaultprovider-popup: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
