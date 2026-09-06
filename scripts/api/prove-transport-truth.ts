import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const ROOT_FOR_NODE = join(import.meta.dir, '..', '..')

delete process.env.MERCURY_CONNECT_TIMEOUT_MS
delete process.env.MERCURY_CONNECT_TIMEOUT_MS
delete process.env.MERCURY_MAX_CONNECTIONS
delete process.env.MERCURY_MAX_CONNECTIONS
delete process.env.MERCURY_API_TIMEOUT_MS

const proxy = await import('../../src/utils/proxy.ts')
const evidence = await import('../../src/services/api/transportEvidence.ts')
const { apiErrorDetailOf, createSystemAPIErrorMessage } = await import(
  '../../src/utils/messages/systemMessages.ts'
)

console.log('— §1 transport knobs + dispatcher (N-01) —')
{
  const k = proxy.resolveTransportKnobs()
  check('default connect timeout ≥30s (the 10s undici default is dead)', k.connectTimeoutMs >= 30_000, String(k.connectTimeoutMs))
  check('connections bounded per origin by default', typeof k.maxConnections === 'number' && k.maxConnections > 0 && k.maxConnections <= 128, String(k.maxConnections))
  check('headers/body timeouts align with the API budget default (600s)', k.headersTimeoutMs === 600_000 && k.bodyTimeoutMs === 600_000)
  check('keep-alive tuned above the undici 4s default', k.keepAliveTimeoutMs >= 10_000)

  process.env.MERCURY_CONNECT_TIMEOUT_MS = '45000'
  process.env.MERCURY_MAX_CONNECTIONS = '8'
  process.env.MERCURY_API_TIMEOUT_MS = '120000'
  const o = proxy.resolveTransportKnobs()
  check('MERCURY_CONNECT_TIMEOUT_MS honored', o.connectTimeoutMs === 45_000)
  check('MERCURY_MAX_CONNECTIONS honored', o.maxConnections === 8)
  check('MERCURY_API_TIMEOUT_MS aligns headers/body', o.headersTimeoutMs === 120_000 && o.bodyTimeoutMs === 120_000)
  delete process.env.MERCURY_CONNECT_TIMEOUT_MS
  delete process.env.MERCURY_MAX_CONNECTIONS
  delete process.env.MERCURY_API_TIMEOUT_MS
}

{
  process.env.MERCURY_CONNECT_TIMEOUT_MS = '400'
  process.env.MERCURY_MAX_CONNECTIONS = '5'
  proxy._resetApiDispatcherForTesting()
  const opts = proxy.buildApiAgentOptions()
  const connect = opts.connect as { timeout?: number }
  check('agent options carry the connect budget', connect.timeout === 400)
  check('agent options carry the connection bound', opts.connections === 5)
  check(
    'agent options carry aligned headers/body budgets',
    opts.headersTimeout === 600_000 && opts.bodyTimeout === 600_000,
  )
  check('getApiDispatcher returns a dispatcher', typeof proxy.getApiDispatcher() === 'object')
  delete process.env.MERCURY_CONNECT_TIMEOUT_MS
  delete process.env.MERCURY_MAX_CONNECTIONS
  proxy._resetApiDispatcherForTesting()
}

