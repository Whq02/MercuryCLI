#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'mcp-era-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MCP_TIMEOUT_MS = '4000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod/v4'
import { Client } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  MCP_LEGACY_REVISION,
  MCP_PROTOCOL_REVISION,
  MCP_PUBLISHED_REVISION,
  describeMcpProtocolCurrency,
} from '../../src/integrations/mcp/protocolRevision.js'
import {
  ERA_VERDICT_TTL_MS,
  clearEraVerdict,
  eraVerdictCachePath,
  readEraVerdict,
  recordEraVerdict,
  resetEraVerdictMemo,
} from '../../src/integrations/mcp/eraVerdictCache.js'
import { createLinkedTransportPair } from '../../src/integrations/mcp/InProcessTransport.js'
import { createMercuryServer } from '../../src/integrations/mcp/mercuryServer.js'
import type { JSONRPCMessage, Transport } from '../../src/integrations/mcp-shapes/sdk.js'
import { getMercuryHome } from '../../src/platform/environment/envUtils.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function serveCurrentServer(transport: Transport): { close: () => Promise<void> } {
  return serveStdio(
    async () => {
      const server = new McpServer({ name: 'era-proof', version: '1.0.0' })
      server.registerTool(
        'echo',
        { description: 'echoes its text', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text' as const, text }] }),
      )
      return server
    },
    { transport },
  )
}

function serveOlderServer(transport: Transport): void {
  transport.onmessage = message => {
    const m = message as { id?: number | string; method?: string; params?: { protocolVersion?: string } }
    if (m.method === undefined || m.id === undefined) return
    if (m.method === 'initialize') {
      void transport.send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'older', version: '0' },
        },
      } as JSONRPCMessage)
      return
    }
    void transport.send({
      jsonrpc: '2.0',
      id: m.id,
      error: { code: -32601, message: `Method not found: ${m.method}` },
    } as JSONRPCMessage)
  }
  void transport.start()
}

const textOf = (result: { content?: unknown }): string =>
  ((result.content as Array<{ type?: string; text?: string }> | undefined) ?? []).find(c => c.type === 'text')?.text ?? ''

console.log('============================================================')
console.log(' MCP protocol era — the revision pinned by execution · the verdict cache')
console.log('============================================================')

