(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { contextWindowLabel } = await import('../../src/engine/context-window/contextFill.js')
const { fmtCtx } = await import('../../src/commands/model/picker/MercuryModelPicker.js')
const { localWindowWords, localUnloadedWindowWords } = await import('../../src/models/roads/local/localCatalogue.js')
type LocalModelRecord = import('../../src/models/roads/local/localDiscovery.js').LocalModelRecord
let checks = 0
let failures = 0
function check(label: string, pass: boolean, actual: string): void {
  checks++
  if (!pass) failures++
  const hint = label.includes('gauge') ? ' (fix contextWindowLabel in src/engine/context-window/contextFill.ts)'
    : label.includes('picker') ? ' (fix fmtCtx in src/screen/model-picker/choice.ts)'
    : label.includes('notice') ? ' (fix localWindowWords in src/models/roads/local/localCatalogue.ts)'
    : label.includes('unloaded') ? ' (fix localUnloadedWindowWords in src/models/roads/local/localCatalogue.ts)'
    : ' (fix contextWindowLabel in src/engine/context-window/contextFill.ts)'
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${actual}${pass ? '' : hint}`)
}
const label = contextWindowLabel as (n: number, source: 'live-current' | 'fallback', pinned: boolean, local: boolean) => string
const picker = fmtCtx as (n: number, local: boolean) => string
for (const [tokens, expected, pickerExpected = expected, noticeExpected = pickerExpected] of [[32768, '32k'], [65536, '64k'], [131072, '128k'], [262144, '256k'], [1048576, '1024k', '1M'], [2097152, '2048k', '2M'], [1572864, '1536k'], [1000000, '1000k', '1M', '1000k'], [33000, '33k']] as const) {
  check(`${tokens}: local gauge`, label(tokens, 'live-current', false, true) === expected, label(tokens, 'live-current', false, true))
  check(`${tokens}: local picker`, picker(tokens, true) === pickerExpected, picker(tokens, true))
  const record = { server: 'ollama', contextWindow: { tokens, source: 'served' }, modelMaxContext: tokens, loaded: false } as LocalModelRecord
  check(`${tokens}: local notice`, localWindowWords(record) === `${noticeExpected} ctx · served`, localWindowWords(record))
  check(`${tokens}: unloaded local maximum`, localUnloadedWindowWords(record).includes(`trained maximum ${noticeExpected} ·`), localUnloadedWindowWords(record))
  const hosted = `${Math.round(tokens / 1000)}k`
  check(`${tokens}: hosted gauge unchanged`, label(tokens, 'live-current', false, false) === hosted, label(tokens, 'live-current', false, false))
  const hostedPicker = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` : hosted
  check(`${tokens}: hosted picker unchanged`, picker(tokens, false) === hostedPicker, picker(tokens, false))
}
check('fallback and pin survive local formatting', label(32768, 'fallback', true, true) === '~32k pin', label(32768, 'fallback', true, true))
check('missing window stays absent', label(0, 'fallback', false, true) === '—', label(0, 'fallback', false, true))
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
