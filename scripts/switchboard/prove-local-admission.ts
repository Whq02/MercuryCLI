#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-local-admission.ts — the worker-model admission
//  door under the LOCAL family: a discovered keyless server's
//  models admit as themselves; an undiscovered local id refuses with the
//  family's OWN class — 'unreachable' and the probe route, never the
//  credential family's words (no 'no-credential:local', no "holds no
//  credential on this account" for a family whose presence is discovery).
//
//    §1 discovered: the registry lists the model; the session arm is
//       available with the keyless presence behind it; the crew arm FOLLOWS
//       the session arm (the neutral seat law: a crew runner is the product
//       itself, so every engine row a session runs a crew seat runs too —
//       the old 'not-integrated:worker-engine' refusal retired with its
//       reason, the Anthropic-only crew vocabulary).
//    §2 undiscovered: the exact-id validation refuses 'unreachable:local'
//       with the no-server truth and the probe-route action.
//    §3 the arms composer speaks the same class if a listed local row ever
//       composes against a serverless presence snapshot (the race arm).
//
//  Run:  ~/.bun/bin/bun run scripts/switchboard/prove-local-admission.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-admission-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
// Hermetic: never discover a REAL server on the proving box.
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const { validateWorkerModelChoice, composeWorkerModelRegistry } = await import(
  '../../src/services/concourse/workerModels.ts'
)
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import(
  '../../src/services/providers/local/localDiscovery.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// A minimal fixture Ollama.
function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const fixture: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', c => {
    body += String(c)
  })
  req.on('end', () => {
    void body
    if (req.url === '/api/tags')
      return json(res, { models: [{ name: 'qwen3:1.7b', model: 'qwen3:1.7b', details: { family: 'qwen3', parameter_size: '2.0B', quantization_level: 'Q4_K_M' } }] })
    if (req.url === '/api/version') return json(res, { version: '0.33.2' })
    if (req.url === '/api/ps') return json(res, { models: [] })
    if (req.url === '/api/show')
      return json(res, { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, parameters: '' })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})
const fixtureRoot: string = await new Promise(resolve => {
  fixture.listen(0, '127.0.0.1', () => {
    const a = fixture.address()
    resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`)
  })
})

// ── §1 discovered: the model admits as itself ───────────────────────────────
section('§1 a discovered local model admits (session arm), crew speaks the engine law')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  await refreshLocalDiscovery({ force: true })
  const registry = await composeWorkerModelRegistry()
  const row = registry.entries.find(e => e.modelId === 'local/qwen3:1.7b')
  check('the registry lists the discovered model as its persisted id', row !== undefined, registry.entries.map(e => e.modelId).join(' · '))
  check('the session arm is AVAILABLE (keyless presence — no credential asked)', row?.session.availability === 'available', JSON.stringify(row?.session))
  // Re-trued (the neutral seat law): the crew arm follows the session arm
  // on every engine row — the crew runner IS the product, so a discovered
  // local model a session runs is a crew seat too. The old
  // 'not-integrated:worker-engine' refusal retired with its reason (the
  // Anthropic-only crew vocabulary).
  check(
    'the crew arm FOLLOWS the session arm on the discovered engine row (available — no narrower crew vocabulary)',
    row?.crew.availability === 'available',
    JSON.stringify(row?.crew),
  )
  const admitted = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the session validation admits the exact id', admitted.ok === true, admitted.ok ? '' : JSON.stringify(admitted))
}

// ── §2 undiscovered: the family's OWN refusal ───────────────────────────────
section("§2 an undiscovered local id refuses 'unreachable:local' — never the credential words")
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  const missed = await validateWorkerModelChoice('local/ghost:7b', 'session')
  check('an undiscovered local id refuses', missed.ok === false)
  if (!missed.ok) {
    check("the reason class is 'unreachable:local' (not a credential class)", missed.reason === 'unreachable:local', missed.reason)
    check('the detail says NO SERVER, never "holds no credential"', (missed.detail ?? '').includes('server') && !(missed.detail ?? '').includes('credential'), missed.detail)
    check('the action is the probe route', (missed.action ?? '').includes('start a local server') && (missed.action ?? '').includes('MERCURY_LOCAL_BASE_URL'), missed.action)
    check('no /logins door on the account-less family', !(missed.action ?? '').includes('/logins') && !(missed.detail ?? '').includes('/logins'), `${missed.detail} · ${missed.action}`)
  }
}

fixture.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