function runNodeProbe(script: string): { ok?: boolean; ms?: number; code?: string | null; stderr: string; status: number | null } {
  const res = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  let parsed: { ok?: boolean; ms?: number; code?: string | null } = {}
  try {
    parsed = JSON.parse((res.stdout || '').trim().split('\n').pop() || '{}')
  } catch {
  }
  return { ...parsed, stderr: (res.stderr || '').slice(0, 200), status: res.status }
}
const PROBE_PRELUDE = `
  const { createRequire } = await import('node:module');
  const req = createRequire(${JSON.stringify(join(ROOT_FOR_NODE, 'package.json'))});
  const undici = req('undici');
  const agent = new undici.Agent({ connect: { timeout: 400 } });
  const walk = e => { let n = e, code, hops = 0; while (n && typeof n === 'object' && hops++ < 6) { if (typeof n.code === 'string') code = n.code; n = n.cause; } return code ?? null; };
  const t0 = Date.now();
`
{
  const paired = runNodeProbe(`${PROBE_PRELUDE}
    try {
      await undici.fetch('https://192.0.2.1/unreachable', { dispatcher: agent, signal: AbortSignal.timeout(8000) });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ms: Date.now() - t0, code: walk(e) }));
    }
  `)
  check('node child ran the paired live probe', paired.status === 0 && !paired.ok, paired.stderr)
  const NO_ROUTE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'])
  if (NO_ROUTE.has(String(paired.code))) {
    console.log(
      `  – [SKIP] connect-budget + transport-class legs — no route to TEST-NET-1 from this box (${paired.code}); both pins need an outbound route`,
    )
  } else {
    check(
      'our connect budget governs under Node (≪ the 10s default)',
      typeof paired.ms === 'number' && paired.ms < 5_000,
      `${paired.ms}ms`,
    )
    check(
      'deepest code names the transport class',
      paired.code === 'UND_ERR_CONNECT_TIMEOUT',
      String(paired.code),
    )
  }

  const crossed = runNodeProbe(`${PROBE_PRELUDE}
    try {
      await fetch('https://192.0.2.1/unreachable', { dispatcher: agent, signal: AbortSignal.timeout(8000) });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ms: Date.now() - t0, code: walk(e) }));
    }
  `)
  check(
    'cross-version dispatcher rejection still real (the pairing law stands)',
    crossed.status === 0 && crossed.code === 'UND_ERR_INVALID_ARG',
    String(crossed.code),
  )
}

