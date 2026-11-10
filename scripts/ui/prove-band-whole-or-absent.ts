#!/usr/bin/env bun
// gate-watch: src/components/FullscreenLayout.tsx src/components/PopupGutter.tsx src/components/ModelPickerPopupSlot.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('band-whole-or-absent')
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
const SIZES: Array<[number, number]> = (arg('--sizes')?.split(',') ?? ['100x30', '120x44', '160x50', '200x60']).map(size => size.split('x').map(Number) as [number, number])
const PANE_ROWS = [4, 5, 6, 7, 9] as const
const BAND_ROWS = 5

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

type Reading = { paneLeft: number; paneRight: number; paneBottom: number; bandOpens: boolean; bandCloses: number; bandWords: boolean; transcriptCells: number; rows: string[] }
function readPane(lines: string[], columns: number): Reading | null {
  const screen = lines.map(line => { const cells = Array.from(line); while (cells.length < columns) cells.push(' '); return cells })
  const top = screen[0] ?? []
  const paneLeft = top.indexOf('╭')
  const paneRight = paneLeft < 0 ? -1 : top.indexOf('╮', paneLeft + 1)
  if (paneLeft < 0 || paneRight < 0) return null
  let paneBottom = -1
  for (let y = 1; y < screen.length; y++) if (screen[y]![paneLeft] === '╰') { paneBottom = y; break }
  if (paneBottom < 0) return null
  const bandOpens = paneBottom > 1 && screen[1]![paneLeft + 1] === '╭'
  let bandCloses = -1
  if (bandOpens) for (let y = 2; y < paneBottom; y++) if (screen[y]![paneLeft + 1] === '╰') { bandCloses = y; break }
  const inner = screen.slice(1, paneBottom).map(cells => cells.slice(paneLeft + 1, paneRight).join(''))
  return { paneLeft, paneRight, paneBottom, bandOpens, bandCloses, bandWords: inner.some(row => row.includes(BAND.repeat(8))), transcriptCells: inner.reduce((sum, row) => sum + Array.from(row).filter(glyph => glyph === SOLID).length, 0), rows: lines.slice(0, paneBottom + 1) }
}
const shown = (reading: Reading | null): string => (reading === null ? 'no centre pane on the first row' : `\n${reading.rows.map(row => row.slice(0, 110)).join('\n')}`)

for (const [columns, rows] of SIZES) {
  console.log(`\n${columns}x${rows}: the status band under a card that leaves the cockpit a few rows`)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  layoutChromeLive(columns, rows)
  const scene = await mountOffscreen(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
  try {
    await settledFrame(scene, frame => frame.includes(CARD) && frame.includes(BAND.repeat(8)))
    const rest = readPane(scene.lines(), columns)
    check(`${columns}x${rows} with a three-row card the band stands whole over the transcript`, rest !== null && rest.bandOpens && rest.bandCloses === BAND_ROWS && rest.bandWords && rest.transcriptCells > 0, shown(rest))
    for (const paneRows of PANE_ROWS) {
      scene.resize(wrap(h(Harness, { columns, cardRows: rows - paneRows })), columns, rows)
      await settledFrame(scene, frame => frame.includes(CARD) && readPane(frame.split('\n'), columns)?.paneBottom === paneRows - 1)
      const reading = readPane(scene.lines(), columns)
      if (frameDir) writeFileSync(join(frameDir, `${columns}x${rows}-pane-${paneRows}.txt`), `${scene.lines().join('\n')}\n`)
      const fits = paneRows - 2 >= BAND_ROWS
      check(`${columns}x${rows} a pane of ${paneRows} rows: the band's box is whole or absent, never open without its closing row`, reading !== null && (!reading.bandOpens || reading.bandCloses > 0), shown(reading))
      if (fits) check(`${columns}x${rows} a pane of ${paneRows} rows holds the band's ${BAND_ROWS}: the band stands whole with its words`, reading !== null && reading.bandOpens && reading.bandCloses === BAND_ROWS && reading.bandWords, shown(reading))
      else check(`${columns}x${rows} a pane of ${paneRows} rows cannot hold the band's ${BAND_ROWS}: no row of the band paints and the transcript takes the pane`, reading !== null && !reading.bandOpens && !reading.bandWords && reading.transcriptCells > 0, shown(reading))
    }
    scene.resize(wrap(h(Harness, { columns, cardRows: 3 })), columns, rows)
    await settledFrame(scene, frame => frame.includes(CARD) && (readPane(frame.split('\n'), columns)?.paneBottom ?? 0) > 9)
    const back = readPane(scene.lines(), columns)
    check(`${columns}x${rows} the card gone, the band is back whole where it stood`, back !== null && rest !== null && back.bandOpens && back.bandCloses === BAND_ROWS && back.bandWords && back.rows.slice(0, BAND_ROWS + 1).join('\n') === rest.rows.slice(0, BAND_ROWS + 1).join('\n'), shown(back))
  } finally {
    scene.unmount()
  }
}

console.log(`\nband-whole-or-absent: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)
