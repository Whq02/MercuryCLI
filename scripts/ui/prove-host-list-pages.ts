#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef, pinScratchHome, mountOffscreen, waitFor, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const home = pinScratchHome('host-list-pages')
delete process.env.MERCURY_HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const arg = (name: string): string | undefined => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const frames = arg('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { LlmHostDialog } = await import('../../src/commands/llmhost/LlmHostDialog.tsx')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
type Road = NonNullable<React.ComponentProps<typeof LlmHostDialog>['road']>
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
for (const [columns, rows, budget] of [[80, 24, 8], [120, 40, 28]] as const) {
  let chosen: string | null | undefined
  let closed = false
  const road: Road = async ask => {
    chosen = await ask({ step: 'door-bank', title: 'Bank', found: 'the local weights folder\nBanked: 0 of 40 models · 0 B', willRun: '', initial: '0', rows: Array.from({ length: 40 }, (_, i) => ({ value: String(i), label: `Model ${String(i).padStart(2, '0')} · not banked` })) })
    return { ok: true, words: chosen === null ? 'Closed' : `Selected ${chosen}` }
  }
  function Frame(): React.ReactNode {
    const [line, setLine] = React.useState('Bank')
    const [hint, setHint] = React.useState<string | null>('')
    return h(Box, { width: columns, flexDirection: 'column', borderStyle: 'round', paddingX: 1 }, h(Text, null, line), h(LlmHostDialog, { width: columns - 4, rowBudget: budget, road, onLine: setLine, onHint: setHint, onClose: () => { closed = true } }), h(Text, { wrap: 'wrap' }, hint))
  }
  const scene = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(Frame) }), columns, rows)
  const selected = (): number => Number(/› Model (\d+)/.exec(scene.screen())?.[1] ?? '-1')
  try {
    await settledFrame(scene, frame => frame.includes('Model 00'))
    const initial = scene.screen()
    if (frames) writeFileSync(join(frames, `${columns}x${rows}.txt`), initial)
    check(`${columns}x${rows}: both Bank detail lines are visible`, initial.includes('the local weights folder') && initial.includes('Banked: 0 of 40 models · 0 B'), 'the question rows must show both found lines inside rowBudget: check the detail layout in src/commands/llmhost/LlmHostDialog.tsx')
    check(`${columns}x${rows}: the hint assigns paging to the list, not the details`, initial.includes('pgup/pgdn page') && !initial.includes('pgup/pgdn details'), 'the hint string built in src/commands/llmhost/LlmHostDialog.tsx must show the choices page hint and add pgup/pgdn details only when the details scroll')
    scene.push('\x1b[6~')
    await waitFor(() => selected() > 1, 1500)
    const page = selected()
    check(`${columns}x${rows}: PageDown reaches the next page of choices`, page > 1 && page < 40, `${page} — pgdn must move the selection by one page: check the useInput handler in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\x1b[5~')
    await waitFor(() => selected() === 0, 1500)
    check(`${columns}x${rows}: PageUp returns to the first choice`, selected() === 0, `selected row ${selected()} — pgup must return to row 0: check the useInput handler in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\x1b[B')
    await waitFor(() => selected() === 1, 1500)
    check(`${columns}x${rows}: Down selects the next choice`, selected() === 1, `selected row ${selected()} — down arrow must select row 1: check the useInput handler in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\x1b[<65;10;5M')
    await waitFor(() => selected() === 2, 1500)
    check(`${columns}x${rows}: the wheel selects the next choice`, selected() === 2, `selected row ${selected()} — a wheel-down event must select row 2: check the key.wheelDown branch in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\x1b[A')
    await waitFor(() => selected() === 1, 1500)
    check(`${columns}x${rows}: Up selects the previous choice`, selected() === 1, `selected row ${selected()} — up arrow must go back to row 1: check the useInput handler in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\r')
    check(`${columns}x${rows}: Enter chooses the highlighted row`, await waitFor(() => chosen === '1', 3000), `${String(chosen)} — Enter must answer the question with the highlighted row's value: check the useInput handler in src/commands/llmhost/LlmHostDialog.tsx`)
    scene.push('\x1b')
    check(`${columns}x${rows}: Escape closes the dialog`, await waitFor(() => closed, 3000), 'Escape must call onClose: check the key.escape branch in src/commands/llmhost/LlmHostDialog.tsx')
  } finally { scene.unmount() }
}
console.log(`host-list-pages: ${checks} checks, ${failures} failed`)
await releaseScratchHome(home)
process.exit(failures ? 1 : 0)
