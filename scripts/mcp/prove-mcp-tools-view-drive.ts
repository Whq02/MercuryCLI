#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startCrossfamilyFixture } from '../lib/crossfamilyConcourseFixture.ts'
import { runArtifactArena, grabScreens } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { daemonControlRpc } from '../../src/daemon/controlSocket.ts'
import { readSessionWorkers } from '../../src/daemon/concourseWorkers.ts'
import { readSessionFacts } from '../../src/services/engine-connector/seatProjections.ts'

const ROOT = resolve(import.meta.dir, '../..')
const HOME = process.env.MERCURY_CONFIG_DIR
if (!HOME || resolve(HOME) === join(process.env.HOME ?? '', '.mercury')) throw new Error('a scratch MERCURY_CONFIG_DIR is required')
const SCRATCH = dirname(HOME)
process.env.TMPDIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist/mercury.mjs')
const CAPTURES = process.env.MCP_TOOLS_VIEW_CAPTURE_DIR ?? join(SCRATCH, 'frames')
mkdirSync(CAPTURES, { recursive: true })
const daemonDir = `../${basename(realpathSync(mkdtempSync(join(SCRATCH, 'd-'))))}`
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONCOURSE = 'always'

let checks = 0
let failures = 0
function check(label: string, ok: unknown, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function until(pred: () => boolean | Promise<boolean>, ms = S(25_000)): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await pred()) return true } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

const rpc = (request: Record<string, unknown>) => daemonControlRpc(request as never, { timeoutMs: 15_000 }) as Promise<Record<string, any>>
const model = await startCrossfamilyFixture({ port: 0, gptId: 'gpt-6-astra' })
const mcpMethods: string[] = []
let toolsListCount = 0
let toolsListBeforePopupOpen = 0
const transports = new Set<WebStandardStreamableHTTPServerTransport>()
const servers = new Set<McpServer>()

const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const base = url.origin
    if (req.headers.get('host') !== url.host || (req.headers.has('origin') && req.headers.get('origin') !== base)) {
      return new Response('untrusted host or origin', { status: 403 })
    }
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') return new Response(null, { status: 405 })
      const body = req.method === 'POST' ? await req.clone().json() as { method?: string } : {}
      if (typeof body.method === 'string') {
        mcpMethods.push(body.method)
        if (body.method === 'tools/list') toolsListCount++
      }
      const server = new McpServer({ name: 'tools-view-fixture', version: '1.0.0' })
      server.registerTool('inspect_cluster', {
        description: 'Inspect cluster nodes and interconnect health.',
        inputSchema: z.object({
          clusterId: z.string().describe('Cluster identifier'),
          placement: z.object({
            regionCode: z.string().describe('Data center region'),
            gpuCountPerPod: z.number().optional().describe('GPUs per member pod'),
          }).describe('Nested placement filter'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ clusterId }) => ({
        content: [{ type: 'text', text: `cluster:${clusterId}` }],
      }))
      server.registerTool('purge_queue', {
        description: 'Remove all pending jobs from a serverless queue.',
        inputSchema: z.object({
          endpointId: z.string().describe('Serverless endpoint ID'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      }, async ({ endpointId }) => ({
        content: [{ type: 'text', text: `purged:${endpointId}` }],
      }))
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      transports.add(transport)
      servers.add(server)
      await server.connect(transport)
      return transport.handleRequest(req)
    }
    return fetch(model.base + url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: await req.arrayBuffer() } : {}),
    })
  },
})

const fixtureBase = `http://127.0.0.1:${fixture.port}`
const environment = {
  ...model.env,
  MERCURY_OPENAI_API_BASE: `${fixtureBase}/openai/v1`,
  MERCURY_CONCOURSE: 'always',
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_COORDINATION_MCP: '0',
  MERCURY_PARTY: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
}

let daemon: ReturnType<typeof spawn> | undefined
let sessionId = ''
let runnerId = ''
let journey: Promise<void> = Promise.resolve()
const facts = () => readSessionFacts(sessionId, daemonDir)
const record = () => Object.values(readSessionWorkers()).find(row => row.sessionId === sessionId)
const TITLE = 'MCP Tools View'

const driveText = (path: string): string => {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const row = JSON.parse(line)
        return row.ts ? [Buffer.from(row.b64, 'base64').toString()] : []
      } catch {
        return []
      }
    })
    .join('')
}

let run: Awaited<ReturnType<typeof runArtifactArena>> | undefined
let doorPayload: Record<string, any> | undefined

