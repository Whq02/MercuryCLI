#!/usr/bin/env bun
// gate-watch: src/components/SurfaceExitChord.tsx src/components/PromptInput/ExitChordNotice.tsx
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('exit-notice-owns-its-row')
delete process.env.MERCURY_HOME
process.env.MERCURY_HEALTH_STATE_DIR = join(HOME, 'health-state')
Object.assign(process.env, {
  MERCURY_FULLSCREEN: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true',
})

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
const { SurfaceExitChordNotice } = await import('../../src/components/SurfaceExitChord.tsx')
const { exitChordNoticeText } = await import('../../src/components/PromptInput/ExitChordNotice.tsx')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const BENEATH = 'f'
const NOTICE = exitChordNoticeText('Ctrl-C')
const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

function Surface({ columns, rows, pending }: { columns: number; rows: number; pending: boolean }): React.ReactNode {
  return h(Box, { width: columns, height: rows, flexDirection: 'column' },
    h(Box, { flexGrow: 1 }),
    h(Text, { wrap: 'truncate-end' }, BENEATH.repeat(columns)),
    h(SurfaceExitChordNotice, { pending }))
}

console.log('the exit notice of a surface route owns the row it is written on')
for (const [columns, rows] of [[80, 24], [120, 40], [213, 60], [44, 12]] as Array<[number, number]>) {
  const scene = await mountOffscreen(wrap(h(Surface, { columns, rows, pending: false })), columns, rows)
  try {
    await settledFrame(scene, frame => frame.includes(BENEATH.repeat(8)))
    check(`${columns}x${rows}: with no press the row beneath stands whole`, (scene.lines()[rows - 1] ?? '') === BENEATH.repeat(columns), JSON.stringify(scene.lines()[rows - 1] ?? ''))
    scene.resize(wrap(h(Surface, { columns, rows, pending: true })), columns, rows)
    await settledFrame(scene, frame => frame.includes(NOTICE))
    const row = scene.lines()[rows - 1] ?? ''
    check(`${columns}x${rows}: after one press the last row is the notice and nothing else: no cell of the row beneath shows after it`, row.trimEnd() === `  ${NOTICE}` && !row.includes(BENEATH.repeat(2)), JSON.stringify(row))
    check(`${columns}x${rows}: the notice stands on that row alone`, scene.lines().slice(0, rows - 1).every(line => !line.includes(NOTICE)))
    scene.resize(wrap(h(Surface, { columns, rows, pending: false })), columns, rows)
    await settledFrame(scene, frame => !frame.includes(NOTICE) && frame.includes(BENEATH.repeat(8)))
    check(`${columns}x${rows}: the press forgotten, the row beneath returns whole`, (scene.lines()[rows - 1] ?? '') === BENEATH.repeat(columns), JSON.stringify(scene.lines()[rows - 1] ?? ''))
  } finally {
    scene.unmount()
  }
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? `\nexit-notice-owns-its-row: ${checks} checks, ALL PASS` : `\nexit-notice-owns-its-row: ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
