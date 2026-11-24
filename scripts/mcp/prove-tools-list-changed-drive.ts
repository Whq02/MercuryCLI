#!/usr/bin/env bun
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixtureApi, type CapturedRequest } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'
import { untilAsync } from '../lib/untilAsync.ts'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const FIXTURE = join(ROOT, 'scripts', 'mcp', '_fixture-list-changed-server.mjs')
const MODEL = 'claude-fable-5-1'
const BOUND_MS = 60_000

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.log('no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — tools/list_changed drive exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type WireTool = {
  name?: string
  input_schema?: { properties?: { model?: { enum?: string[] } } }
}
type ApiBody = { tools?: WireTool[] }
type McpToolsReply = {
  state: string
  tools: Array<{ name: string; registered_as: string; input_schema: { properties?: { model?: { enum?: string[] } } } }>
}

const requestToolsOf = (req: CapturedRequest | undefined): WireTool[] => {
  if (req === undefined || typeof req.body !== 'object' || req.body === null) return []
  const body = req.body as ApiBody
  return Array.isArray(body.tools) ? body.tools : []
}
const modelEnumOf = (schema: { properties?: { model?: { enum?: string[] } } } | undefined): string[] =>
  schema?.properties?.model?.enum ?? []
const j = (v: unknown): string => JSON.stringify(v)

const scratch = scratchHome('mcp-list-changed-drive-')
const stateFile = join(scratch.home, 'installed.txt')
const mcpFile = join(scratch.home, 'media.mcp.json')
writeFileSync(
  mcpFile,
  JSON.stringify({
    mcpServers: {
      media: {
        command: node,
        args: [FIXTURE],
        env: { MCP_FIXTURE_STATE_FILE: stateFile },
      },
    },
  }),
)

const api = await startFixtureApi([
  { kind: 'tool_use', name: 'mcp__media__install_model', input: { name: 'qwen-image-21' }, preText: 'installing model' },
  { kind: 'text', text: 'Installed qwen-image-21.' },
  { kind: 'text', text: 'Checked next-turn tools.' },
  { kind: 'tool_use', name: 'mcp__media__install_model', input: { name: 'qwen-image-21' }, preText: 'installing again after reconnect' },
  { kind: 'text', text: 'Reinstalled qwen-image-21.' },
])

const host = hostRunner({
  dist: DIST,
  node,
  cwd: scratch.cwd,
  home: scratch.home,
  env: {
    ...scratch.env,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_TOOL_SEARCH: '1',
    MERCURY_MCP_TIMEOUT_MS: '15000',
    MERCURY_DESKTOP_DRIVER: 'none',
    MERCURY_CREDENTIAL_STORE: 'file',
  },
  argv: ['--model', MODEL, '--mode', 'sovereign', '--mcp', mcpFile, '--only-mcp'],
})

const readMcpTools = (): Promise<McpToolsReply> =>
  host.peer.request('mcp/tools', { name: 'media' }, { deadlineMs: 10_000 }) as Promise<McpToolsReply>

let outcomeCount = 0
const waitNextOutcome = async (label: string): Promise<void> => {
  const target = outcomeCount + 1
  const ok = await untilAsync(() => host.rows.filter(row => row.type === 'outcome').length >= target, BOUND_MS, 50)
  if (!ok) throw new Error(`timed out waiting for ${label}`)
  outcomeCount = target
}

