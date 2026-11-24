#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'gauge-owners-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, '.mercury.json'),
  JSON.stringify({ mcpServers: { alpha: { command: 'true' }, beta: { command: 'true' } } }),
)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}
const mcpGaugeFix = 'fix mcpGauge, publishMcpConnections or mcpCountsLabel in src/screen/cockpit-gauges/mcpGauge.ts'
const modelGaugeFix = 'fix modelGauge in src/screen/cockpit-gauges/modelGauge.ts so each field comes from its owner'
const fleetGaugeFix = 'fix fleetGauge in src/screen/cockpit-gauges/fleetGauge.ts'
const contextGaugeFix = 'fix contextGauge in src/screen/cockpit-gauges/contextGauge.ts'

const config = await import('../../src/platform/settings/config.ts')
if (typeof (config as { enableConfigs?: () => void }).enableConfigs === 'function') {
  ;(config as { enableConfigs: () => void }).enableConfigs()
}

section('§1 mcpGauge — configured ≠ ready; a publish is the only way to ready')
{
  const m = await import('../../src/screen/cockpit-gauges/mcpGauge.ts')
  m.resetMcpGaugeForTests()
  const before = m.mcpGauge()
  check('two configured servers ⇒ live', before.state === 'live', `${before.state} — ${mcpGaugeFix}`)
  check('names are the sorted config keys', before.data.names.join(',') === 'alpha,beta', `${before.data.names.join(',')} — ${mcpGaugeFix}`)
  check(
    'every row reads configured before any publish',
    before.data.servers.length === 2 && before.data.servers.every(r => r.state === 'configured' && r.source === 'config'),
    JSON.stringify(before.data.servers.map(r => [r.name, r.state])) + ` — ${mcpGaugeFix}`,
  )
  check('counts: 2 configured, 0 ready', before.data.counts.configured === 2 && before.data.counts.ready === 0 && before.data.counts.total === 2, `${JSON.stringify(before.data.counts)} — ${mcpGaugeFix}`)
  check('runtimeStampedAt is null before any publish', before.data.runtimeStampedAt === null, `${String(before.data.runtimeStampedAt)} — ${mcpGaugeFix}; resetMcpGaugeForTests must clear the stamp`)
  check('the policy boolean rides the live arm', typeof before.data.mcpPolicyActive === 'boolean' && typeof before.data.mcpPolicyHint === 'string', `${mcpGaugeFix}; the live arm of mcpGauge must return mcpPolicyActive and mcpPolicyHint`)

  let fired = 0
  const unsub = m.subscribeMcpGauge(() => {
    fired += 1
  })
  const v0 = m.getMcpGaugeVersion()
  const stdio = { type: 'stdio', command: 'true', args: [], env: {}, scope: 'global' } as const
  m.publishMcpConnections([
    { name: 'alpha', type: 'connected', config: stdio, client: {}, capabilities: {}, cleanup: async () => {} } as never,
    { name: 'gamma', type: 'failed', config: stdio, error: 'spawn definitely-missing ENOENT' } as never,
  ])
  unsub()
  const after = m.mcpGauge()
  const row = (name: string) => after.data.servers.find(r => r.name === name)
  check('the subscriber fired once on the publish', fired === 1, `${fired} — publishMcpConnections in src/screen/cockpit-gauges/mcpGauge.ts must notify subscribers exactly once`)
  check('the version bumped', m.getMcpGaugeVersion() === v0 + 1, `${m.getMcpGaugeVersion()} vs ${v0 + 1} — publishMcpConnections in src/screen/cockpit-gauges/mcpGauge.ts must bump the version once`)
  check('alpha (connected in this process) reads ready', row('alpha')?.state === 'ready', `${row('alpha')?.state} — ${mcpGaugeFix}`)
  check('beta (no connection) still reads configured', row('beta')?.state === 'configured', `${row('beta')?.state} — ${mcpGaugeFix}`)
  check(
    'gamma (published, not configured) is a runtime row that reads failed with its error',
    row('gamma')?.source === 'runtime' && row('gamma')?.state === 'failed' && /ENOENT/.test(row('gamma')?.error ?? ''),
    `${JSON.stringify(row('gamma'))} — ${mcpGaugeFix}`,
  )
  check('config rows come first, runtime rows after', after.data.servers.map(r => r.name).join(',') === 'alpha,beta,gamma', `${after.data.servers.map(r => r.name).join(',')} — ${mcpGaugeFix}`)
  check(
    'counts follow the rows',
    after.data.counts.ready === 1 && after.data.counts.failed === 1 && after.data.counts.configured === 1 && after.data.counts.total === 3,
    `${JSON.stringify(after.data.counts)} — ${mcpGaugeFix}`,
  )
  check('runtimeStampedAt is stamped by the publish', typeof after.data.runtimeStampedAt === 'number', `${String(after.data.runtimeStampedAt)} — publishMcpConnections in src/screen/cockpit-gauges/mcpGauge.ts must stamp the runtime snapshot`)
  m.resetMcpGaugeForTests()
  const reset = m.mcpGauge()
  check('reset ⇒ every configured row is configured again (no ghost of the publish)', reset.data.servers.every(r => r.state === 'configured') && reset.data.servers.length === 2, 'resetMcpGaugeForTests in src/screen/cockpit-gauges/mcpGauge.ts must clear the published connections')
}

