#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-admission-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const { validateWorkerModelChoice, composeWorkerModelRegistry } = await import(
  '../../src/screen/concourse-model/workerModels.ts'
)
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import(
  '../../src/models/roads/local/localDiscovery.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

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

section('§1 a discovered local model admits (session arm), crew speaks the engine law')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  await refreshLocalDiscovery({ force: true })
  const registry = await composeWorkerModelRegistry()
  const row = registry.entries.find(e => e.modelId === 'local/qwen3:1.7b')
  check('the registry lists the discovered model as its persisted id', row !== undefined, `${registry.entries.map(e => e.modelId).join(' · ')} — composeWorkerModelRegistry in src/screen/concourse-model/workerModels.ts must list the model refreshLocalDiscovery found, as local/<name>`)
  check('the session arm is AVAILABLE (keyless presence — no credential asked)', row?.session.availability === 'available', `${JSON.stringify(row?.session)} — a discovered local model must read available on the session arm in composeWorkerModelRegistry (src/screen/concourse-model/workerModels.ts), with no credential asked`)
  check(
    'the crew arm FOLLOWS the session arm on the discovered engine row (available — no narrower crew vocabulary)',
    row?.crew.availability === 'available',
    `${JSON.stringify(row?.crew)} — the crew arm of a local row in composeWorkerModelRegistry (src/screen/concourse-model/workerModels.ts) must follow the session arm`,
  )
  const admitted = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the session validation admits the exact id', admitted.ok === true, admitted.ok ? '' : `${JSON.stringify(admitted)} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must admit a model id the local server lists`)
}

section("§2 an undiscovered local id refuses 'unreachable:local' — never the credential words")
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  const missed = await validateWorkerModelChoice('local/ghost:7b', 'session')
  check('an undiscovered local id refuses', missed.ok === false, 'validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must refuse a local/<id> that no probed server lists')
  if (!missed.ok) {
    check("the reason class is 'unreachable:local' (not a credential class)", missed.reason === 'unreachable:local', `${missed.reason} — the local branch of validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must refuse with reason unreachable:local`)
    check('the detail says NO SERVER, never "holds no credential"', (missed.detail ?? '').includes('server') && !(missed.detail ?? '').includes('credential'), `${missed.detail} — the unreachable:local detail in validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must name the missing server and must not mention a credential`)
    check('the action is the probe route', (missed.action ?? '').includes('start a local server') && (missed.action ?? '').includes('MERCURY_LOCAL_BASE_URL'), `${missed.action} — the unreachable:local action in src/screen/concourse-model/workerModels.ts must say to start a local server and name MERCURY_LOCAL_BASE_URL`)
    check('no /logins door on the account-less family', !(missed.action ?? '').includes('/logins') && !(missed.detail ?? '').includes('/logins'), `${missed.detail} · ${missed.action} — remove the /logins pointer from the unreachable:local refusal in src/screen/concourse-model/workerModels.ts`)
  }
}

section('§4 a process that has never probed (a fresh daemon, 41 ms after its socket came up) admits a served model — the admission runs the bounded discovery instead of reading an empty cache as absence')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  const fresh = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('a never-probed process admits the id a live server lists', fresh.ok === true, fresh.ok ? '' : `${JSON.stringify(fresh)} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must run the bounded local discovery when the process has never probed`)
  __resetLocalDiscoveryForTest()
  const word = await validateWorkerModelChoice('local', 'session')
  check("the family word 'local' admits in a never-probed process when a server answers", word.ok === true, word.ok ? '' : `${JSON.stringify(word)} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must admit the family word local after a bounded discovery finds a server`)
}

section('§5 a server that came up after the last probe is found at the next admission (the user starts Ollama after Mercury booted)')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  const late = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the admission re-probes once for an unlisted local id and admits the model the server now lists', late.ok === true, late.ok ? '' : `${JSON.stringify(late)} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must re-probe once for an unlisted local id before refusing`)
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const ghost = await validateWorkerModelChoice('local/ghost:7b', 'session')
  check("a never-probed process with no server answering still refuses 'unreachable:local' — after a real probe, not instead of one", !ghost.ok && ghost.reason === 'unreachable:local', `${JSON.stringify(ghost)} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must still refuse unreachable:local after a real probe finds no server`)
}

section("§6 the daemon's order: the provider record was derived while no server answered; a server Mercury starts later is admissible at the next birth (New Session after /tensorfold serves) — the record is re-derived once per forced refresh, never on every validate")
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  const { providerFamilyPresences } = await import('../../src/models/roads/providerUsage.ts')
  const { getCachedProviderDiscovery } = await import('../../src/models/roads/providerDiscovery.ts')
  const { getCachedLocalDiscovery } = await import('../../src/models/roads/local/localDiscovery.ts')
  const absent = providerFamilyPresences().find(family => family.id === 'local')
  check('with no server answering the local family reads uncredentialed and its provider record is cached as absent', absent?.credentialed === false && getCachedProviderDiscovery('local') !== null && (getCachedProviderDiscovery('local') as { serverPresent?: boolean }).serverPresent === false, `${JSON.stringify(absent)} — providerFamilyPresences (src/models/roads/providerUsage.ts) must read local as uncredentialed and the cached provider record must carry serverPresent false when no server answers`)
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  const born = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the next admission re-probes, re-derives the provider record from the fresh snapshot and admits the model the server now lists', born.ok === true && (getCachedProviderDiscovery('local') as { serverPresent?: boolean }).serverPresent === true, born.ok ? '' : `${JSON.stringify(born)} — the admission in src/screen/concourse-model/workerModels.ts must re-probe and re-derive the provider record (src/models/roads/providerDiscovery.ts) once the forced refresh sees a server`)
  const probedAt = getCachedLocalDiscovery()?.probedAtMs
  const recordAt = getCachedProviderDiscovery('local')?.probedAtMs
  const again = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('a second validation in a row neither probes nor primes again (the model is listed; the record is derived once per refresh)', again.ok === true && getCachedLocalDiscovery()?.probedAtMs === probedAt && getCachedProviderDiscovery('local')?.probedAtMs === recordAt, `${JSON.stringify({ probedAt, now: getCachedLocalDiscovery()?.probedAtMs, recordAt, recordNow: getCachedProviderDiscovery('local')?.probedAtMs })} — validateWorkerModelChoice (src/screen/concourse-model/workerModels.ts) must not probe or re-derive the provider record when the model is already listed`)
}

fixture.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
