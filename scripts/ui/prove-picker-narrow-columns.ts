#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const home = pinScratchHome('picker-narrow-columns')
delete process.env.MERCURY_HOME
Object.assign(process.env, { MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' })
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'NODE_ENV']) delete process.env[key]
for (const key of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[key] = 'http://127.0.0.1:9'
const arg = (name: string): string | undefined => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const React = await import('react')
const h = React.createElement
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { MercuryModelPicker } = await import('../../src/commands/model/picker/MercuryModelPicker.tsx')
const { ModelPickerPopupLease } = await import('../../src/screen/overlays/ModelPickerPopupSlot.tsx')
const { claimModelPickerPopup } = await import('../../src/screen/cockpit/modelPickerPopup.ts')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const { pickerColumns, pickerIdSpan, pickerIdText } = await import('../../src/models/facts/modelPickerGroups.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const group = 'Mercury — OpenRouter models'
const ROOM_HINT = 'the id takes the blank cells of its own row before they stay padding: check pickerIdSpan in src/models/facts/modelPickerGroups.ts and idAndState in src/screen/model-picker/renderLine.tsx'
const CUT_HINT = 'change pickerIdText in src/models/facts/modelPickerGroups.ts'
const models = [
  { id: 'vendor/long-family/model-alpha', name: 'Model A', ctx: '1.31M ctx', tag: '', group },
  { id: 'vendor/long-family/model-beta', name: 'Model B', ctx: '200k ctx', tag: '', group },
  { id: 'vendor/long-family-of-models/second-series/model-gamma', name: 'Model C', ctx: '200k ctx', tag: '', group },
  { id: 'vendor/long-family-of-models/second-series/model-delta', name: 'Model D', ctx: '200k ctx', tag: '', group },
]
const columnsFor = (width: number): number => Object.values(pickerColumns(width)).reduce((sum, column) => sum + column, 0)
for (const width of [49, 50, 55, 56, 64, 80, 92]) check(`the column plan fits ${width} cells`, columnsFor(width) <= width, `${columnsFor(width)}; shrink the column widths pickerColumns returns in src/models/facts/modelPickerGroups.ts so their sum stays within the row width`)
{
  const grid = pickerColumns(84)
  const span = grid.id + grid.state
  const widths = (idWidth: number, stateWidth: number, spare: number): string => Object.values(pickerIdSpan(grid, idWidth, stateWidth, spare)).join('+')
  check('an id its own cell holds leaves both cells as the column plan has them', widths(16, 0, grid.tail) === `${grid.id}+${grid.state}` && widths(16, 7, grid.tail) === `${grid.id}+${grid.state}`, `${widths(16, 0, grid.tail)} ${widths(16, 7, grid.tail)}; ${ROOM_HINT}`)
  check('a longer id takes the blank cells of the state cell and the two cells still sum to their columns', widths(25, 0, 0) === `27+${span - 27}` && widths(25, 7, 0) === `27+${span - 27}` && widths(35, 0, 0) === `37+${span - 37}`, `${widths(25, 0, 0)} ${widths(25, 7, 0)} ${widths(35, 0, 0)}; ${ROOM_HINT}`)
  check('past the state cell an id reads whole only by the blank cells its row has after the ctx cell', widths(30, 7, grid.tail) === '32+9' && widths(30, 7, 0) === `${span - 9}+9` && widths(60, 0, grid.tail) === `${span}+0`, `${widths(30, 7, grid.tail)} ${widths(30, 7, 0)} ${widths(60, 0, grid.tail)}; ${ROOM_HINT}`)
  const snapshots = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20250801']
  const alone = pickerIdText(snapshots[0]!, 22, [snapshots[0]!, 'claude-haiku-5-5'])
  check('a long id no other row would read like is cut once, at its end', alone === 'claude-haiku-4-5-2025…', `${alone}; ${CUT_HINT}`)
  const apart = snapshots.map(id => pickerIdText(id, 22, snapshots))
  check('two ids that would read the same keep their starts and their dated ends around one ellipsis', apart[0] !== apart[1] && apart.every((text, index) => text.startsWith('claude-haiku-') && text.endsWith(snapshots[index]!.slice(-8)) && text.split('…').length === 2 && text.length <= 22), `${apart.join(' | ')}; ${CUT_HINT}`)
  const routed = ['openrouter/anthropic/claude-opus-5', 'openrouter/anthropic/claude-sonnet-5'].map((id, _, all) => pickerIdText(id, 24, all))
  check('the kept end is the whole word that tells two ids apart', routed[0]!.endsWith('…opus-5') && routed[1]!.endsWith('…sonnet-5') && routed.every(text => text.startsWith('openrouter/') && text.length === 24), `${routed.join(' | ')}; ${CUT_HINT}`)
  const narrow = ['openrouter/anthropic/claude-opus-5', 'openrouter/anthropic/claude-sonnet-5'].map((id, _, all) => pickerIdText(id, 12, all))
  check('a cell too narrow for more keeps the first word whole before the ellipsis', narrow.every(text => text.startsWith('openrouter…') && text.length <= 12), `${narrow.join(' | ')}; ${CUT_HINT}`)
  check('an id that fits is never touched', pickerIdText('claude-opus-5-5', 15, ['claude-opus-5-5', 'claude-opus-5']) === 'claude-opus-5-5', CUT_HINT)
}
for (const [columns, rows] of [[60, 20], [63, 20], [66, 20], [70, 20], [80, 24], [120, 40], [177, 49], [213, 60]]) {
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  claimModelPickerPopup()
  const choices = columns === 63 ? models.map((model, index) => ({ ...model, name: index === 0 ? 'Model Alpha' : 'Model Beta', tensorfold: { keys: {}, card: () => [], state: { text: 'current', tone: 'faint' as const } } })) : models
  const modal = h(ModelPickerPopupLease, null, h(MercuryModelPicker, { models: choices, current: models[0]!.id, ctxPct: null, topGroup: group, onClose: () => {} }))
  const tree = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(KeybindingSetup, null, h(FullscreenLayout, { scrollable: h(Text, null, 'the conversation'), bottom: h(Box, { height: 4 }, h(Text, null, 'the composer')), modal })) })
  const scene = await mountOffscreen(tree, columns!, rows!)
  try {
    await settledFrame(scene, frame => frame.includes('Mercury · model') && frame.includes('Model A') && frame.includes('Model B'))
    const lines = scene.lines()
    if (frameDir) writeFileSync(join(frameDir, `${columns}x${rows}.txt`), lines.join('\n') + '\n')
    const first = lines.find(line => line.includes('Model A')) ?? ''
    const second = lines.find(line => line.includes('Model B')) ?? ''
    check(`${columns}x${rows}: the alias and current state stay whole`, first.includes('Model A') && first.includes('current') && second.includes('Model B'), `${first}; the alias cell or state cell is clipped: check pickerColumns in src/models/facts/modelPickerGroups.ts and the cells in src/screen/model-picker/renderLine.tsx`)
    check(`${columns}x${rows}: the context cells stay whole`, first.includes('1.31M ctx') && second.includes('200k ctx'), `${first}\n${second}; the ctx cell is clipped: check pickerColumns in src/models/facts/modelPickerGroups.ts`)
    const third = lines.find(line => line.includes('gamma')) ?? lines.find(line => line.includes('vendor/long-family-of')) ?? ''
    const fourth = lines.find(line => line.includes('delta')) ?? lines.findLast(line => line.includes('vendor/long-family-of')) ?? ''
    if (columns! >= 177) check(`${columns}x${rows}: the two longest ids read whole in the room their rows have`, third.includes(`${models[2]!.id}  200k ctx`) && fourth.includes(`${models[3]!.id}  200k ctx`), `${third.trim()}\n${fourth.trim()}; ${ROOM_HINT}`)
    else check(`${columns}x${rows}: an id its row cannot hold keeps its start and its end around one ellipsis, so two ids of one family read apart`, /\svendor\/\S*…\S*gamma\s/.test(third) && /\svendor\/\S*…\S*delta\s/.test(fourth), `${third.trim()}\n${fourth.trim()}; a cut id begins with its own start and keeps the end that tells it from its sibling: check pickerIdText in src/models/facts/modelPickerGroups.ts and idAndState in src/screen/model-picker/renderLine.tsx`)
    check(`${columns}x${rows}: no id is cut at its start`, [first, second, third, fourth].every(row => !/\s…\S/.test(row)), `${[first, second, third, fourth].map(row => row.trim()).join('\n')}; an id never begins with the ellipsis: check pickerIdText in src/models/facts/modelPickerGroups.ts`)
    if (columns === 60) check('60x20: clipped ids keep distinct model tails', first.includes('…') && first.includes('alpha') && second.includes('…') && second.includes('beta'), `${first}\n${second}; two cut ids of one family keep the ends that tell them apart: ${CUT_HINT}`)
    if (columns === 63) check('63x20: TensorFold keeps the original alias budget at its rounding boundary', first.includes('Model Alpha') && second.includes('Model Beta'), `${first}\n${second}; the alias width at this width lost its budget: check pickerColumns in src/models/facts/modelPickerGroups.ts and the alias cell in src/screen/model-picker/renderLine.tsx`)
  } finally { scene.unmount() }
}
const dated = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', ctx: '1M ctx', tag: '', group },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', ctx: '1M ctx', tag: '', group },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', ctx: '200k ctx', tag: '', group },
]
for (const [columns, rows] of [[80, 24], [100, 30], [120, 40]]) {
  for (const current of [dated[0]!.id, dated[2]!.id]) {
    resetChromeModeLatchForTests()
    resetOverlayStackForTests()
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    claimModelPickerPopup()
    const modal = h(ModelPickerPopupLease, null, h(MercuryModelPicker, { models: dated, current, ctxPct: null, topGroup: group, onClose: () => {} }))
    const tree = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(KeybindingSetup, null, h(FullscreenLayout, { scrollable: h(Text, null, 'the conversation'), bottom: h(Box, { height: 4 }, h(Text, null, 'the composer')), modal })) })
    const scene = await mountOffscreen(tree, columns!, rows!)
    try {
      await settledFrame(scene, frame => frame.includes('Mercury · model') && frame.includes('Haiku 4.5'))
      const lines = scene.lines()
      const listed = current === dated[0]!.id
      if (frameDir) writeFileSync(join(frameDir, `dated-${listed ? 'listed' : 'current'}-${columns}x${rows}.txt`), lines.join('\n') + '\n')
      const haiku = lines.find(line => line.includes('Haiku 4.5')) ?? ''
      const above = lines.find(line => line.includes('Haiku 5.5')) ?? ''
      if (listed) check(`${columns}x${rows}: a dated id reads whole in a row that has the room, and its ctx cell keeps the column`, /\sclaude-haiku-4-5-20251001\s{2,}200k ctx/.test(haiku) && haiku.indexOf('200k ctx') === above.indexOf('1M ctx'), `${above.trim()}\n${haiku.trim()}; ${ROOM_HINT}`)
      else check(`${columns}x${rows}: the same id reads whole when its row is the current one`, /\sclaude-haiku-4-5-20251001\s{2,}current\s{2,}200k ctx/.test(haiku), `${haiku.trim()}; ${ROOM_HINT}`)
    } finally { scene.unmount() }
  }
}
console.log(`picker-narrow-columns: ${checks} checks, ${failures} failed`)
await releaseScratchHome(home)
process.exit(failures === 0 ? 0 : 1)