section('§2 modelGauge — label, window provenance and provider from their owners')
{
  const g = await import('../../src/screen/cockpit-gauges/modelGauge.ts')
  const { renderModelName } = await import('../../src/models/catalogue/engineModel.ts')
  const { resolveContextWindow } = await import('../../src/models/facts/capabilities.ts')
  const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
  const { getSdkBetas } = await import('../../src/boot/process-state/processState.ts')
  for (const model of ['claude-opus-5', 'compat/some-local-model', 'openrouter/qwen/qwen3-coder', 'local/never-listed:1b']) {
    const snap = g.modelGauge(model)
    const want = resolveContextWindow(model, getSdkBetas())
    check(`${model}: live`, snap.state === 'live', `${snap.state} — ${modelGaugeFix}`)
    check(`${model}: label is renderModelName's`, snap.data.name === renderModelName(model), `${snap.data.name} vs ${renderModelName(model)} — ${modelGaugeFix}`)
    check(`${model}: window is the resolver's effectiveWindow`, snap.data.window === want.effectiveWindow, `${snap.data.window} vs ${want.effectiveWindow} — ${modelGaugeFix}`)
    check(`${model}: window source word matches (${want.source})`, snap.data.windowSource === want.source, `${snap.data.windowSource} — ${modelGaugeFix}`)
    check(`${model}: provider is routeLaw's (${declaredRouteOf(model) ?? 'unrecognised'})`, snap.data.provider === (declaredRouteOf(model) ?? 'unrecognised'), `${snap.data.provider} — ${modelGaugeFix}`)
    check(`${model}: outputReserve is the resolver's`, snap.data.outputReserve === want.outputReserve, `${snap.data.outputReserve} vs ${want.outputReserve} — ${modelGaugeFix}`)
  }
  let threw = false
  let garbage: ReturnType<typeof g.modelGauge> | null = null
  try {
    garbage = g.modelGauge(undefined as never)
  } catch {
    threw = true
  }
  check('garbage input never throws', !threw, 'modelGauge in src/screen/cockpit-gauges/modelGauge.ts must return a labelled state for an undefined model, not throw')
  check('garbage input is a labelled state', garbage !== null && typeof garbage.state === 'string' && garbage.state.length > 0, `${garbage?.state} — ${modelGaugeFix}`)
  check('subscribe/version are exported (the catalogue-epoch edge)', typeof g.subscribeModelGauge === 'function' && typeof g.getModelGaugeVersion === 'function', 'src/screen/cockpit-gauges/modelGauge.ts must export subscribeModelGauge and getModelGaugeVersion')
}

section('§3 fleetGauge — solo reads off; the roster still lists a live execution')
{
  const f = await import('../../src/screen/cockpit-gauges/fleetGauge.ts')
  const plane = await import('../../src/engine/execution-plane/executionPlane.ts')
  const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
  const owner = processMainOwner()
  const solo = await f.fleetGauge()
  check('solo session reads off with the no-fleet reason', solo.state === 'off' && /no fleet/.test(solo.reason ?? ''), `${solo.state} · ${solo.reason} — ${fleetGaugeFix}`)
  check('the off arm carries a roster array', Array.isArray(solo.data.roster), `${fleetGaugeFix}; the off arm must still return data.roster`)
  const beforeCount = solo.data.roster.filter(r => r.source === 'execution').length
  plane.registerExecution({ owner, id: 'proof-agent', kind: 'agent', label: 'proof agent', lifecycle: 'session', initialState: 'running' })
  const withAgent = await f.fleetGauge()
  const row = withAgent.data.roster.find(r => r.id === 'execution:proof-agent')
  check('a registered agent execution appears on the roster (source execution, state running)', row?.source === 'execution' && row?.state === 'running' && row?.name === 'proof agent', `${JSON.stringify(row)} — ${fleetGaugeFix}; the roster must list executions registered through registerExecution in src/engine/execution-plane/executionPlane.ts`)
  check('the state law is unchanged by the roster (still off while solo)', withAgent.state === 'off', `${withAgent.state} — ${fleetGaugeFix}; listing the roster must not change the state`)
  plane.transitionExecution(owner, 'proof-agent', 'succeeded')
  const settled = await f.fleetGauge()
  check('a settled execution leaves the roster', !settled.data.roster.some(r => r.id === 'execution:proof-agent'), `${fleetGaugeFix}; a succeeded execution must drop off the roster`)
  check('no other execution rows were invented', settled.data.roster.filter(r => r.source === 'execution').length === beforeCount, `${settled.data.roster.filter(r => r.source === 'execution').length} vs ${beforeCount} — ${fleetGaugeFix}`)
}

section('§4 contextGauge — fresh session is unavailable, never a fake figure')
{
  const c = await import('../../src/screen/cockpit-gauges/contextGauge.ts')
  const fresh = c.contextGauge([] as never, 'claude-opus-5' as never)
  check('fresh ⇒ unavailable', fresh.state === 'unavailable', `${fresh.state} — ${contextGaugeFix}`)
  check('reason names the fresh session', /fresh session/.test(fresh.reason ?? ''), `${fresh.reason} — ${contextGaugeFix}`)
  check('usedPct is null, never 0', fresh.data.usedPct === null, `${String(fresh.data.usedPct)} — ${contextGaugeFix}`)
}


console.log(failures === 0 ? '\n ✅ GAUGE OWNERS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
