import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  console.error('\nTIMEOUT — prove-read-mcp-resource-tool exceeded 90s')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const TEXT_BODY = 'hello from mcp resource\nsecond line of fixture'
const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])

const scratch = mkdtempSync(join(tmpdir(), 'mcp-read-resource-'))
const serverScript = join(scratch, 'read-resource-server.mjs')
const mcpCfgPath = join(scratch, 'mcp.json')

const fixtureServerSource = `import { createInterface } from 'node:readline'
const textBody = process.env.MCP_FIXTURE_TEXT || ''
const binaryBase64 = process.env.MCP_FIXTURE_BLOB || ''
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
        serverInfo: { name: 'vault', version: '1.0.0' },
      },
    })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
    return
  }
  if (msg.method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        resources: [
          { uri: 'fixture://vault/note.txt', name: 'note', mimeType: 'text/plain' },
          { uri: 'fixture://vault/icon.png', name: 'icon', mimeType: 'image/png' },
        ],
      },
    })
    return
  }
  if (msg.method === 'resources/read') {
    const uri = msg.params?.uri
    if (uri === 'fixture://vault/note.txt') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: [{ uri, mimeType: 'text/plain', text: textBody }] },
      })
      return
    }
    if (uri === 'fixture://vault/icon.png') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: [{ uri, mimeType: 'image/png', blob: binaryBase64 }] },
      })
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Resource not found: ' + String(uri) } })
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

writeFileSync(serverScript, fixtureServerSource, 'utf8')
writeFileSync(
  mcpCfgPath,
  JSON.stringify({
    mcpServers: {
      vault: {
        type: 'stdio',
        command: nodeBinPath(),
        args: [serverScript],
        env: {
          MCP_FIXTURE_TEXT: TEXT_BODY,
          MCP_FIXTURE_BLOB: BINARY_BYTES.toString('base64'),
        },
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
      { kind: 'tool_use', id: 'toolu_read_text', name: 'ReadMcpResource', input: { server: 'vault', uri: 'fixture://vault/note.txt' } },
      { kind: 'tool_use', id: 'toolu_read_bin', name: 'ReadMcpResource', input: { server: 'vault', uri: 'fixture://vault/icon.png' } },
      { kind: 'tool_use', id: 'toolu_read_missing', name: 'ReadMcpResource', input: { server: 'ghost', uri: 'fixture://vault/note.txt' } },
      { kind: 'text', text: 'RESOURCES_READ.' },
    ],
    async (runner, api) => {
      await runner.prompt('read mcp resources')
      const outcome = await runner.waitFor('turn outcome', row => row.type === 'outcome', 60_000)
      const sessionRow = runner.rows.find(r => r.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }> } | undefined
      const servers = sessionRow?.mcp_servers ?? []
      check('fixture vault MCP server connected', servers.some(s => s.name === 'vault' && s.status === 'connected'), JSON.stringify(servers))
      check('built runner finished the turn', outcome.type === 'outcome', JSON.stringify(outcome))

      const requests = api.messageRequests().filter(req => !req.path.includes('count_tokens'))
      check('model received all four scripted turns', requests.length === 4, `got ${requests.length}`)

      const offeredNames = (((requests[0]?.body as { tools?: Array<{ name?: string }> } | undefined)?.tools) ?? []).map(
        tool => tool.name,
      )
      check('ReadMcpResource is offered to the model when a resource-capable server connects', offeredNames.includes('ReadMcpResource'), JSON.stringify(offeredNames.filter(n => n?.includes('Mcp'))))

      const textResult = findToolResult(requests[1]?.body, 'toolu_read_text')
      const textRaw = toolResultText(textResult)
      let textEntry: { uri?: string; mimeType?: string; text?: string } | undefined
      try {
        const textParsed = JSON.parse(textRaw) as { contents?: Array<{ uri?: string; mimeType?: string; text?: string }> }
        textEntry = textParsed?.contents?.[0]
      } catch {
        textEntry = undefined
      }
      check(
        'text resource returns exact text content and MIME type without error',
        textResult?.is_error !== true &&
          textEntry?.uri === 'fixture://vault/note.txt' &&
          textEntry?.mimeType === 'text/plain' &&
          textEntry?.text === TEXT_BODY,
        textRaw.slice(0, 240),
      )

      const binResult = findToolResult(requests[2]?.body, 'toolu_read_bin')
      const binRaw = toolResultText(binResult)
      let binEntry: { uri?: string; mimeType?: string; blobSavedTo?: string; text?: string } | undefined
      try {
        const binParsed = JSON.parse(binRaw) as { contents?: Array<{ uri?: string; mimeType?: string; blobSavedTo?: string; text?: string }> }
        binEntry = binParsed?.contents?.[0]
      } catch {
        binEntry = undefined
      }
      const savedPath = binEntry?.blobSavedTo ?? ''
      const savedExists = savedPath !== '' && existsSync(savedPath)
      const savedBytes = savedExists ? readFileSync(savedPath) : Buffer.alloc(0)
      check(
        'binary resource returns saved-file notice naming blobSavedTo',
        binResult?.is_error !== true &&
          binEntry?.uri === 'fixture://vault/icon.png' &&
          binEntry?.mimeType === 'image/png' &&
          savedPath !== '' &&
          typeof binEntry?.text === 'string' &&
          binEntry.text.includes(savedPath) &&
          binEntry.text.includes('vault'),
        binRaw.slice(0, 300),
      )
      check(
        'saved binary resource file on disk matches exact server bytes',
        savedExists && savedBytes.equals(BINARY_BYTES),
        JSON.stringify({ savedPath, savedExists, len: savedBytes.length }),
      )

      const missingResult = findToolResult(requests[3]?.body, 'toolu_read_missing')
      const missingText = toolResultText(missingResult)
      check(
        'unknown server reports an error naming the missing and available server',
        missingResult?.is_error === true && missingText.includes('ghost') && missingText.includes('vault'),
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
  console.error(`\nprove-read-mcp-resource-tool: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-read-mcp-resource-tool: all green')
process.exit(0)
