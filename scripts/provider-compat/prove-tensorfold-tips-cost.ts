#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-tips-cost-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_PROBE_TARGETS
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_MODEL
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { model: 'claude-opus-5-5' } }))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { getRelevantTips } = await import('../../src/screen/tips/tipRegistry.ts')
const { getCachedLocalDiscovery } = await import('../../src/models/roads/local/localDiscovery.ts')
const state = await import('../../src/models/roads/local/tensorfoldState.ts')
const app = await import('../../src/models/roads/local/tensorfoldApp.ts')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.ts')

console.log('\n§1 a cloud session evaluating every spinner tip spawns nothing and probes nothing (red on the fold: readTensorFoldState refreshed discovery and spawned ps/tensorfold/sysctl/osascript every 60 s)')
check('the session is on a cloud model', !getEngineModel().startsWith('local/'), getEngineModel())
check('no local discovery has run', getCachedLocalDiscovery() === null, 'something refreshed local discovery at import or startup; look at refreshLocalDiscovery callers in src/models/roads/local/localDiscovery.ts')
const before = { reads: state.__tensorFoldStateReadsForTest(), lists: app.__tensorFoldProcessListsForTest() }
const tips = await getRelevantTips({ theme: 'dark' })
check('tips evaluated', tips.length > 0, `${tips.length}; getRelevantTips in src/screen/tips/tipRegistry.ts returned no tips`)
check('no TensorFold state read happened (no engine spawn, no app process list, no service read)', state.__tensorFoldStateReadsForTest() === before.reads, `${state.__tensorFoldStateReadsForTest() - before.reads} reads; a tip isRelevant in src/screen/tips/tipRegistry.ts calls readTensorFoldState (src/models/roads/local/tensorfoldState.ts), so make it use tensorFoldPresenceCached instead`)
check('no process list was spawned', app.__tensorFoldProcessListsForTest() === before.lists, 'a tip evaluation reached the process list in src/models/roads/local/tensorfoldApp.ts; keep tip relevance on cached state')
check('no local discovery probe ran because of a tip', getCachedLocalDiscovery() === null, 'a tip evaluation refreshed local discovery; readTensorFoldState in src/models/roads/local/tensorfoldState.ts calls refreshLocalDiscovery, so tips must not call it')
check('the TensorFold tips are not offered on a cloud session with nothing installed or paired, from cached state alone', !tips.some(tip => tip.id === 'tensorfold-lan-pair' || tip.id === 'tensorfold-effort-cache'), 'the isRelevant of tensorfold-lan-pair or tensorfold-effort-cache in src/screen/tips/tipRegistry.ts returned true without an installed, serving or paired TensorFold in cached state')
const presence = state.tensorFoldPresenceCached({ installed: () => false, snapshot: () => null, hosts: () => [] })
check('the cached presence reader answers from its reads only', !presence.installed && !presence.serving && !presence.paired, `${JSON.stringify(presence)}; tensorFoldPresenceCached in src/models/roads/local/tensorfoldState.ts must derive installed, serving and paired only from its reads`)
const servingPresence = state.tensorFoldPresenceCached({ installed: () => true, snapshot: () => ({ probedAtMs: 1, targetCount: 1, servers: [{ kind: 'tensorfold', root: 'http://127.0.0.1:8080', baseUrl: 'http://127.0.0.1:8080/v1', label: 'TensorFold 1.2.2', models: [{ id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:8080/v1' }] }] }), hosts: () => [{ name: 'studio', baseUrl: 'http://studio.local:8080', origin: 'lan-paired' }, { name: 'this mac', baseUrl: 'http://127.0.0.1:8080', origin: 'shared' }] })
check('a cached snapshot with a TensorFold server and a paired host reads serving and paired; a shared host alone is not paired', servingPresence.installed && servingPresence.serving && servingPresence.paired && !state.tensorFoldPresenceCached({ installed: () => false, snapshot: () => null, hosts: () => [{ name: 'this mac', baseUrl: 'http://127.0.0.1:8080', origin: 'shared' }] }).paired, `${JSON.stringify(servingPresence)}; fix installed, serving or paired in tensorFoldPresenceCached (src/models/roads/local/tensorfoldState.ts): serving needs a tensorfold server with models, paired needs a host whose origin is not app or shared`)
const again = await getRelevantTips({ theme: 'dark' })
check('a second evaluation still spawns and probes nothing', again.length > 0 && state.__tensorFoldStateReadsForTest() === before.reads && app.__tensorFoldProcessListsForTest() === before.lists && getCachedLocalDiscovery() === null, 'the second getRelevantTips (src/screen/tips/tipRegistry.ts) read TensorFold state or probed discovery; keep tip relevance on tensorFoldPresenceCached')

console.log(`\nprove-tensorfold-tips-cost: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