section('(1) a negotiating client lands on the current era at MCP_PROTOCOL_REVISION')
await (async () => {
  const [clientSide, serverSide] = createLinkedTransportPair()
  const served = serveCurrentServer(serverSide)
  const client = new Client({ name: 'era-proof-client', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(clientSide)
  check('the era is the current one', client.getProtocolEra() === 'modern', `${String(client.getProtocolEra())} · expected modern: a client built with versionNegotiation auto must negotiate MCP_PROTOCOL_REVISION in src/integrations/mcp/protocolRevision.ts; check the SDK pin behind it`)
  check(
    `the negotiated version is MCP_PROTOCOL_REVISION (${MCP_PROTOCOL_REVISION})`,
    client.getNegotiatedProtocolVersion() === MCP_PROTOCOL_REVISION,
    `${String(client.getNegotiatedProtocolVersion())} · MCP_PROTOCOL_REVISION in src/integrations/mcp/protocolRevision.ts must equal the revision the bundled SDK speaks`,
  )
  const echoed = await client.callTool({ name: 'echo', arguments: { text: 'current' } })
  check('a tool call answers on the current era', textOf(echoed) === 'current', `${JSON.stringify(echoed.content)} · the echo tool answered wrongly or not at all on the current era; read the serveCurrentServer fixture at the top of this proof and the SDK client callTool`)
  await client.close()
  await served.close()
})()

section('(2) the same server still serves a client left on the handshake')
await (async () => {
  const [clientSide, serverSide] = createLinkedTransportPair()
  const served = serveCurrentServer(serverSide)
  const client = new Client({ name: 'era-proof-older-client', version: '0' })
  await client.connect(clientSide)
  check('the era is the legacy one', client.getProtocolEra() === 'legacy', `${String(client.getProtocolEra())} · a client built without versionNegotiation must stay on the handshake era; check the client construction in this proof and the SDK pin`)
  check(
    `the handshake settles on MCP_LEGACY_REVISION (${MCP_LEGACY_REVISION})`,
    client.getNegotiatedProtocolVersion() === MCP_LEGACY_REVISION,
    `${String(client.getNegotiatedProtocolVersion())} · MCP_LEGACY_REVISION in src/integrations/mcp/protocolRevision.ts is the SDK LATEST_PROTOCOL_VERSION; the handshake must settle on it`,
  )
  const echoed = await client.callTool({ name: 'echo', arguments: { text: 'older' } })
  check('a tool call answers on the legacy era', textOf(echoed) === 'older', `${JSON.stringify(echoed.content)} · the echo tool answered wrongly or not at all on the legacy era; read the serveCurrentServer fixture at the top of this proof and the SDK client callTool`)
  await client.close()
  await served.close()
})()

section('(3) an older server sends a negotiating client back to the handshake')
await (async () => {
  const [clientSide, serverSide] = createLinkedTransportPair()
  serveOlderServer(serverSide)
  const client = new Client({ name: 'era-proof-client', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(clientSide)
  check('the era is the legacy one', client.getProtocolEra() === 'legacy', `${String(client.getProtocolEra())} · an older server that refuses the revision probe in-band must send the negotiating client back to the handshake; check the SDK pin and serveOlderServer in this proof`)
  check(
    'the older server is identified through the handshake',
    client.getServerVersion()?.name === 'older',
    `${JSON.stringify(client.getServerVersion() ?? null)} · the initialize reply of serveOlderServer (name older) did not reach the client; the handshake fallback did not run`,
  )
  await client.close()
})()

section('(4) the era verdict cache under the config home')
await (async () => {
  resetEraVerdictMemo()
  const t0 = 1_000_000
  await recordEraVerdict('srv-a', 'legacy', t0)
  check('a legacy verdict is remembered', (await readEraVerdict('srv-a', t0 + 1000))?.kind === 'legacy', 'recordEraVerdict or readEraVerdict in src/integrations/mcp/eraVerdictCache.ts did not keep a legacy verdict')
  check('the verdict expires after the TTL', (await readEraVerdict('srv-a', t0 + ERA_VERDICT_TTL_MS + 1)) === undefined, 'readEraVerdict in src/integrations/mcp/eraVerdictCache.ts must return undefined once now minus the recorded time exceeds ERA_VERDICT_TTL_MS')
  await recordEraVerdict('srv-b', 'modern', t0)
  check('a current-era verdict is never remembered', (await readEraVerdict('srv-b', t0)) === undefined, 'recordEraVerdict in src/integrations/mcp/eraVerdictCache.ts must store only legacy verdicts')
  await recordEraVerdict('srv-b', 'legacy', t0)
  await recordEraVerdict('srv-b', 'modern', t0 + 1)
  check('a current-era verdict forgets an older legacy one', (await readEraVerdict('srv-b', t0 + 2)) === undefined, 'recordEraVerdict in src/integrations/mcp/eraVerdictCache.ts must delete the stored entry when it records a non-legacy era')
  resetEraVerdictMemo()
  check('a remembered verdict survives a fresh read from the file', (await readEraVerdict('srv-a', t0 + 1))?.kind === 'legacy', 'the verdict was not written to mcp-era-cache.json, or readCache in src/integrations/mcp/eraVerdictCache.ts does not re-read it after resetEraVerdictMemo')
  await clearEraVerdict('srv-a')
  resetEraVerdictMemo()
  check('a cleared verdict is gone from the file', (await readEraVerdict('srv-a', t0 + 1)) === undefined, 'clearEraVerdict in src/integrations/mcp/eraVerdictCache.ts must delete the entry and write the file')
  check('an unknown server has no verdict', (await readEraVerdict('never-seen')) === undefined, 'readEraVerdict in src/integrations/mcp/eraVerdictCache.ts must return undefined for a key with no entry')
  check(
    'the cache file lives under the config home',
    eraVerdictCachePath() === join(getMercuryHome(), 'mcp-era-cache.json'),
    `${eraVerdictCachePath()} · eraVerdictCachePath in src/integrations/mcp/eraVerdictCache.ts must join getMercuryHome() with mcp-era-cache.json`,
  )
  const secretKey = 'srv-c:{"type":"stdio","command":"x","env":{"TOKEN":"sekrit-value-never-on-disk"}}'
  await recordEraVerdict(secretKey, 'legacy', t0)
  const text = readFileSync(eraVerdictCachePath(), 'utf8')
  check(
    'the file carries a digest of the key, never the configuration',
    !text.includes('sekrit') && !text.includes('srv-c') && Object.keys(JSON.parse(text) as object).every(k => /^[0-9a-f]{64}$/.test(k)),
    `${text.slice(0, 200)} · fileKey in src/integrations/mcp/eraVerdictCache.ts must write only the sha256 hex of the server key`,
  )
  check('…and the verdict reads back under the key', (await readEraVerdict(secretKey, t0 + 1))?.kind === 'legacy', 'readEraVerdict and recordEraVerdict in src/integrations/mcp/eraVerdictCache.ts must hash the key the same way')
  resetEraVerdictMemo()
  check('…from a fresh read of the file too', (await readEraVerdict(secretKey, t0 + 1))?.kind === 'legacy', 'readCache in src/integrations/mcp/eraVerdictCache.ts must reload mcp-era-cache.json after resetEraVerdictMemo')
  writeFileSync(eraVerdictCachePath(), JSON.stringify({ 'not-a-digest': { era: 'legacy', at: t0 } }))
  resetEraVerdictMemo()
  await recordEraVerdict('srv-d', 'legacy', t0)
  const carried = JSON.parse(readFileSync(eraVerdictCachePath(), 'utf8')) as Record<string, unknown>
  check('an entry the cache did not write is carried as written: the next write keeps it beside the digest keys', JSON.stringify(carried['not-a-digest']) === JSON.stringify({ era: 'legacy', at: t0 }) && Object.keys(carried).length === 2, `${JSON.stringify(carried)} · mutate in src/integrations/mcp/eraVerdictCache.ts must write back every entry it read, not only its own digest keys`)
  check('…and is never read: a verdict is looked up by its digest alone', (await readEraVerdict('not-a-digest', t0 + 1)) === undefined && (await readEraVerdict('srv-d', t0 + 1))?.kind === 'legacy', 'readEraVerdict in src/integrations/mcp/eraVerdictCache.ts must look an entry up by fileKey(serverKey) alone')
})()

section('(5) the health row reading')
{
  const currency = describeMcpProtocolCurrency()
  check('the published revision is the one the SDK speaks', MCP_PUBLISHED_REVISION === MCP_PROTOCOL_REVISION, 'MCP_PUBLISHED_REVISION and MCP_PROTOCOL_REVISION in src/integrations/mcp/protocolRevision.ts differ: move the protocol pin to the published revision or fix the published constant')
  check(
    'the row reads current, naming both revisions',
    !currency.behind &&
      currency.line.includes('current') &&
      currency.line.includes(MCP_PROTOCOL_REVISION) &&
      currency.line.includes(MCP_LEGACY_REVISION),
    `${currency.line} · describeMcpProtocolCurrency in src/integrations/mcp/protocolRevision.ts must read current and name both revisions`,
  )
  check('no fix while current', currency.fix === undefined, 'describeMcpProtocolCurrency in src/integrations/mcp/protocolRevision.ts must return no fix when MCP_PROTOCOL_REVISION is not behind')
  check(
    'the handshake revision is older than the current one',
    MCP_LEGACY_REVISION < MCP_PROTOCOL_REVISION,
    `${MCP_LEGACY_REVISION} vs ${MCP_PROTOCOL_REVISION} · MCP_LEGACY_REVISION in src/integrations/mcp/protocolRevision.ts must be an older revision than MCP_PROTOCOL_REVISION`,
  )
  ;(await import('../../src/platform/config/globalConfig.js')).enableConfigs()
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { publishMcpConnections } = await import('../../src/screen/cockpit-gauges/mcpGauge.ts')
  const { describeMcpProtocolCurrency: currencyNow } = await import('../../src/integrations/mcp/protocolRevision.ts')
  publishMcpConnections([{ name: 'fixture-srv', type: 'pending' } as never])
  const mcpSays = await runtimeChecks().find(row => row.id === 'mcp')?.run()
  publishMcpConnections([])
  check('the health row reads its line from the owner', mcpSays?.evidence.startsWith('1 server(s): fixture-srv (starting) · policy ') === true && mcpSays.evidence.includes(` · ${currencyNow().line} · `), `${mcpSays?.evidence} · the mcp row of runtimeChecks in src/platform/health/sections/runtime.ts must read its protocol line from describeMcpProtocolCurrency`)
}

section('(6) the in-process mercury server negotiates the current era the way production serves it')
await (async () => {
  const { connect, close } = await createMercuryServer()
  const [clientSide, serverSide] = createLinkedTransportPair()
  await connect(serverSide)
  const client = new Client({ name: 'era-proof-client', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(clientSide)
  check('the mercury server lands on the current era', client.getProtocolEra() === 'modern', `${String(client.getProtocolEra())} · createMercuryServer in src/integrations/mcp/mercuryServer.ts must serve through serveStdio so an auto-negotiating client lands on the current era`)
  const listed = await client.listTools()
  check('its verbs are listed on the current era', listed.tools.some(t => t.name === 'lease_list'), `${listed.tools.map(t => t.name).join(',')} · createMercuryServer in src/integrations/mcp/mercuryServer.ts must register lease_list`)
  const r = await client.callTool({ name: 'lease_list', arguments: {} })
  const sc = r.structuredContent as { ok?: boolean; reason?: string } | undefined
  check(
    'lease_list answers structured {ok:true, leases:[]} on the current era',
    !!sc && sc.ok === true && Array.isArray(sc.leases) && sc.leases.length === 0,
    `${JSON.stringify(sc ?? null)} · the lease_list tool registered by createMercuryServer in src/integrations/mcp/mercuryServer.ts must return structuredContent ok true with an empty leases array`,
  )
  await client.close()
  await close()
})()


const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.js')
bootstrap.setIsInteractive(false)
const mcp = await import('../../src/integrations/mcp/client.js')
const FIXTURE = join(ROOT, 'scripts', 'mcp', '_fixture-stdio-server.mjs')
const spawnLog = join(HOME, 'spawns.log')
const modeFile = join(HOME, 'mode.txt')
const setMode = (mode: string): void => writeFileSync(modeFile, mode)
const spawns = (): number => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(l => l !== '').length : 0)
const scoped = {
  type: 'stdio',
  command: process.execPath.includes('bun') ? 'node' : process.execPath,
  args: [FIXTURE],
  env: { MCP_FIXTURE_SPAWN_LOG: spawnLog, MCP_FIXTURE_MODE_FILE: modeFile },
  scope: 'local',
} as never
const NAME = 'era-older'
const key = mcp.getServerCacheKey(NAME, scoped)
const settled = (): Promise<void> => clearEraVerdict('era-proof-no-such-server')
const connect = async (): Promise<{ type: string; era: string | undefined; error?: string }> => {
  const { client } = await mcp.reconnectMcpServerImpl(NAME, scoped)
  return {
    type: client.type,
    era: client.type === 'connected' ? client.client.getProtocolEra() : undefined,
    ...(client.type === 'failed' ? { error: client.error } : {}),
  }
}

section('(8) an older stdio server that exits on the revision probe, through production\'s connect')
await (async () => {
  setMode('exit-before-init')
  let c = await connect()
  await settled()
  check('the server that exits on the probe connects anyway, on the legacy era', c.type === 'connected' && c.era === 'legacy', `${JSON.stringify(c)} · the probe-exit fallback in reconnectMcpServerImpl in src/integrations/mcp/client.ts must record a legacy verdict and connect again with the handshake`)
  check('two spawns: the probed process and the re-spawn under the same kill owner', spawns() === 2, `${String(spawns())} · the probe-exit fallback in reconnectMcpServerImpl in src/integrations/mcp/client.ts must re-spawn exactly once`)
  check('the verdict is remembered as legacy under the configuration', (await readEraVerdict(key))?.kind === 'legacy', 'reconnectMcpServerImpl in src/integrations/mcp/client.ts must call recordEraVerdict with the getServerCacheKey key')
  c = await connect()
  await settled()
  check('the next connect rides the verdict: no probe, one spawn, connected at legacy', c.type === 'connected' && c.era === 'legacy' && spawns() === 3, `${JSON.stringify(c)} · ${spawns()} spawns · reconnectMcpServerImpl in src/integrations/mcp/client.ts must read the remembered verdict with readEraVerdict and pass it to client.connect as prior`)
  setMode('method-not-found')
  await recordEraVerdict(key, 'legacy', Date.now() - ERA_VERDICT_TTL_MS - 1)
  resetEraVerdictMemo()
  c = await connect()
  await settled()
  check('an expired verdict probes again; a server that refuses the probe in-band connects on one spawn, at legacy', c.type === 'connected' && c.era === 'legacy' && spawns() === 4, `${JSON.stringify(c)} · ${spawns()} spawns · an expired verdict must be ignored by readEraVerdict in src/integrations/mcp/eraVerdictCache.ts so the connect in src/integrations/mcp/client.ts probes again`)
  check('…and the verdict is remembered afresh', (await readEraVerdict(key))?.kind === 'legacy', 'reconnectMcpServerImpl in src/integrations/mcp/client.ts must record the era after a successful connect (recordEraVerdict)')
  await mcp.clearServerCache(NAME, scoped)
})()

section('(10) a failed connect under a remembered verdict forgets it, by execution')
await (async () => {
  await recordEraVerdict(key, 'legacy')
  setMode('crash-at-start')
  const c = await connect()
  await settled()
  check('a server that dies at start fails the connect', c.type === 'failed', `${JSON.stringify(c)} · the crash-at-start mode of scripts/mcp/_fixture-stdio-server.mjs should make reconnectMcpServerImpl in src/integrations/mcp/client.ts return a failed connection`)
  resetEraVerdictMemo()
  check('…and the remembered verdict is forgotten', (await readEraVerdict(key)) === undefined, 'the catch branch of reconnectMcpServerImpl in src/integrations/mcp/client.ts must call clearEraVerdict when a connect fails')
  setMode('method-not-found')
  const again = await connect()
  await settled()
  check('the next connect probes afresh and lands on legacy through the in-band refusal', again.type === 'connected' && again.era === 'legacy', `${JSON.stringify(again)} · after the verdict is cleared, reconnectMcpServerImpl in src/integrations/mcp/client.ts must probe again and fall back to legacy on the in-band refusal`)
  await mcp.clearServerCache(NAME, scoped)
})()

section('(11) a refusal that lands mid-connect, by execution: the shutdown runs the cleanups while the probed spawn is live — no respawn, no child, a disabled row')
await (async () => {
  const { runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.js')
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const pids = (): number[] => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(l => l !== '').map(Number) : [])
  const holdFile = join(HOME, 'hold')
  writeFileSync(holdFile, '')
  const held = { ...(scoped as Record<string, unknown>), env: { ...(scoped as { env: Record<string, string> }).env, MCP_FIXTURE_HOLD_FILE: holdFile } } as never
  const HELD = 'era-held'
  const heldKey = mcp.getServerCacheKey(HELD, held)
  setMode('exit-before-init')
  const before = spawns()
  const pending = mcp.reconnectMcpServerImpl(HELD, held)
  const deadline = Date.now() + 10_000
  while (spawns() === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  check('the probed process was spawned and holds, the probe in flight', spawns() === before + 1, `${spawns()} spawns · the held fixture (MCP_FIXTURE_HOLD_FILE in scripts/mcp/_fixture-stdio-server.mjs) did not spawn once, or the connect finished early`)
  await runCleanupFunctions()
  const { client: c } = await pending
  await settled()
  check('the connect settles as disabled — never a failure, never a connection', c.type === 'disabled', `${JSON.stringify({ type: c.type, ...(c.type === 'failed' ? { error: c.error } : {}) })} · a shutdown during the probe must make reconnectMcpServerImpl in src/integrations/mcp/client.ts return type disabled (the spawnRefused branches)`)
  check('no respawn: the refusal was read on the reconnect road, and the spawn count is unchanged', spawns() === before + 1, `${spawns()} spawns · the probe-exit fallback in reconnectMcpServerImpl in src/integrations/mcp/client.ts must not re-spawn once spawnRefused is set`)
  const spawned = pids().slice(before)
  const grace = Date.now() + 2_000
  while (spawned.some(alive) && Date.now() < grace) await new Promise(resolve => setTimeout(resolve, 20))
  const stillAlive = spawned.filter(alive)
  check('no child is alive after the refusal', stillAlive.length === 0, `alive: ${stillAlive.join(',')} · the cleanup path of reconnectMcpServerImpl in src/integrations/mcp/client.ts must end the probed stdio tree (endStdioTree)`)
  resetEraVerdictMemo()
  check('no verdict is remembered for a server the shutdown stopped', (await readEraVerdict(heldKey)) === undefined, 'the catch branch of reconnectMcpServerImpl in src/integrations/mcp/client.ts must clear the verdict, not record one, when the shutdown stopped the server')
  rmSync(holdFile, { force: true })
  await mcp.clearServerCache(HELD, held)
})()

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL MCP PROTOCOL ERA CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
