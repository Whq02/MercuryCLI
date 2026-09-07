#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
} from '../../src/services/mcp/protocolRevision.js'
import {
  ERA_VERDICT_TTL_MS,
  clearEraVerdict,
  eraVerdictCachePath,
  readEraVerdict,
  recordEraVerdict,
  resetEraVerdictMemo,
} from '../../src/services/mcp/eraVerdictCache.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import type { JSONRPCMessage, Transport } from '../../src/services/mcp/sdk.js'
import { getMercuryHome } from '../../src/utils/envUtils.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const SRC = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

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
  check('the era is the current one', client.getProtocolEra() === 'modern', String(client.getProtocolEra()))
  check(
    `the negotiated version is MCP_PROTOCOL_REVISION (${MCP_PROTOCOL_REVISION})`,
    client.getNegotiatedProtocolVersion() === MCP_PROTOCOL_REVISION,
    String(client.getNegotiatedProtocolVersion()),
  )
  const echoed = await client.callTool({ name: 'echo', arguments: { text: 'current' } })
  check('a tool call answers on the current era', textOf(echoed) === 'current', JSON.stringify(echoed.content))
  await client.close()
  await served.close()
})()

section('(2) the same server still serves a client left on the handshake')
await (async () => {
  const [clientSide, serverSide] = createLinkedTransportPair()
  const served = serveCurrentServer(serverSide)
  const client = new Client({ name: 'era-proof-older-client', version: '0' })
  await client.connect(clientSide)
  check('the era is the legacy one', client.getProtocolEra() === 'legacy', String(client.getProtocolEra()))
  check(
    `the handshake settles on MCP_LEGACY_REVISION (${MCP_LEGACY_REVISION})`,
    client.getNegotiatedProtocolVersion() === MCP_LEGACY_REVISION,
    String(client.getNegotiatedProtocolVersion()),
  )
  const echoed = await client.callTool({ name: 'echo', arguments: { text: 'older' } })
  check('a tool call answers on the legacy era', textOf(echoed) === 'older', JSON.stringify(echoed.content))
  await client.close()
  await served.close()
})()

