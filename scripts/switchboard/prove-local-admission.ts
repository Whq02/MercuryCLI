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
  check('the registry lists the discovered model as its persisted id', row !== undefined, registry.entries.map(e => e.modelId).join(' · '))
  check('the session arm is AVAILABLE (keyless presence — no credential asked)', row?.session.availability === 'available', JSON.stringify(row?.session))
  check(
    'the crew arm FOLLOWS the session arm on the discovered engine row (available — no narrower crew vocabulary)',
    row?.crew.availability === 'available',
    JSON.stringify(row?.crew),
  )
  const admitted = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the session validation admits the exact id', admitted.ok === true, admitted.ok ? '' : JSON.stringify(admitted))
}

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

section('§4 a process that has never probed (a fresh daemon, 41 ms after its socket came up) admits a served model — the admission runs the bounded discovery instead of reading an empty cache as absence')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  const fresh = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('a never-probed process admits the id a live server lists', fresh.ok === true, fresh.ok ? '' : JSON.stringify(fresh))
  __resetLocalDiscoveryForTest()
  const word = await validateWorkerModelChoice('local', 'session')
  check("the family word 'local' admits in a never-probed process when a server answers", word.ok === true, word.ok ? '' : JSON.stringify(word))
}

section('§5 a server that came up after the last probe is found at the next admission (the user starts Ollama after Mercury booted)')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  const late = await validateWorkerModelChoice('local/qwen3:1.7b', 'session')
  check('the admission re-probes once for an unlisted local id and admits the model the server now lists', late.ok === true, late.ok ? '' : JSON.stringify(late))
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const ghost = await validateWorkerModelChoice('local/ghost:7b', 'session')
  check("a never-probed process with no server answering still refuses 'unreachable:local' — after a real probe, not instead of one", !ghost.ok && ghost.reason === 'unreachable:local', JSON.stringify(ghost))
}

fixture.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
