#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openrouterFailure } from './lib/jevStandin.ts'

const home = mkdtempSync(join(tmpdir(), 'jev-refusal-logins-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'MERCURY_API_UNIX_SOCKET', 'MERCURY_HOME']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const setting = await import('../../src/services/jev/jevSetting.ts')
const ledger = await import('../../src/services/jev/jevLedger.ts')
const status = await import('../../src/services/jev/jevStatus.ts')
const client = await import('../../src/services/jev/jevClient.ts')
const secrets = await import('../../src/services/providers/providerSecrets.ts')
const assembly = await import('../../src/tools/JevEvalTool/jevEvalRequest.ts')
const refusals = await import('../../src/utils/accounts/signInRefusal.ts')
const input = { goal: 'Check supplied evidence', evidence: [{ fact: 'A measured fact' }], questions: [{ id: 'yes', kind: 'noul' as const, ask: 'Does the fact support this?' }] }
const OR_KEY = 'proof-openrouter-key-not-real-000001'
const NEW_KEY = 'proof-openrouter-key-not-real-000002'
let count = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  count++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail.slice(0, 400)}`}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const answer = (fixture: { status: number; body: unknown; headers: Record<string, string> }) => async () => new Response(JSON.stringify(fixture.body), { status: fixture.status, headers: fixture.headers })

try {
  secrets.writeStoredOpenrouterApiKey(OR_KEY)
  setting.setJevRoad('openrouter')
  setting.setJevEnabled(true)
  ledger.resetJevLedger()
  const request = { request: assembly.assembleJevEvalRequest(input as never, 'openrouter').items[0]!.request }
  console.log('§1 a 401 from OpenRouter on the Jev road is a refusal the sign-in surfaces read (the field row M39-13)')
  const expired = { ...openrouterFailure(401), body: { error: { code: 401, message: 'API key expired', metadata: {} } } }
  const outcome = await client.jevSystemOne(request.request, OR_KEY, { road: 'openrouter', fetchImpl: answer(expired) } as never)
  check('the wire names the invalid key', !outcome.ok && outcome.failure.kind === 'invalid-key' && outcome.failure.status === 401, j(outcome))
  const refusal = refusals.readSignInRefusal('openrouter')
  check("the OpenRouter sign-in record carries the refusal with the service's words", refusal !== undefined && refusal.status === 401 && (refusal.message ?? '').includes('API key expired'), j(refusal))
  check('the words /logins and health print name the refusal and the door', refusal !== undefined && refusals.signInRefusalWords(refusal, 'openrouter').includes('refused (HTTP 401: API key expired)'), refusal === undefined ? '' : refusals.signInRefusalWords(refusal, 'openrouter'))
  ledger.noteJevWireFailure(outcome.ok ? { kind: 'invalid-key', detail: '' } : outcome.failure)
  check('the Jev status is invalid-key and final for this key', status.jevStatus().kind === 'invalid-key' && status.jevStatusIsFinalForSession(status.jevStatus().kind), j(status.jevStatus()))

  console.log('§2 a replaced key reopens the road and the stale refusal no longer reads')
  secrets.writeStoredOpenrouterApiKey(NEW_KEY)
  check('with a new key stored the road is ready again', status.jevStatus().kind === 'ready', j(status.jevStatus()))
  check('the refusal of the old key is not read against the new one', refusals.readSignInRefusal('openrouter') === undefined, j(refusals.readSignInRefusal('openrouter')))

  console.log('§3 a served answer under the stored key clears the record for good')
  const okBody = { model: 'typesafe/jev-1.13-20260917', answers: { yes: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 3 } }
  const refusedAgain = await client.jevSystemOne(request.request, NEW_KEY, { road: 'openrouter', fetchImpl: answer(expired) } as never)
  check('a refusal of the new key is recorded against it', !refusedAgain.ok && refusals.readSignInRefusal('openrouter')?.status === 401, j(refusals.readSignInRefusal('openrouter')))
  const served = await client.jevSystemOne(request.request, NEW_KEY, { road: 'openrouter', fetchImpl: async () => new Response(JSON.stringify(okBody), { status: 200, headers: { 'x-generation-id': 'gen-ok' } }) } as never)
  check('a served answer clears the record', served.ok && refusals.readSignInRefusal('openrouter') === undefined, j({ served: served.ok, refusal: refusals.readSignInRefusal('openrouter') }))
  console.log('§4 the official road never writes an OpenRouter refusal')
  const official = await client.jevSystemOne(request.request, 'typesafe-key-not-real', { road: 'official', fetchImpl: answer(expired) } as never)
  check('an official-road refusal touches no sign-in record', !official.ok && refusals.readSignInRefusal('openrouter') === undefined)
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('JEV REFUSAL REACHES LOGINS RED')
  process.exit(1)
}
console.log('JEV REFUSAL REACHES LOGINS GREEN')
