#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-local-discovery-honest.ts — the local engine's
//  discovery record never claims a probe it did not run (the finding
//  w1-f14-03: "probeLocal stays a synchronous cache read stamped
//  probedAtMs=now()").
//
//  The law: probeLocal is a CACHE READ over localDiscovery's snapshot —
//   · before the first real probe it says probed:false / probedAtMs 0, the
//     status is 'discovery-pending:local' (the health grammar's own stable
//     code), and the sign-in slot says the probe is pending — never a
//     fabricated fresh "no server";
//   · after a real probe the record carries the SNAPSHOT's own probedAtMs,
//     never the reader's clock;
//   · the two surfaces run the REAL bounded refresh where they can await it
//     (/health's provider-slots row; the accounts board's mount kick —
//     localDiscovery's own 900ms caps bound both).
//
//  NEEDS-REAL-BOX (the live leg, driver line): with no local server, open
//  the accounts board → the local slot first paints "not probed yet…" and
//  settles to "no local server discovered…" within ~1s (the mount kick's
//  real probe); start Ollama, reopen the board → the slot lists it.
// ============================================================================
// The build-time identity macro (the bundle defines it; raw-bun source runs
// need the house shim — getUserAgent() inside probeJson reads it, and its
// throw would silently void every probe).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE any src import (never the operator's real
// home), and the config-read gate armed — getUserAgent() inside probeJson
// reads config, and the gate's throw would silently void every probe.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-local-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const repoRoot = process.cwd()
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const discovery = await import('../../src/utils/router/providerDiscovery.js')
const local = await import('../../src/utils/router/providers/local.js')
const localDiscovery = await import('../../src/services/providers/local/localDiscovery.js')
const globalConfig = await import('../../src/utils/config/globalConfig.js')
globalConfig.enableConfigs()

// ── 1) never-probed: pending, never fabricated absence ──────────────────────
{
  const record = discovery.primeLocalDiscovery({ now: () => 123_456 })
  check('never-probed record says probed:false', record !== null && record.probed === false)
  check('never-probed record claims NO probe time', record !== null && record.probedAtMs === 0)
  const status = local.localStatus()
  check('never-probed status = discovery-pending:local (the grammar’s own code)', status.available === false && status.reason === 'discovery-pending:local')
  const description = local.describeLocalProvider()
  check('the sign-in slot says the probe is PENDING, not a fresh absence', description.account.kind === 'none' && description.account.label.includes('not probed yet'))
}

// ── 2) a real (network-free) probe seeds the snapshot ───────────────────────
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
  check('the seeded probe found the one fake server', snapshot.servers.length === 1 && snapshot.probedAtMs === SNAPSHOT_AT, `servers ${snapshot.servers.length} at ${snapshot.probedAtMs}`)

  // ── 3) the honest stamp: the record carries the SNAPSHOT's time ───────────
  const record = discovery.primeLocalDiscovery({ now: () => 9_999_999 })
  check('post-probe record says probed:true', record !== null && record.probed === true)
  check('the record carries the SNAPSHOT’s own time, never the reader’s clock', record !== null && record.probedAtMs === SNAPSHOT_AT, `probedAtMs ${record?.probedAtMs}`)
  check('post-probe presence is real', record !== null && record.serverPresent === true && record.modelCount === 1)
  check('post-probe status is available', local.localStatus().available === true)
  const description = local.describeLocalProvider()
  check('the slot’s catalogue stamp is the discovery’s own time', description.catalogueSource === 'live-discovery' && description.discoveredAtMs === SNAPSHOT_AT)
}

// ── 4) the surfaces run the REAL bounded refresh where they can await ───────
{
  const health = readFileSync(join(repoRoot, 'src/utils/healthReport.ts'), 'utf8')
  check('/health’s provider-slots row refreshes local for real', health.includes("refreshProviderDiscovery('local')"))
  check('/health’s honesty grammar accepts discovery-pending', health.includes("'discovery-pending:'"))
  const board = readFileSync(join(repoRoot, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('the accounts board kicks one bounded local probe at mount', board.includes("refreshProviderDiscovery('local')") && board.includes('setVersion(v => v + 1)'))
  const probe = readFileSync(join(repoRoot, 'src/utils/router/providerDiscovery.ts'), 'utf8')
  check('probeLocal stamps the snapshot’s time (the io.now() stamp is gone)', probe.includes('probedAtMs: snapshot?.probedAtMs ?? 0') && !/provider: 'local',\s*\n\s*probedAtMs: io\.now\(\)/.test(probe))
}

console.log(failures === 0 ? 'prove-local-discovery-honest: GREEN' : `prove-local-discovery-honest: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
