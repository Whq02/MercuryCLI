#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-gauge-owners.ts — the cockpit's rebuilt gauge
//  owners tell the truth they own, live, and never throw.
//
//  §1 mcpGauge — configured rows read `configured` until THIS process
//     publishes a connection; a publish flips the row to the live word and a
//     runtime-only client gets its own `runtime` row; counts and the count
//     label agree with the rows; a subscriber fires on the publish; the
//     policy boolean rides the live arm; the row→badge map is total.
//  §2 modelGauge — the label is renderModelName's, the window (with its
//     source word) is resolveContextWindow's, the provider is routeLaw's;
//     garbage input is an honest `unavailable`, never a throw.
//  §3 fleetGauge — a solo session reads `off` with its reason, and the
//     roster still carries an execution-plane agent registered in this
//     process; a settled execution leaves the roster.
//  §4 contextGauge — a fresh session is `unavailable` (no fake gauge).
//  §5 the retired owners stay retired — no file, no reference in src/ or
//     scripts/ (this prover excepted).
//
//  Hermetic: a scratch config home holds the two configured servers; nothing
//  connects, nothing spawns.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'gauge-owners-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, '.mercury.json'),
  JSON.stringify({ mcpServers: { alpha: { command: 'true' }, beta: { command: 'true' } } }),
)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(home, 'teams')
// Hermetic: a real local server on this box must never be discovered here
// (the §2 local row pins the UNDISCOVERED arm's labelled fallback).
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const config = await import('../../src/utils/config.ts')
if (typeof (config as { enableConfigs?: () => void }).enableConfigs === 'function') {
  ;(config as { enableConfigs: () => void }).enableConfigs()
}

// ── §1 mcpGauge ─────────────────────────────────────────────────────────────
section('§1 mcpGauge — configured ≠ ready; a publish is the only way to ready')
{
  const m = await import('../../src/utils/cockpit/mcpGauge.ts')
  m.resetMcpGaugeForTests()
  const before = m.mcpGauge()
  check('two configured servers ⇒ live', before.state === 'live', before.state)
  check('names are the sorted config keys', before.data.names.join(',') === 'alpha,beta', before.data.names.join(','))
  check(
    'every row reads configured before any publish',
    before.data.servers.length === 2 && before.data.servers.every(r => r.state === 'configured' && r.source === 'config'),
    JSON.stringify(before.data.servers.map(r => [r.name, r.state])),
  )
  check('counts: 2 configured, 0 ready', before.data.counts.configured === 2 && before.data.counts.ready === 0 && before.data.counts.total === 2)
  check('count label: "2 configured"', m.mcpCountsLabel(before.data.counts) === '2 configured', m.mcpCountsLabel(before.data.counts))
  check('runtimeStampedAt is null before any publish', before.data.runtimeStampedAt === null)
  check('the policy boolean rides the live arm', typeof before.data.mcpPolicyActive === 'boolean' && typeof before.data.mcpPolicyHint === 'string')

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
  check('the subscriber fired once on the publish', fired === 1, String(fired))
  check('the version bumped', m.getMcpGaugeVersion() === v0 + 1)
  check('alpha (connected in this process) reads ready', row('alpha')?.state === 'ready', row('alpha')?.state)
  check('beta (no connection) still reads configured', row('beta')?.state === 'configured', row('beta')?.state)
  check(
    'gamma (published, not configured) is a runtime row that reads failed with its error',
    row('gamma')?.source === 'runtime' && row('gamma')?.state === 'failed' && /ENOENT/.test(row('gamma')?.error ?? ''),
    JSON.stringify(row('gamma')),
  )
  check('config rows come first, runtime rows after', after.data.servers.map(r => r.name).join(',') === 'alpha,beta,gamma', after.data.servers.map(r => r.name).join(','))
  check(
    'counts follow the rows',
    after.data.counts.ready === 1 && after.data.counts.failed === 1 && after.data.counts.configured === 1 && after.data.counts.total === 3,
    JSON.stringify(after.data.counts),
  )
  check('count label names each non-zero state', m.mcpCountsLabel(after.data.counts) === '1 ready · 1 failed · 1 configured', m.mcpCountsLabel(after.data.counts))
  check('runtimeStampedAt is stamped by the publish', typeof after.data.runtimeStampedAt === 'number')

  const states = ['ready', 'starting', 'needs-auth', 'failed', 'disabled', 'configured'] as const
  const badges = states.map(s => m.mcpServerSnapshotState(s))
  check('row→badge map is total over the state union', badges.every(b => typeof b === 'string' && b.length > 0), badges.join(','))
  check('needs-auth paints degraded; failed paints failed', m.mcpServerSnapshotState('needs-auth') === 'degraded' && m.mcpServerSnapshotState('failed') === 'failed')
  m.resetMcpGaugeForTests()
  const reset = m.mcpGauge()
  check('reset ⇒ every configured row is configured again (no ghost of the publish)', reset.data.servers.every(r => r.state === 'configured') && reset.data.servers.length === 2)
}

