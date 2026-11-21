process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getDefaultEngineModel } = await import('../../src/services/model/model.js')
const { contextGauge, CONTEXT_FRESH_SESSION_REASON } = await import('../../src/services/cockpit/contextGauge.js')
let failures = 0
function check(name: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}
const fresh = contextGauge([], getDefaultEngineModel())
check('the owner names a fresh context without a made-up percentage', fresh.state === 'unavailable' && fresh.reason === CONTEXT_FRESH_SESSION_REASON && fresh.data.usedPct === null)
console.log(`fresh context: ${failures} failures`)
process.exit(failures ? 1 : 0)
