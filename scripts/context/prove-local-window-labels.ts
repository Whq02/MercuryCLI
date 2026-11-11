import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { contextWindowLabel } = await import('../../src/utils/contextFill.js')
const { fmtCtx } = await import('../../src/components/MercuryModelPicker.js')
const { localWindowWords, localUnloadedWindowWords } = await import('../../src/services/providers/local/localCatalogue.js')
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.js').LocalModelRecord
let checks = 0
let failures = 0
function check(label: string, pass: boolean, actual: string): void {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${actual}`)
}
const label = contextWindowLabel as (n: number, source: 'live-current' | 'fallback', pinned: boolean, local: boolean) => string
const picker = fmtCtx as (n: number, local: boolean) => string
for (const [tokens, expected] of [[32768, '32k'], [65536, '64k'], [131072, '128k'], [262144, '256k'], [1048576, '1024k'], [33000, '33k']] as const) {
  check(`${tokens}: local gauge`, label(tokens, 'live-current', false, true) === expected, label(tokens, 'live-current', false, true))
  check(`${tokens}: local picker`, picker(tokens, true) === expected, picker(tokens, true))
  const record = { server: 'ollama', contextWindow: { tokens, source: 'served' }, modelMaxContext: tokens, loaded: false } as LocalModelRecord
  check(`${tokens}: local notice`, localWindowWords(record) === `${expected} ctx · served`, localWindowWords(record))
  check(`${tokens}: unloaded local maximum`, localUnloadedWindowWords(record).includes(`trained maximum ${expected} ·`), localUnloadedWindowWords(record))
  const hosted = `${Math.round(tokens / 1000)}k`
  check(`${tokens}: hosted gauge unchanged`, label(tokens, 'live-current', false, false) === hosted, label(tokens, 'live-current', false, false))
  const hostedPicker = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` : hosted
  check(`${tokens}: hosted picker unchanged`, picker(tokens, false) === hostedPicker, picker(tokens, false))
}
check('fallback and pin survive local formatting', label(32768, 'fallback', true, true) === '~32k pin', label(32768, 'fallback', true, true))
check('missing window stays absent', label(0, 'fallback', false, true) === '—', label(0, 'fallback', false, true))
const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
for (const [path, model] of [['src/utils/cockpit/helmLanesModel.ts', 'reads.sessionModel'], ['src/utils/cockpit/helmVitalsModel.ts', 'input.sessionModel'], ['src/components/DeckPane.tsx', 'rawModel']] as const) {
  const source = read(path)
  check(`${path} passes its model's local identity`, source.includes(`contextWindowLabel(ctx.window, ctx.windowSource, ctx.windowPinned, isLocalModelId(${model}))`), model)
}
check('the picker row passes its model identity', read('src/commands/model/mercuryModel.tsx').includes('fmtCtx(opt.statedContextWindow, isLocalModelId(opt.value))'), 'stated window uses the row id')
check('the glance receives the focused model', read('src/components/HelmLanesRail.tsx').includes('sessionModel: getFocusedSessionConnector().modelFacts().effective'), 'focused model')
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