// ── §2 modelGauge ───────────────────────────────────────────────────────────
section('§2 modelGauge — label, window provenance and provider from their owners')
{
  const g = await import('../../src/utils/cockpit/modelGauge.ts')
  const { renderModelName } = await import('../../src/utils/model/model.ts')
  const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
  const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
  const { getSdkBetas } = await import('../../src/bootstrap/state.ts')
  for (const model of ['claude-opus-5', 'compat/some-local-model', 'openrouter/qwen/qwen3-coder', 'local/never-listed:1b']) {
    const snap = g.modelGauge(model)
    const want = resolveContextWindow(model, getSdkBetas())
    check(`${model}: live`, snap.state === 'live', snap.state)
    check(`${model}: label is renderModelName's`, snap.data.name === renderModelName(model), `${snap.data.name} vs ${renderModelName(model)}`)
    check(`${model}: window is the resolver's effectiveWindow`, snap.data.window === want.effectiveWindow, `${snap.data.window} vs ${want.effectiveWindow}`)
    check(`${model}: window source word matches (${want.source})`, snap.data.windowSource === want.source, snap.data.windowSource)
    check(`${model}: provider is routeLaw's (${declaredRouteOf(model) ?? 'unrecognised'})`, snap.data.provider === (declaredRouteOf(model) ?? 'unrecognised'), snap.data.provider)
    check(`${model}: outputReserve is the resolver's`, snap.data.outputReserve === want.outputReserve)
  }
  let threw = false
  let garbage: ReturnType<typeof g.modelGauge> | null = null
  try {
    garbage = g.modelGauge(undefined as never)
  } catch {
    threw = true
  }
  check('garbage input never throws', !threw)
  check('garbage input is a labelled state', garbage !== null && typeof garbage.state === 'string' && garbage.state.length > 0, garbage?.state)
  check('subscribe/version are exported (the catalogue-epoch edge)', typeof g.subscribeModelGauge === 'function' && typeof g.getModelGaugeVersion === 'function')
}

// ── §3 fleetGauge ───────────────────────────────────────────────────────────
section('§3 fleetGauge — solo reads off; the roster still lists a live execution')
{
  const f = await import('../../src/utils/cockpit/fleetGauge.ts')
  const plane = await import('../../src/services/primitives/executionPlane.ts')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
  const owner = processMainOwner()
  const solo = await f.fleetGauge()
  check('solo session reads off with the team reason', solo.state === 'off' && /not in a team/.test(solo.reason ?? ''), `${solo.state} · ${solo.reason}`)
  check('the off arm carries a roster array', Array.isArray(solo.data.roster))
  const beforeCount = solo.data.roster.filter(r => r.source === 'execution').length
  plane.registerExecution({ owner, id: 'proof-agent', kind: 'agent', label: 'proof agent', lifecycle: 'session', initialState: 'running' })
  const withAgent = await f.fleetGauge()
  const row = withAgent.data.roster.find(r => r.id === 'execution:proof-agent')
  check('a registered agent execution appears on the roster (source execution, state running)', row?.source === 'execution' && row?.state === 'running' && row?.name === 'proof agent', JSON.stringify(row))
  check('the state law is unchanged by the roster (still off while solo)', withAgent.state === 'off')
  plane.transitionExecution(owner, 'proof-agent', 'succeeded')
  const settled = await f.fleetGauge()
  check('a settled execution leaves the roster', !settled.data.roster.some(r => r.id === 'execution:proof-agent'))
  check('no other execution rows were invented', settled.data.roster.filter(r => r.source === 'execution').length === beforeCount)
}

// ── §4 contextGauge ─────────────────────────────────────────────────────────
section('§4 contextGauge — fresh session is unavailable, never a fake figure')
{
  const c = await import('../../src/utils/cockpit/contextGauge.ts')
  const fresh = c.contextGauge([] as never, 'claude-opus-5' as never)
  check('fresh ⇒ unavailable', fresh.state === 'unavailable', fresh.state)
  check('reason names the fresh session', /fresh session/.test(fresh.reason ?? ''), fresh.reason)
  check('usedPct is null, never 0', fresh.data.usedPct === null)
}

// ── §5 the retired owners stay retired ──────────────────────────────────────
section('§5 the retired owners stay retired')
{
  const retiredFiles = [
    'mcpSnapshot',
    'mcpRuntimeStore',
    'modelSnapshot',
    'statusSnapshot',
    'sessionSnapshot',
    'pluginSnapshot',
    'skillsSnapshot',
    'usageSnapshot',
    'fleetSnapshot',
  ]
  for (const name of retiredFiles) {
    check(`src/utils/cockpit/${name}.ts is gone`, !existsSync(join(ROOT, 'src', 'utils', 'cockpit', `${name}.ts`)))
  }
  const self = join(ROOT, 'scripts', 'substrate', 'prove-gauge-owners.ts')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e) && p !== self) {
        const text = readFileSync(p, 'utf8')
        for (const name of retiredFiles) {
          // An import of the retired file, or a call of its export — a local
          // variable that happens to share the word is not a reference.
          if (new RegExp(`cockpit/${name}\\b|\\b${name}\\(`).test(text)) offenders.push(`${p.slice(ROOT.length + 1)}: ${name}`)
        }
      }
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'scripts'))
  check('zero references to the retired owners in src/ and scripts/', offenders.length === 0, offenders.slice(0, 5).join(' · '))
  const barrel = readFileSync(join(ROOT, 'src', 'utils', 'cockpit', 'index.ts'), 'utf8')
  check('the barrel exports the four gauges', ['modelGauge', 'contextGauge', 'fleetGauge', 'mcpGauge'].every(n => barrel.includes(`./${n}.js`)))
}

console.log(failures === 0 ? '\n ✅ GAUGE OWNERS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
