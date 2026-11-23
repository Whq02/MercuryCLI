process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { getDefaultEngineModel } = await import('../../src/models/catalogue/engineModel.js')
const { contextGauge, CONTEXT_FRESH_SESSION_REASON } = await import('../../src/screen/cockpit-gauges/contextGauge.js')
let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok && detail) console.log(`  ${detail}`)
}
const fresh = contextGauge([], getDefaultEngineModel())
check('the owner names a fresh context without a made-up percentage', fresh.state === 'unavailable' && fresh.reason === CONTEXT_FRESH_SESSION_REASON && fresh.data.usedPct === null, `got state=${fresh.state} reason=${String(fresh.reason)} usedPct=${String(fresh.data.usedPct)}; contextGauge in src/screen/cockpit-gauges/contextGauge.ts must return state unavailable with CONTEXT_FRESH_SESSION_REASON and a null usedPct for an empty message list`)
console.log(`fresh context: ${failures} failures`)
process.exit(failures ? 1 : 0)
