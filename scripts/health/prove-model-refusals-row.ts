import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'model-refusals-row-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
process.env.MERCURY_ANTHROPIC_CLIENT_CONTRACT = '2.1.280'
for (const key of ['NODE_ENV', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR']) delete process.env[key]
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] } }))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const health = await import('../../src/utils/healthReport.js')
const refusals = await import('../../src/services/providers/anthropic/modelRefusal.js')
const { renderPlainCertificate } = await import('../../src/cli/healthPresentation.js')
let checks = 0
const check = (label: string, value: unknown): void => {
  assert(value, label)
  checks++
  console.log(`PASS ${label}`)
}

check('the doctor exposes a Refused models check rather than omitting the observation', typeof health.modelRefusalsCheck === 'function')
const spec = health.modelRefusalsCheck()
check('the check has a stable id and the visible label', spec.id === 'model-refusals' && spec.label === 'Refused models')
const empty = await spec.run()
check('no recorded refusal is neutral and says exactly what is known', empty.status === 'info' && empty.evidence === 'no model refused on any door in this session' && empty.detail === undefined && empty.fix === undefined)
const floor = refusals.classifyModelRefusal({ status: 400, errorType: 'invalid_request_error', wireText: '2.1.280 does not support this model; version 2.1.290 or newer is required', model: 'claude-opus-5-5', door: 'Claude subscription (max)', subscriber: true, presented: '2.1.280', seenAtMs: Date.now() - 30_000 })!
refusals.noteModelRefusal(floor)
const warned = await spec.run()
check('the same CheckSpec reads the later observation and warns', warned.status === 'warn')
check('the evidence names the display model, exact door, plain cause and age', /^Opus 5\.5 · Claude subscription \(max\) · minimum client version · seen \d+s ago$/.test(warned.evidence))
check('the detail is the same single sentence as the chat and picker', warned.detail === floor.words)
check('the fix carries the floor override and restart', warned.fix === 'set MERCURY_ANTHROPIC_CLIENT_CONTRACT=2.1.290 and restart Mercury, or pick another model with /model.')
const absent = refusals.classifyModelRefusal({ status: 404, errorType: 'not_found_error', wireText: 'model: claude-opus-5-7', model: 'claude-opus-5-7', door: 'Anthropic API key', subscriber: false, presented: '2.1.280', seenAtMs: Date.now() - 10_000 })!
refusals.noteModelRefusal(absent)
const pair = await spec.run()
check('each standing door has its own evidence line and sentence', pair.evidence.split('\n').length === 2 && pair.detail?.split('\n').length === 2 && pair.detail.includes(absent.words))
check('the not-served fix is /model, not a sign-in or vendor updater', pair.fix?.includes('pick a listed model with /model.') && !pair.fix.includes('claude update'))
const plain = renderPlainCertificate({ sections: [{ title: 'IDENTITY', checks: [{ ...pair, label: spec.label }] }], verdict: 'caution', durationMs: 0 })
check('the existing plain renderer includes the row and both evidence lines', plain.includes('[WARN] Refused models — ') && pair.evidence.split('\n').every(line => plain.includes(line)))
refusals.clearModelRefusal(floor.id, floor.door)
refusals.clearModelRefusal(absent.id, absent.door)
check('clearing the last observation restores the same neutral row', JSON.stringify(await spec.run()) === JSON.stringify(empty))
const source = readFileSync(join(import.meta.dir, '../../src/utils/healthReport.ts'), 'utf8')
const contractAt = source.indexOf('clientContractCheck(),')
const nextAt = source.indexOf("id: 'install-provenance'", contractAt)
check('the report registers this exact composer beside Client contract', contractAt >= 0 && nextAt > contractAt && /^clientContractCheck\(\),\s*modelRefusalsCheck\(\),\s*\{\s*$/.test(source.slice(contractAt, source.lastIndexOf('{', nextAt) + 1)))
console.log(`Refused models doctor row: ${checks} checks passed`)
