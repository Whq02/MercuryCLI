#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-local-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

const discovery = await import('../../src/models/roads/providerDiscovery.js')
const local = await import('../../src/models/roads/local/localAdapter.js')
const localDiscovery = await import('../../src/models/roads/local/localDiscovery.js')
const globalConfig = await import('../../src/platform/config/globalConfig.js')
globalConfig.enableConfigs()

{
  const record = discovery.primeLocalDiscovery({ now: () => 123_456 })
  check('never-probed record says probed:false', record !== null && record.probed === false, '', 'primeLocalDiscovery in src/models/roads/providerDiscovery.ts must report probed:false before any probe')
  check('never-probed record claims NO probe time', record !== null && record.probedAtMs === 0, '', 'primeLocalDiscovery in src/models/roads/providerDiscovery.ts must set probedAtMs to 0 before any probe')
  const status = local.localStatus()
  check('never-probed status = discovery-pending:local (the grammar’s own code)', status.available === false && status.reason === 'discovery-pending:local', '', 'localStatus in src/models/roads/local/localAdapter.ts must answer unavailable with discovery-pending:local before a probe')
  const description = local.describeLocalProvider()
  check('the sign-in slot says the probe is PENDING, not a fresh absence', description.account.kind === 'none' && description.account.label.includes('not probed yet'), '', 'describeLocalProvider in src/models/roads/local/localAdapter.ts must label the account slot not probed yet before a probe')
}

{
  const SNAPSHOT_AT = 5_000_000
  const fakeFetch: typeof fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/models')) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'stale-test-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(new Response('', { status: 404 }))
  }) as typeof fetch
  const snapshot = await localDiscovery.refreshLocalDiscovery({
    force: true,
    now: () => SNAPSHOT_AT,
    fetchImpl: fakeFetch,
    env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'openai-compatible=http://127.0.0.1:9' } as NodeJS.ProcessEnv,
  })
  check('the seeded probe found the one fake server', snapshot.servers.length === 1 && snapshot.probedAtMs === SNAPSHOT_AT, `servers ${snapshot.servers.length} at ${snapshot.probedAtMs}`, 'refreshLocalDiscovery in src/models/roads/local/localDiscovery.ts must find the fake server and stamp the snapshot with its now()')

  const record = discovery.primeLocalDiscovery({ now: () => 9_999_999 })
  check('post-probe record says probed:true', record !== null && record.probed === true, '', 'primeLocalDiscovery in src/models/roads/providerDiscovery.ts must report probed:true once refreshLocalDiscovery has stored a snapshot')
  check('the record carries the SNAPSHOT’s own time, never the reader’s clock', record !== null && record.probedAtMs === SNAPSHOT_AT, `probedAtMs ${record?.probedAtMs}`, 'primeLocalDiscovery in src/models/roads/providerDiscovery.ts must copy probedAtMs from the stored snapshot, not read the clock')
  check('post-probe presence is real', record !== null && record.serverPresent === true && record.modelCount === 1, '', 'primeLocalDiscovery in src/models/roads/providerDiscovery.ts must carry serverPresent and modelCount from the stored snapshot')
  check('post-probe status is available', local.localStatus().available === true, '', 'localStatus in src/models/roads/local/localAdapter.ts must read the stored discovery snapshot')
  const description = local.describeLocalProvider()
  check('the slot’s catalogue stamp is the discovery’s own time', description.catalogueSource === 'live-discovery' && description.discoveredAtMs === SNAPSHOT_AT, '', 'describeLocalProvider in src/models/roads/local/localAdapter.ts must report live-discovery with the snapshot time')
}

{
  const { authChecks, ENGINE_UNAVAILABLE_CODES } = await import('../../src/platform/health/sections/auth.ts')
  const probedBefore = discovery.primeLocalDiscovery({ now: () => Date.now() })?.probedAtMs ?? 0
  const targetsBefore = process.env.MERCURY_LOCAL_PROBE_TARGETS
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'openai-compatible=http://127.0.0.1:9'
  const slotsSays = await (await authChecks()).find(row => row.id === 'provider-slots')?.run()
  if (targetsBefore === undefined) delete process.env.MERCURY_LOCAL_PROBE_TARGETS
  else process.env.MERCURY_LOCAL_PROBE_TARGETS = targetsBefore
  const probedAfter = discovery.primeLocalDiscovery({ now: () => Date.now() })?.probedAtMs ?? 0
  check('/health’s provider-slots row refreshes local for real', slotsSays !== undefined && probedAfter > probedBefore, `probed at ${probedBefore} before the row and ${probedAfter} after · ${slotsSays?.evidence.slice(0, 200)}`, 'the provider-slots row from authChecks in src/platform/health/sections/auth.ts must refresh local discovery when it runs')
  check('/health’s honesty grammar accepts discovery-pending', ENGINE_UNAVAILABLE_CODES.includes('discovery-pending:'), '', 'add discovery-pending: to ENGINE_UNAVAILABLE_CODES in src/platform/health/sections/auth.ts')
}

console.log(failures === 0 ? 'prove-local-discovery-honest: GREEN' : `prove-local-discovery-honest: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