try {
  run = await runArtifactArena({
    distPath: DIST,
    turns: [],
    keep: true,
    cols: 120,
    rows: 40,
    seconds: 55,
    anchor: null,
    sends: [
      `after:${TITLE}:2200:\\t`,
      `after:${TITLE}:4000:\\r`,
      `after:${TITLE}:5400:\\r`,
      { awaitText: 'Type a prompt', afterPrevMs: 1000, text: '/mcp\r' },
      { awaitText: ['runpod · connected'], afterPrevMs: 500, text: '\r' },
      { awaitText: ['runpod · connected', '2 tools', '  tools', '  disable for this session'], afterPrevMs: 500, text: '\x1b[B\r' },
      { awaitText: ['Mercury · mcp · runpod', 'inspect_cluster · Inspect cluster nodes', 'purge_queue · Remove all pending jobs'], afterPrevMs: 500, text: '\r' },
      { awaitText: ['Mercury · mcp · runpod · inspect_cluster', 'Inspect cluster nodes and interconnect health.', 'Parameters', 'clusterId', 'placement', 'regionCode', 'gpuCountPerPod'], afterPrevMs: 500, text: '\x1b' },
      { awaitText: ['Mercury · mcp · runpod', 'inspect_cluster · Inspect cluster nodes', 'esc back to servers'], awaitAbsent: 'Parameters', afterPrevMs: 500, text: '/purge' },
      { awaitText: ['Mercury · mcp · runpod', 'purge_queue · Remove all pending jobs'], awaitAbsent: 'inspect_cluster', afterPrevMs: 500, text: '\x1b' },
      { awaitText: ['1 servers · this session', 'runpod · connected', 'esc or click outside closes'], awaitAbsent: 'esc back to servers', afterPrevMs: 500, text: '\x1b', arrivedAbsent: '↑↓ move · ↵ act' },
    ],
    extraEnv: environment,
    seedHome: async (home, cwd) => {
      process.chdir(cwd)
      mkdirSync(daemonDir, { recursive: true })
      process.env.MERCURY_CONFIG_DIR = home
      seedFirstRun(home, [cwd])
      const fd = openSync(join(CAPTURES, 'daemon.log'), 'a')
      daemon = spawn('node', [DIST, 'daemon', 'run', cwd], {
        cwd,
        env: { ...process.env, ...environment, MERCURY_CONFIG_DIR: home },
        stdio: ['ignore', fd, fd],
      })
      check('isolated daemon is ready', await until(async () => (await rpc({ op: 'ping' })).ok === true, S(45_000)))
      const admitted = await rpc({
        op: 'sessionDispatch',
        clientMessageId: 'tools-view-birth',
        prompt: 'seat-task-gpt: work on the gpt engine',
        workspaceDir: cwd,
        title: TITLE,
        model: 'gpt-6-astra',
      })
      sessionId = admitted.sessionId ?? ''
      runnerId = admitted.runnerId ?? admitted.workerId ?? ''
      check('session starts without MCP servers', admitted.ok === true && await until(() => facts()?.mcp.length === 0), JSON.stringify(admitted))
      const drive = join(dirname(home), 'drive.jsonl')
      journey = (async () => {
        const opened = await until(() => driveText(drive).includes('No MCP servers'), S(35_000))
        check('empty MCP popup opens on the real UI before server addition (screen never connects to runpod)', opened && toolsListCount === 0)
        const cli = spawn('node', [DIST, 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'runpod', `${fixtureBase}/mcp`], {
          cwd,
          env: { ...process.env, ...environment, MERCURY_CONFIG_DIR: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        cli.stdout.on('data', data => { output += data })
        cli.stderr.on('data', data => { output += data })
        const exit = await new Promise<number | null>(resolve => cli.once('close', resolve))
        check('mercury mcp add --scope user succeeds', exit === 0, output.trim())
        const connected = await until(() => facts()?.mcp.some(row => row.name === 'runpod' && row.type === 'connected' && row.toolCount === 2) === true)
        check('runner connects runpod and reports 2 tools', connected)
        toolsListBeforePopupOpen = toolsListCount
        doorPayload = await rpc({
          op: 'sessionControl',
          action: 'mcp-tools',
          sessionId,
          by: 'proof',
          mcpServer: 'runpod',
        })
      })()
    },
  })
  await journey

  const frames = grabScreens(run, 120, 40, Array.from({ length: 100 }, (_, index) => S(2000 + index * 500))).map(frame => ({
    at: frame.atMs,
    text: frame.rows.map(row => row.trimEnd()).join('\n'),
  }))
  for (const [index, frame] of frames.entries()) {
    if (index === 0 || frame.text !== frames[index - 1]!.text) {
      writeFileSync(join(CAPTURES, `frame-${String(frame.at).padStart(6, '0')}.txt`), frame.text + '\n')
    }
  }
  for (const step of run.sendLog) {
    if (step.step !== undefined && step.screen) {
      writeFileSync(join(CAPTURES, `step-${String(step.step).padStart(2, '0')}.txt`), step.screen.map(row => row.trimEnd()).join('\n') + '\n')
    }
  }

  const stepScreen = (index: number): string => (run?.sendLog.find(row => row.step === index)?.screen ?? []).map(row => row.trimEnd()).join('\n')
  const step2Unfolded = stepScreen(2)
  const step3ToolList = stepScreen(3)
  const step4ToolDetail = stepScreen(4)
  const step5BackToList = stepScreen(5)
  const step6FilteredList = stepScreen(6)
  const step7BackToServers = stepScreen(7)

  const allTexts = [...frames.map(f => f.text), step2Unfolded, step3ToolList, step4ToolDetail, step5BackToList, step6FilteredList, step7BackToServers].join('\n')

  check('↵ on the connected server unfolds the tools action row beside the session dials', step2Unfolded.includes('runpod · connected') && step2Unfolded.includes('2 tools') && step2Unfolded.includes('tools') && step2Unfolded.includes('disable for this session'))
  check('(1) ↵ on the tools row shows both tools with their one-line descriptions and Mercury · mcp · runpod header', step3ToolList.includes('Mercury · mcp · runpod') && step3ToolList.includes('inspect_cluster · Inspect cluster nodes and interconnect health.') && step3ToolList.includes('purge_queue · Remove all pending jobs from a serverless queue.'))
  check('(2) ↵ on a tool shows its detail: Mercury · mcp · runpod · inspect_cluster, full description, and nested schema property names', step4ToolDetail.includes('Mercury · mcp · runpod · inspect_cluster') && step4ToolDetail.includes('Inspect cluster nodes and interconnect health.') && step4ToolDetail.includes('Parameters') && step4ToolDetail.includes('clusterId') && step4ToolDetail.includes('placement') && step4ToolDetail.includes('regionCode') && step4ToolDetail.includes('gpuCountPerPod'))
  check('(3a) esc from tool detail steps back to the tool list without closing the popup', step5BackToList.includes('Mercury · mcp · runpod') && step5BackToList.includes('inspect_cluster') && step5BackToList.includes('esc back to servers') && !step5BackToList.includes('Parameters'))
  check('(5) / filters the tool list in place', step6FilteredList.includes('purge_queue · Remove all pending jobs') && !step6FilteredList.includes('inspect_cluster'))
  check('(3b) esc from the tool list steps back to the server list and keeps the popup open', step7BackToServers.includes('1 servers · this session') && step7BackToServers.includes('runpod · connected') && step7BackToServers.includes('esc or click outside closes'))
  const closedAfterSecondEsc = (run.sendLog.filter(row => row.step !== undefined).length === 8) && (frames[frames.length - 1]?.text.includes('Type a prompt') === true) && !frames[frames.length - 1]!.text.includes('esc or click outside closes')
  check('(3c) esc from the server list closes the popup', closedAfterSecondEsc)
  const payloadTools = doorPayload?.mcpTools?.tools as Array<{ name: string; description: string; inputSchema: Record<string, any>; deferred: boolean }> | undefined
  check('(4a) the connector/daemon door returns the runner-owned serializable McpToolsV1 payload', doorPayload?.ok === true && doorPayload?.outcome === 'applied' && doorPayload?.mcpTools?.server === 'runpod' && Array.isArray(payloadTools) && payloadTools.length === 2 && payloadTools.some(t => t.name === 'inspect_cluster' && t.deferred === true && Boolean(t.inputSchema?.properties?.placement?.properties?.regionCode)))
  check('(4b) the fixture logged the runner’s tools/list calls when connecting and when serving the connector door', toolsListBeforePopupOpen >= 1 && toolsListCount > toolsListBeforePopupOpen && mcpMethods.includes('tools/list'), `before=${toolsListBeforePopupOpen} total=${toolsListCount}`)

  writeFileSync(join(CAPTURES, 'evidence.json'), JSON.stringify({
    checks,
    failures,
    sessionId,
    runnerId,
    mcpMethods,
    toolsListBeforePopupOpen,
    toolsListCount,
    doorPayload,
    record: record(),
    facts: facts(),
    sends: run.sendLog,
    driver: run.driverOut,
    allTextsSample: allTexts.slice(0, 500),
  }, null, 2))
} finally {
  await rpc({ op: 'shutdown' }).catch(() => {})
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM')
  for (const server of servers) await server.close().catch(() => {})
  for (const transport of transports) await transport.close().catch(() => {})
  fixture.stop(true)
  await model.close()
  run?.cleanup()
}

console.log(`${checks - failures}/${checks} checks passed; ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
