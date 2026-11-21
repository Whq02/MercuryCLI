import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFixtureRunner } from '../lib/builtProduct.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const watchdog = setTimeout(() => {
  console.error('\nTIMEOUT — prove-list-mcp-resources-tool exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const scratch = mkdtempSync(join(tmpdir(), 'mcp-list-resources-'))
const serverScript = join(scratch, 'resource-server.mjs')
const mcpCfgPath = join(scratch, 'mcp.json')

const fixtureServerSource = `import { createInterface } from 'node:readline'
const resources = JSON.parse(process.env.MCP_FIXTURE_RESOURCES_JSON || '[]')
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: process.env.MCP_FIXTURE_NAME || 'res-srv', version: '1.0.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    return
  }
  if (msg.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { resources } })
    return
  }
  if (msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } })
    return
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } })
  }
})
rl.on('close', () => process.exit(0))
`

const alphaResources = [
  { uri: 'fixture://alpha/readme.txt', name: 'readme', mimeType: 'text/plain', description: 'Alpha text resource' },
  { uri: 'fixture://alpha/logo.bin', name: 'logo', mimeType: 'application/octet-stream', description: 'Alpha binary resource' },
]
const betaResources = [
  { uri: 'fixture://beta/notes.md', name: 'notes', mimeType: 'text/markdown', description: 'Beta notes' },
]

writeFileSync(serverScript, fixtureServerSource, 'utf8')
writeFileSync(
  mcpCfgPath,
  JSON.stringify({
    mcpServers: {
      alpha: {
        type: 'stdio',
        command: nodeBinPath(),
        args: [serverScript],
        env: { MCP_FIXTURE_NAME: 'alpha', MCP_FIXTURE_RESOURCES_JSON: JSON.stringify(alphaResources) },
      },
      beta: {
        type: 'stdio',
        command: nodeBinPath(),
        args: [serverScript],
        env: { MCP_FIXTURE_NAME: 'beta', MCP_FIXTURE_RESOURCES_JSON: JSON.stringify(betaResources) },
      },
    },
  }),
  'utf8',
)

type ToolResultBlock = { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

function findToolResult(body: unknown, toolUseId: string): ToolResultBlock | undefined {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages
  if (!Array.isArray(messages)) return undefined
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as ToolResultBlock[]) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return block
    }
  }
  return undefined
}

function toolResultText(block: ToolResultBlock | undefined): string {
  if (!block) return ''
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map(entry => (typeof (entry as { text?: unknown }).text === 'string' ? (entry as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

try {
  await withFixtureRunner(
    [
      { kind: 'tool_use', id: 'toolu_list_all', name: 'ListMcpResources', input: {} },
      { kind: 'tool_use', id: 'toolu_list_alpha', name: 'ListMcpResources', input: { server: 'alpha' } },
      { kind: 'tool_use', id: 'toolu_list_missing', name: 'ListMcpResources', input: { server: 'no-such-server' } },
      { kind: 'text', text: 'RESOURCES_LISTED.' },
    ],
    async (runner, api) => {
      await runner.prompt('list mcp resources')
      const outcome = await runner.waitFor('turn outcome', row => row.type === 'outcome', 60_000)
      const sessionRow = runner.rows.find(r => r.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }> } | undefined
      const servers = sessionRow?.mcp_servers ?? []
      check('both fixture MCP servers connected', servers.some(s => s.name === 'alpha' && s.status === 'connected') && servers.some(s => s.name === 'beta' && s.status === 'connected'), JSON.stringify(servers))
      check('built runner finished the turn', outcome.type === 'outcome', JSON.stringify(outcome))

      const requests = api.messageRequests().filter(req => !req.path.includes('count_tokens'))
      check('model received all four scripted turns', requests.length === 4, `got ${requests.length}`)

      const offeredNames = (((requests[0]?.body as { tools?: Array<{ name?: string }> } | undefined)?.tools) ?? []).map(
        tool => tool.name,
      )
      check('ListMcpResources is offered to the model when resource-capable servers connect', offeredNames.includes('ListMcpResources'), JSON.stringify(offeredNames.filter(n => n?.includes('Mcp'))))

      const allResult = findToolResult(requests[1]?.body, 'toolu_list_all')
      const allText = toolResultText(allResult)
      let allItems: Array<{ uri?: string; name?: string; mimeType?: string; description?: string; server?: string }> = []
      try {
        allItems = JSON.parse(allText) as typeof allItems
      } catch {
        allItems = []
      }
      check('unfiltered ListMcpResources succeeds without error', allResult !== undefined && allResult.is_error !== true, allText.slice(0, 200))
      check(
        'unfiltered ListMcpResources returns text and binary resources across both servers with server tags',
        allItems.length === 3 &&
          allItems.some(r => r.server === 'alpha' && r.uri === 'fixture://alpha/readme.txt' && r.mimeType === 'text/plain' && r.name === 'readme') &&
          allItems.some(r => r.server === 'alpha' && r.uri === 'fixture://alpha/logo.bin' && r.mimeType === 'application/octet-stream' && r.name === 'logo') &&
          allItems.some(r => r.server === 'beta' && r.uri === 'fixture://beta/notes.md' && r.mimeType === 'text/markdown' && r.name === 'notes'),
        JSON.stringify(allItems),
      )

      const alphaResult = findToolResult(requests[2]?.body, 'toolu_list_alpha')
      const alphaText = toolResultText(alphaResult)
      let alphaItems: Array<{ uri?: string; server?: string }> = []
      try {
        alphaItems = JSON.parse(alphaText) as typeof alphaItems
      } catch {
        alphaItems = []
      }
      check(
        'server-filtered ListMcpResources returns only the named server resources',
        alphaResult?.is_error !== true &&
          alphaItems.length === 2 &&
          alphaItems.every(r => r.server === 'alpha') &&
          alphaItems.some(r => r.uri === 'fixture://alpha/readme.txt') &&
          alphaItems.some(r => r.uri === 'fixture://alpha/logo.bin'),
        JSON.stringify(alphaItems),
      )

      const missingResult = findToolResult(requests[3]?.body, 'toolu_list_missing')
      const missingText = toolResultText(missingResult)
      check(
        'unknown server filter reports an error naming the missing and available servers',
        missingResult?.is_error === true &&
          missingText.includes('no-such-server') &&
          missingText.includes('alpha') &&
          missingText.includes('beta'),
        JSON.stringify({ is_error: missingResult?.is_error, text: missingText }),
      )
    },
    { argv: ['--only-mcp', '--mcp', mcpCfgPath] },
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
  clearTimeout(watchdog)
}

if (failures > 0) {
  console.error(`\nprove-list-mcp-resources-tool: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-list-mcp-resources-tool: all green')
process.exit(0)