console.log('— §2 evidence preservation (N-02) —')
{
  const undiciLeaf = Object.assign(new Error('connect ETIMEDOUT'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
    errno: -60,
    syscall: 'connect',
  })
  const fetchFailed = new TypeError('fetch failed', { cause: undiciLeaf })
  const sdkErr = Object.assign(new Error('Connection error.'), {
    name: 'APIConnectionError',
    cause: fetchFailed,
  })
  const deep = evidence.deepestErrorDetail(sdkErr)
  check('deepestErrorDetail walks two levels', deep.code === 'UND_ERR_CONNECT_TIMEOUT')
  check('errno/syscall survive the walk', deep.errno === -60 && deep.syscall === 'connect')

  const detail = apiErrorDetailOf(sdkErr)
  check('apiErrorDetailOf records the deep code (was one-level)', detail.code === 'UND_ERR_CONNECT_TIMEOUT')
  check('transport sub-object carries via cause-chain', detail.transport?.via === 'cause-chain' && detail.transport?.syscall === 'connect')

  const a = new Error('a') as Error & { cause?: unknown }
  const b = new Error('b') as Error & { cause?: unknown }
  a.cause = b
  b.cause = a
  const cyc = evidence.deepestErrorDetail(a)
  check('cause cycles are bounded', typeof cyc.message === 'string')

  evidence._resetTransportEvidenceForTesting()
  evidence.recordTransportFailure(fetchFailed, 'https://api.anthropic.com/v1/messages')
  const bare = Object.assign(new Error('Request timed out.'), {
    name: 'APIConnectionTimeoutError',
  })
  const timeoutDetail = apiErrorDetailOf(bare)
  check(
    'cause-less SDK timeout is enriched from the recent-failure ring',
    timeoutDetail.transport?.via === 'recent-failure' &&
      timeoutDetail.transport?.code === 'UND_ERR_CONNECT_TIMEOUT',
    JSON.stringify(timeoutDetail.transport ?? null),
  )
  check('ring enrichment carries its age honestly', typeof timeoutDetail.transport?.ageMs === 'number')

  evidence._resetTransportEvidenceForTesting()
  const dry = apiErrorDetailOf(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
  check('empty ring ⇒ no transport claim', dry.transport === undefined)
}

console.log('— §3 notice semantics (H-01/H-03) —')
{
  const err = new Error('stream broke')
  const row = createSystemAPIErrorMessage(err, 0, 1, 1, { recoveryTimeoutMs: 300_000 })
  check('fallback notice: retryInMs is a REAL delay (0 — proceeding now)', row.retryInMs === 0)
  check('the ceiling rides recoveryTimeoutMs, its own field', row.recoveryTimeoutMs === 300_000)
  const plain = createSystemAPIErrorMessage(err, 5_000, 2, 10)
  check('retry notices carry no recovery field', plain.recoveryTimeoutMs === undefined && plain.retryInMs === 5_000)
}

console.log('— §4 wiring anchors —')
const src = (p: string) => readFileSync(join(ROOT_FOR_NODE, p), 'utf8')

const proxyTs = src('src/utils/proxy.ts')
check(
  'bare Node path carries the API dispatcher (no more global-default ride)',
  proxyTs.includes('getApiDispatcher()') && /return \{ \.\.\.base, dispatcher: getApiDispatcher\(\) \}/.test(proxyTs),
)
check(
  'proxy path threads the same transport knobs (EnvHttpProxyAgent)',
  /connect:\s*\{[^}]*timeout: knobs\.connectTimeoutMs/.test(proxyTs.replace(/\n/g, ' ')) ||
    proxyTs.includes('timeout: knobs.connectTimeoutMs'),
)
const clientTs = src('src/services/api/client.ts')
check('our fetch wrapper records transport failures (the SDK drops the cause)', clientTs.includes('recordTransportFailure('))
check(
  'API fetch pairs with the dispatcher’s undici (client + zai + owner export)',
  clientTs.includes('fetchOverride ?? getApiFetch()') &&
    src('src/services/providers/zai/zaiClient.ts').includes('options.fetchImpl ?? getApiFetch()') &&
    proxyTs.includes('export function getApiFetch'),
)
const streamTs = src('src/services/providers/anthropic/streamCore.ts')
check(
  'both fallback notices pass a real 0 delay + the ceiling separately',
  (streamTs.match(/createSystemAPIErrorMessage\(\s*[^,]+,\s*0,\s*1,\s*1,\s*\{\s*recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs\(\)/g) || []).length >= 2,
)
check(
  'watchdog aborts surface the REAL idle threshold in the notice error',
  streamTs.includes('STREAM_IDLE_TIMEOUT_MS / 1000}s of stream silence') ||
    /stream idle watchdog[^`]*STREAM_IDLE_TIMEOUT_MS/.test(streamTs),
)
const retryTs = src('src/services/api/withRetry.ts')
check(
  'real retry callers still pass the actual delay AND sleep it',
  retryTs.includes('await sleep(delayMs, options.signal') && retryTs.includes('disableKeepAlive()'),
)
const hooksTs = src('src/tools/WorkflowTool/agentHooks.ts')
check(
  'the workflow stall ladder reads the recovery ceiling too (no budget regression)',
  hooksTs.includes('recoveryTimeoutMs'),
)
const sysMsgTsx = src('src/components/messages/SystemAPIErrorMessage.tsx')
check(
  'renderer: recovery notices say what is happening, not a fake countdown',
  sysMsgTsx.includes('recoveryTimeoutMs'),
)
check(
  'renderer hint helps the UNSET operator too (H-02 site 1)',
  !/\{process\.env\.MERCURY_API_TIMEOUT_MS\s*\?\s*` · MERCURY_API_TIMEOUT_MS=/.test(sysMsgTsx),
)
const assistantTsx = src('src/components/messages/AssistantTextMessage.tsx')
check(
  'assistant timeout hint helps the UNSET operator too (H-02 site 2)',
  !assistantTsx.includes('{process.env.MERCURY_API_TIMEOUT_MS && ('),
)
const registryTs = src('src/substrate/flagRegistry.ts')
check(
  'both transport knobs are registered flags',
  registryTs.includes("'MERCURY_CONNECT_TIMEOUT_MS'") && registryTs.includes("'MERCURY_MAX_CONNECTIONS'"),
)

if (failures > 0) {
  console.error(`\nprove-transport-truth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-transport-truth: all green')