section('(3) an older server sends a negotiating client back to the handshake')
await (async () => {
  const [clientSide, serverSide] = createLinkedTransportPair()
  serveOlderServer(serverSide)
  const client = new Client({ name: 'era-proof-client', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(clientSide)
  check('the era is the legacy one', client.getProtocolEra() === 'legacy', String(client.getProtocolEra()))
  check(
    'the older server is identified through the handshake',
    client.getServerVersion()?.name === 'older',
    JSON.stringify(client.getServerVersion() ?? null),
  )
  await client.close()
})()

section('(4) the era verdict cache under the config home')
await (async () => {
  resetEraVerdictMemo()
  const t0 = 1_000_000
  await recordEraVerdict('srv-a', 'legacy', t0)
  check('a legacy verdict is remembered', (await readEraVerdict('srv-a', t0 + 1000))?.kind === 'legacy')
  check('the verdict expires after the TTL', (await readEraVerdict('srv-a', t0 + ERA_VERDICT_TTL_MS + 1)) === undefined)
  await recordEraVerdict('srv-b', 'modern', t0)
  check('a current-era verdict is never remembered', (await readEraVerdict('srv-b', t0)) === undefined)
  await recordEraVerdict('srv-b', 'legacy', t0)
  await recordEraVerdict('srv-b', 'modern', t0 + 1)
  check('a current-era verdict forgets an older legacy one', (await readEraVerdict('srv-b', t0 + 2)) === undefined)
  resetEraVerdictMemo()
  check('a remembered verdict survives a fresh read from the file', (await readEraVerdict('srv-a', t0 + 1))?.kind === 'legacy')
  await clearEraVerdict('srv-a')
  resetEraVerdictMemo()
  check('a cleared verdict is gone from the file', (await readEraVerdict('srv-a', t0 + 1)) === undefined)
  check('an unknown server has no verdict', (await readEraVerdict('never-seen')) === undefined)
  check(
    'the cache file lives under the config home',
    eraVerdictCachePath() === join(getMercuryHome(), 'mcp-era-cache.json'),
    eraVerdictCachePath(),
  )
  const secretKey = 'srv-c:{"type":"stdio","command":"x","env":{"TOKEN":"sekrit-value-never-on-disk"}}'
  await recordEraVerdict(secretKey, 'legacy', t0)
  const text = readFileSync(eraVerdictCachePath(), 'utf8')
  check(
    'the file carries a digest of the key, never the configuration',
    !text.includes('sekrit') && !text.includes('srv-c') && Object.keys(JSON.parse(text) as object).every(k => /^[0-9a-f]{64}$/.test(k)),
    text.slice(0, 200),
  )
  check('…and the verdict reads back under the key', (await readEraVerdict(secretKey, t0 + 1))?.kind === 'legacy')
  resetEraVerdictMemo()
  check('…from a fresh read of the file too', (await readEraVerdict(secretKey, t0 + 1))?.kind === 'legacy')
  writeFileSync(eraVerdictCachePath(), JSON.stringify({ 'old:{"env":{"TOKEN":"sekrit-old"}}': { era: 'legacy', at: t0 } }))
  resetEraVerdictMemo()
  await recordEraVerdict('srv-d', 'legacy', t0)
  check('a key written in clear by an earlier file is dropped at the next write', !readFileSync(eraVerdictCachePath(), 'utf8').includes('sekrit-old'))
  check('…while the digest keys stay', (await readEraVerdict('srv-d', t0 + 1))?.kind === 'legacy')
})()

section('(5) the doctor row reading')
{
  const currency = describeMcpProtocolCurrency()
  check('the published revision is the one the SDK speaks', MCP_PUBLISHED_REVISION === MCP_PROTOCOL_REVISION)
  check(
    'the row reads current, naming both revisions',
    !currency.behind &&
      currency.line.includes('current') &&
      currency.line.includes(MCP_PROTOCOL_REVISION) &&
      currency.line.includes(MCP_LEGACY_REVISION),
    currency.line,
  )
  check('no fix while current', currency.fix === undefined)
  check(
    'the handshake revision is older than the current one',
    MCP_LEGACY_REVISION < MCP_PROTOCOL_REVISION,
    `${MCP_LEGACY_REVISION} vs ${MCP_PROTOCOL_REVISION}`,
  )
  const owner = SRC('src/services/mcp/protocolRevision.ts')
  check(
    'the behind wording is kept for the next published revision',
    owner.includes('is published — SDK behind') && owner.includes('update Mercury when a build ships the migration'),
  )
  const doctor = SRC('src/utils/healthReport.ts')
  check('the doctor row reads its line from the owner', doctor.includes('describeMcpProtocolCurrency()') && !doctor.includes('KNOWN_NEXT_MCP_REV'))
}

section('(6) the coordination server negotiates the current era the way production serves it')
await (async () => {
  const { connect, close } = await createCoordinationServer()
  const [clientSide, serverSide] = createLinkedTransportPair()
  await connect(serverSide)
  const client = new Client({ name: 'era-proof-client', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(clientSide)
  check('the coordination server lands on the current era', client.getProtocolEra() === 'modern', String(client.getProtocolEra()))
  const listed = await client.listTools()
  check('its verbs are listed on the current era', listed.tools.some(t => t.name === 'lease_list'), listed.tools.map(t => t.name).join(','))
  const r = await client.callTool({ name: 'lease_list', arguments: {} })
  const sc = r.structuredContent as { ok?: boolean; reason?: string } | undefined
  check(
    'solo lease_list answers structured {ok:false, NOT_IN_TEAM} on the current era',
    !!sc && sc.ok === false && sc.reason === 'NOT_IN_TEAM',
    JSON.stringify(sc ?? null),
  )
  await client.close()
  await close()
})()

section("(7) production's client shape, structurally")
{
  const client = SRC('src/services/mcp/client.ts')
  check('both elicitation modes are declared on the wire', client.includes('elicitation: { form: {}, url: {} }'))
  check(
    'external servers negotiate; the editor bridges keep the handshake',
    client.includes("versionNegotiation: negotiate ? externalVersionNegotiation(transportKind) : { mode: 'legacy' }") &&
      client.includes("buildClient(!isIde, stdioTransport !== null ? 'stdio' : 'remote')"),
  )
  check(
    'the SDK host on the control channel keeps the handshake',
    client.includes("{ capabilities: {}, versionNegotiation: { mode: 'legacy' } }"),
  )
  check(
    'the remembered verdict rides the connect and a failed connect drops it',
    client.includes('client.connect(transport, prior ? { prior } : undefined)') && client.includes('void clearEraVerdict(eraKey)'),
  )
  check(
    'the probe budget is per transport with no re-sends: a third of the connect deadline on stdio (a silent probe there is an older server, and the handshake gets the rest), past the deadline on the remote transports (a silent probe there is an error, and the deadline must speak first)',
    client.includes("transportKind === 'stdio' ? Math.max(1000, Math.floor(deadline / 3)) : deadline + 1000") && client.includes('maxRetries: 0'),
  )
  check(
    "the stdio transport is a subclass of the SDK's, so the probe runs in place on the one process Mercury owns — never on a disposable sibling spawn outside the kill owner",
    client.includes('class OwnedStdioClientTransport extends StdioClientTransport {}') && client.includes('return new OwnedStdioClientTransport({') && !client.includes('new StdioClientTransport('),
  )
  check(
    'a stdio server that exits on the probe is remembered as an older server and connected once more with the handshake alone, on a fresh spawn under the same kill owner, inside the one deadline',
    client.includes('if (stdioTransport === null || prior || !isProbeExitError(err)) throw err') &&
      client.includes("void recordEraVerdict(eraKey, 'legacy')") &&
      /await endStdioTree\(\)\s*\n\s*stdioTransport\.stderr\?\.off\('data', onStderr\)\s*\n\s*stdioTransport = buildStdioTransport\(\)/.test(client) &&
      client.includes('client = buildClient(false)') &&
      client.includes("error.code === SdkErrorCode.EraNegotiationFailed") && client.includes('/closed during the server\\/discover probe/.test(error.message)'),
  )
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setIsInteractive(false)
const mcp = await import('../../src/services/mcp/client.js')
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
  check('the server that exits on the probe connects anyway, on the legacy era', c.type === 'connected' && c.era === 'legacy', JSON.stringify(c))
  check('two spawns: the probed process and the re-spawn under the same kill owner', spawns() === 2, String(spawns()))
  check('the verdict is remembered as legacy under the configuration', (await readEraVerdict(key))?.kind === 'legacy')
  c = await connect()
  await settled()
  check('the next connect rides the verdict: no probe, one spawn, connected at legacy', c.type === 'connected' && c.era === 'legacy' && spawns() === 3, `${JSON.stringify(c)} · ${spawns()} spawns`)
  setMode('method-not-found')
  await recordEraVerdict(key, 'legacy', Date.now() - ERA_VERDICT_TTL_MS - 1)
  resetEraVerdictMemo()
  c = await connect()
  await settled()
  check('an expired verdict probes again; a server that refuses the probe in-band connects on one spawn, at legacy', c.type === 'connected' && c.era === 'legacy' && spawns() === 4, `${JSON.stringify(c)} · ${spawns()} spawns`)
  check('…and the verdict is remembered afresh', (await readEraVerdict(key))?.kind === 'legacy')
  await mcp.clearServerCache(NAME, scoped)
})()

section('(10) a failed connect under a remembered verdict forgets it, by execution')
await (async () => {
  await recordEraVerdict(key, 'legacy')
  setMode('crash-at-start')
  const c = await connect()
  await settled()
  check('a server that dies at start fails the connect', c.type === 'failed', JSON.stringify(c))
  resetEraVerdictMemo()
  check('…and the remembered verdict is forgotten', (await readEraVerdict(key)) === undefined)
  setMode('method-not-found')
  const again = await connect()
  await settled()
  check('the next connect probes afresh and lands on legacy through the in-band refusal', again.type === 'connected' && again.era === 'legacy', JSON.stringify(again))
  await mcp.clearServerCache(NAME, scoped)
})()

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL MCP PROTOCOL ERA CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
