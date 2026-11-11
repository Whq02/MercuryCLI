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
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { ModelPickerPopupLease } = await import('../../src/components/ModelPickerPopupSlot.tsx')
const { claimModelPickerPopup } = await import('../../src/utils/cockpit/modelPickerPopup.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { pickerColumns } = await import('../../src/utils/model/modelPickerGroups.ts')
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
const models = [
  { id: 'vendor/long-family/model-alpha', name: 'Model A', ctx: '1.31M ctx', tag: '', group },
  { id: 'vendor/long-family/model-beta', name: 'Model B', ctx: '200k ctx', tag: '', group },
  { id: 'vendor/long-family-of-models/second-series/model-gamma', name: 'Model C', ctx: '200k ctx', tag: '', group },
  { id: 'vendor/long-family-of-models/second-series/model-delta', name: 'Model D', ctx: '200k ctx', tag: '', group },
]
const columnsFor = (width: number): number => Object.values(pickerColumns(width)).reduce((sum, column) => sum + column, 0)
for (const width of [49, 50, 55, 56, 64, 80, 92]) check(`the column plan fits ${width} cells`, columnsFor(width) <= width, String(columnsFor(width)))
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
    check(`${columns}x${rows}: the alias and current state stay whole`, first.includes('Model A') && first.includes('current') && second.includes('Model B'), first)
    check(`${columns}x${rows}: the context cells stay whole`, first.includes('1.31M ctx') && second.includes('200k ctx'), `${first}\n${second}`)
    const third = lines.find(line => line.includes('gamma')) ?? lines.find(line => line.includes('vendor/long-family-of')) ?? ''
    const fourth = lines.find(line => line.includes('delta')) ?? lines.findLast(line => line.includes('vendor/long-family-of')) ?? ''
    check(`${columns}x${rows}: an id its cell cannot hold keeps its end behind a leading ellipsis, so two ids of one family read apart`, /…\S*gamma\s/.test(third) && /…\S*delta\s/.test(fourth) && !third.includes('vendor/') && !fourth.includes('vendor/'), `${third.trim()}\n${fourth.trim()}`)
    if (columns === 60) check('60x20: clipped ids keep distinct model tails', first.includes('…') && first.includes('alpha') && second.includes('…') && second.includes('beta'), `${first}\n${second}`)
    if (columns === 63) check('63x20: TensorFold keeps the original alias budget at its rounding boundary', first.includes('Model Alpha') && second.includes('Model Beta'), `${first}\n${second}`)
  } finally { scene.unmount() }
}
console.log(`picker-narrow-columns: ${checks} checks, ${failures} failed`)
await releaseScratchHome(home)
process.exit(failures === 0 ? 0 : 1)