try {
  await host.initialize({ holds_asks: true }, 90_000)

  section('§1 initial connect: session holds the opening tool list (2 models, no media_models)')
  const opening = await readMcpTools()
  const openingGen = opening.tools.find(tool => tool.name === 'image_generate')
  check(
    'media is connected with image_generate (2 models) and no media_models',
    opening.state === 'connected' &&
      openingGen !== undefined &&
      !opening.tools.some(tool => tool.name === 'media_models') &&
      j(modelEnumOf(openingGen.input_schema)) === j(['z-image-turbo', 'flux2-klein-4b']),
    j(opening),
  )

  section('§2 install_model triggers notifications/tools/list_changed: the product updates the session tool list without any test listener')
  await host.prompt('Install qwen-image-21 on media.')
  await waitNextOutcome('turn 1 outcome')
  const updated = await untilAsync(async () => {
    const reply = await readMcpTools()
    const gen = reply.tools.find(tool => tool.name === 'image_generate')
    return reply.tools.some(tool => tool.name === 'media_models') && modelEnumOf(gen?.input_schema).includes('qwen-image-21')
  }, 10_000, 100)
  const afterInstall = await readMcpTools()
  const afterInstallGen = afterInstall.tools.find(tool => tool.name === 'image_generate')
  check(
    'the product heard tools/list_changed and refreshed media_models plus the 3-model image_generate in session state',
    updated &&
      afterInstall.tools.some(tool => tool.name === 'media_models') &&
      j(modelEnumOf(afterInstallGen?.input_schema)) === j(['z-image-turbo', 'flux2-klein-4b', 'qwen-image-21']),
    `tools=${j(afterInstall.tools.map(t => ({ name: t.name, models: modelEnumOf(t.input_schema) })))}`,
  )

  section('§3 the next turn sends the refreshed tool list on the wire to the model')
  const requestsBeforeTurn2 = api.requests.length
  await host.prompt('Check media tools on the next request.')
  await waitNextOutcome('turn 2 outcome')
  const turn2Req = api.requests[requestsBeforeTurn2]
  const turn2Tools = requestToolsOf(turn2Req)
  const wireModels = turn2Tools.find(tool => tool.name === 'mcp__media__media_models')
  const wireGen = turn2Tools.find(tool => tool.name === 'mcp__media__image_generate')
  check(
    'the next request offers mcp__media__media_models and the updated 3-model image_generate schema',
    wireModels !== undefined &&
      j(modelEnumOf(wireGen?.input_schema)) === j(['z-image-turbo', 'flux2-klein-4b', 'qwen-image-21']),
    `wireModels=${wireModels?.name ?? 'absent'} wireGenModels=${j(modelEnumOf(wireGen?.input_schema))}`,
  )

  section('§4 after a live reconnect, the product re-registers the listener on the new client')
  rmSync(stateFile, { force: true })
  const reconnected = (await host.peer.request('mcp/action', { name: 'media', action: 'reconnect' }, { deadlineMs: 30_000 })) as { outcome: string; detail?: string }
  const afterReconnect = await readMcpTools()
  check(
    'reconnect restarted media with its fresh 2-model opening tool list',
    reconnected.outcome === 'applied' &&
      !afterReconnect.tools.some(tool => tool.name === 'media_models') &&
      j(modelEnumOf(afterReconnect.tools.find(tool => tool.name === 'image_generate')?.input_schema)) === j(['z-image-turbo', 'flux2-klein-4b']),
    `${j(reconnected)} tools=${j(afterReconnect.tools.map(t => t.name))}`,
  )
  await host.prompt('Install qwen-image-21 again after reconnect.')
  await waitNextOutcome('turn 3 outcome')
  const updatedAgain = await untilAsync(async () => {
    const reply = await readMcpTools()
    const gen = reply.tools.find(tool => tool.name === 'image_generate')
    return reply.tools.some(tool => tool.name === 'media_models') && modelEnumOf(gen?.input_schema).includes('qwen-image-21')
  }, 10_000, 100)
  const afterSecondInstall = await readMcpTools()
  check(
    'after reconnect, tools/list_changed still refreshes the session tool list',
    updatedAgain &&
      afterSecondInstall.tools.some(tool => tool.name === 'media_models') &&
      j(modelEnumOf(afterSecondInstall.tools.find(tool => tool.name === 'image_generate')?.input_schema)) === j(['z-image-turbo', 'flux2-klein-4b', 'qwen-image-21']),
    `tools=${j(afterSecondInstall.tools.map(t => ({ name: t.name, models: modelEnumOf(t.input_schema) })))}`,
  )
} catch (error) {
  check('the drive ran to completion', false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
} finally {
  await host.stop().catch(() => {})
  await api.close().catch(() => {})
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'tools-list-changed-drive: GREEN' : `tools-list-changed-drive: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
