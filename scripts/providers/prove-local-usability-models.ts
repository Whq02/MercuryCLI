#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-usability-models-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_API_KEY

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const accounts = await import('../../src/services/providers/local/localAccounts.ts')
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const NONE: Reads = {
  anthropicApiKey: () => null,
  anthropicSubscriber: () => false,
  anthropicBearerToken: () => false,
  anthropicLimitStatus: () => 'allowed',
  gptSeat: () => ({ state: 'disabled', reason: 'no OpenAI account is signed in', why: 'no-account' }),
  zaiKeyPresent: () => false,
  moonshotAccount: () => undefined,
  deepseekKeyPresent: () => false,
  xaiKeyPresent: () => false,
  compatConfigured: () => false,
  huggingfaceAccount: () => undefined,
  localServerPresent: () => false,
  openrouterKeyPresent: () => false,
  geminiAccount: () => undefined,
}

section('1 · the words: one owner for the local road beside a sign-in')
{
  check('the no-server blocker names /localsetup, the four servers and the base-URL road, never a sign-in word', accounts.LOCAL_NO_SERVER_BLOCKER === 'no local server discovered — /localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp), or start one and set MERCURY_LOCAL_BASE_URL' && !/logins|sign in/i.test(accounts.LOCAL_NO_SERVER_BLOCKER), accounts.LOCAL_NO_SERVER_BLOCKER)
  check('the no-model remedy says /localsetup pulls one', accounts.LOCAL_NO_MODEL_REMEDY === 'no model pulled yet — /localsetup pulls one')
  check('beside a sign-in with no server: the local road is /localsetup', accounts.localRoadBesideSignIn(undefined) === 'or run a local model — /localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp)', accounts.localRoadBesideSignIn(undefined))
  check('beside a sign-in with a server that has models: the local road is --model local/<name> with the server named', accounts.localRoadBesideSignIn({ kind: 'keyless', label: 'Ollama 0.40.5 (8)', serverCount: 1, modelCount: 8 }) === 'or run a local model with --model local/<name> (Ollama 0.40.5 (8))')
  check('beside a sign-in with a server that has NO model: /localsetup again (there is nothing to pick)', accounts.localRoadBesideSignIn({ kind: 'keyless', label: 'Ollama 0.40.5 (0) · no model pulled yet — /localsetup pulls one', serverCount: 1, modelCount: 0 }).includes('/localsetup sets one up'))
}

section('2 · usability by the reads: a server with zero models is not usable and says /localsetup pulls one; one model flips it')
{
  const dark = resolveProviderUsability(NONE).local
  check('no server: not usable, keyless credential none, the /localsetup blocker', !dark.usable && dark.credential === 'none' && dark.blockers[0] === accounts.LOCAL_NO_SERVER_BLOCKER, JSON.stringify(dark))
  const empty = resolveProviderUsability({ ...NONE, localServerPresent: () => true, localAccount: () => ({ label: 'Ollama 0.40.5 (0) · no model pulled yet — /localsetup pulls one', modelCount: 0 }) }).local
  check('a discovered server with zero pulled models: usable false', !empty.usable, JSON.stringify(empty))
  check('…its blocker is the server\'s own label with the /localsetup remedy', empty.blockers[0] === 'Ollama 0.40.5 (0) · no model pulled yet — /localsetup pulls one', JSON.stringify(empty.blockers))
  const one = resolveProviderUsability({ ...NONE, localServerPresent: () => true, localAccount: () => ({ label: 'Ollama 0.40.5 (1)', modelCount: 1 }) }).local
  check('one model listed: usable true, keyless, no blocker', one.usable && one.credential === 'keyless' && one.blockers.length === 0, JSON.stringify(one))
  const legacy = resolveProviderUsability({ ...NONE, localServerPresent: () => true }).local
  check('a reads set with only the presence boolean (standing fixtures) keeps its historical answer', legacy.usable && legacy.blockers.length === 0, JSON.stringify(legacy))
}

section('3 · through the real discovery: a stub Ollama with no model, then with one')
{
  let models: Array<{ name: string }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json({ models: models.map(m => ({ name: m.name, model: m.name, size: 6_600_000_000, details: { family: 'qwen35' } })) })
      if (path === '/api/version') return Response.json({ version: '0.40.5' })
      if (path === '/api/ps') return Response.json({ models: [] })
      if (path === '/api/show') return Response.json({ parameters: '', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools'] })
      return new Response('{}', { status: 404 })
    },
  })
  const env = { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: `ollama=http://127.0.0.1:${server.port}` }
  process.env.MERCURY_LOCAL_PROBE_TARGETS = env.MERCURY_LOCAL_PROBE_TARGETS
  discovery.__resetLocalDiscoveryForTest()
  await discovery.refreshLocalDiscovery({ force: true, env })
  const account0 = accounts.resolveLocalAccount(env)
  const lane0 = resolveProviderUsability().local
  check('zero models: the account exists (the server answers) with modelCount 0', account0 !== undefined && account0.modelCount === 0 && account0.serverCount === 1, JSON.stringify(account0))
  check('zero models: the lane is NOT usable and its blocker names the server and /localsetup', !lane0.usable && lane0.blockers[0] === 'Ollama 0.40.5 (0) · no model pulled yet — /localsetup pulls one', JSON.stringify(lane0))
  models = [{ name: 'qwen3.5:9b' }]
  discovery.__resetLocalDiscoveryForTest()
  await discovery.refreshLocalDiscovery({ force: true, env })
  const lane1 = resolveProviderUsability().local
  check('one model pulled: the lane flips to usable with no blocker', lane1.usable && lane1.blockers.length === 0 && lane1.credential === 'keyless', JSON.stringify(lane1))
  server.stop(true)
  discovery.__resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
}

console.log(failures === 0 ? '\nprove-local-usability-models: ALL GREEN' : `\nprove-local-usability-models: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
