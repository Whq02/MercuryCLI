import { fixtureReads, buildFacts, model } from '../cockpit-interaction/status-popup-fixture.js'
const { contextGauge, CONTEXT_FRESH_SESSION_REASON } = await import('../../src/utils/cockpit/contextGauge.js')
let failures = 0
function check(name: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}
const fresh = contextGauge([], model)
check('the owner names a fresh context without a made-up percentage', fresh.state === 'unavailable' && fresh.reason === CONTEXT_FRESH_SESSION_REASON && fresh.data.usedPct === null)
const built = buildFacts([], model, { ...fixtureReads, context: contextGauge })
check('buildFacts stays exported and a fresh context raises no diagnostic', built.diagnostic === undefined)
const row = built.facts.find(f => f.k === 'model')
check('the page model row keeps the fresh-context note neutrally', row?.v.includes(CONTEXT_FRESH_SESSION_REASON) === true && row.tone === undefined)
const degraded = buildFacts([], model, { ...fixtureReads, context: () => { throw new Error('read failed') } })
check('a failed context read is still reported, never hidden as fresh', degraded.diagnostic === 'Context usage unavailable' && degraded.facts.find(f => f.k === 'model')?.v.includes('context unavailable') === true)
check('a failed read keeps the same row positions', degraded.facts.map(f => f.k).join('|') === built.facts.map(f => f.k).join('|'))
console.log(`fresh context: ${failures} failures`)
process.exit(failures ? 1 : 0)
