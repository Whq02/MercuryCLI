#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('rails-whole-or-absent')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_HEALTH_STATE_DIR = join(HOME, 'health-state')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE']) process.env[base] = 'http://127.0.0.1:9'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const arg = (key: string): string | undefined => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const SIZES: Array<[number, number]> = (arg('--sizes')?.split(',') ?? ['100x30', '120x40', '160x50', '177x49', '213x60']).map(size => size.split('x').map(Number) as [number, number])
const PANE_ROWS = [4, 5, 6, 7, 9, 12, 20] as const

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

const SOLID = 'T'
const BAND = 'B'
const CARD = 'the card that takes the rows'

function Harness({ columns, cardRows }: { columns: number; cardRows: number }): React.ReactNode {
  return h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 120 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, SOLID.repeat(columns)))),
    statusBand: h(Text, { wrap: 'truncate-end' }, BAND.repeat(columns)),
    statusBandActive: false,
    bottom: h(Box, { height: cardRows, flexShrink: 0, borderStyle: 'round', flexDirection: 'column' }, h(Text, { wrap: 'truncate-end' }, CARD)),
  } as never)
}
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))


const { getHelmRows } = await import('../../src/utils/cockpit/helmFocus.ts')
function tornRailBoxes(lines: string[], columns: number, paneRows: number): string[] {
  const paneLeft = (lines[0] ?? '').indexOf('╭')
  const paneRight = (lines[0] ?? '').indexOf('╮', paneLeft + 1)
  const tears: string[] = []
  for (let y = 0; y < paneRows; y++) {
    const row = Array.from(lines[y] ?? '')
    for (let x = 0; x < columns; x++) {
      if (x >= paneLeft && x <= paneRight || row[x] !== '╭') continue
      const right = row.indexOf('╮', x + 1)
      let bottom = y + 1
      while (bottom < paneRows && Array.from(lines[bottom] ?? '')[x] === '│') bottom++
      if (right < 0 || bottom >= paneRows || Array.from(lines[bottom] ?? '')[x] !== '╰' || Array.from(lines[bottom] ?? '')[right] !== '╯') tears.push(`${x},${y} → ${bottom}`)
    }
  }
  return tears
}
for (const [columns, rows] of SIZES) {
  resetChromeModeLatchForTests(); resetOverlayStackForTests(); initializeSurfaceRoute(ROOT_CHAT_ROUTE); layoutChromeLive(columns, rows)
  const scene = await mountOffscreen(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
  try {
    await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
    const rest = scene.screen()
    if (frameDir) writeFileSync(join(frameDir, `${columns}x${rows}-rest.txt`), scene.lines().join('\n') + '\n')
    for (const paneRows of PANE_ROWS) {
      scene.resize(wrap(h(Harness, { columns, cardRows: rows - paneRows })), columns, rows)
      await settledFrame(scene, frame => frame.includes(CARD) && (frame.split('\n')[paneRows] ?? '').startsWith('╭' + '─'.repeat(columns - 2) + '╮'))
      const lines = scene.lines()
      if (frameDir) writeFileSync(join(frameDir, `${columns}x${rows}-pane-${paneRows}.txt`), lines.join('\n') + '\n')
      const torn = tornRailBoxes(lines, columns, paneRows)
      check(`${columns}x${rows}, pane ${paneRows}: every rail box closes`, torn.length === 0, torn.join('; '))
      if (paneRows === 6) {
        check(`${columns}x${rows}: only the whole workbench row is published on the left`, getHelmRows('lanes').length === 1, JSON.stringify(getHelmRows('lanes')))
        if (columns >= 160) check(`${columns}x${rows}: no clipped usage row is published on the right`, getHelmRows('vitals').length === 0, JSON.stringify(getHelmRows('vitals')))
      }
    }
    scene.resize(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
    await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
    check(`${columns}x${rows}: the card gone, the screen returns byte for byte`, scene.screen() === rest)
  } finally { scene.unmount() }
}
console.log(`rails-whole-or-absent: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)
