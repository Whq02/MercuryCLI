#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'MERCURY_API_UNIX_SOCKET', 'MERCURY_CLIENT_CERT', 'MERCURY_CLIENT_KEY',
  'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_PROVIDER_HEADERS', 'MERCURY_WIRE_DUMP', 'MERCURY_BARE', 'MERCURY_PROVIDER_BETAS',
  'MERCURY_MODEL', 'MERCURY_ENTRYPOINT', 'MERCURY_EXTRA_BODY', 'MERCURY_EXTRA_METADATA',
  'MERCURY_ANTHROPIC_CLIENT_CONTRACT', 'MERCURY_RECOVERY_BUDGET_MINUTES', 'MERCURY_MAX_RETRIES',
  'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
]) delete process.env[key]
delete process.env.NODE_ENV

const home = mkdtempSync(join(tmpdir(), 'perm-explainer-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}

type CapturedRequest = {
  path: string
  body: Record<string, unknown>
}

const requests: CapturedRequest[] = []
let nextResponseContent: Array<Record<string, unknown>> = []

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    requests.push({ path: (req.url ?? '').split('?')[0]!, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: `msg_fixture_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: String(body.model ?? 'claude-sonnet-4-6'),
        stop_reason: 'tool_use',
        content: nextResponseContent,
        usage: { input_tokens: 42, output_tokens: 18 },
      }),
    )
  })
})

try {
  const port = await new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

  const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const { setEngineModelOverride } = await import('../../src/boot/process-state/processState.js')
  setEngineModelOverride('claude-sonnet-4-6')
  const { generatePermissionExplanation } = await import('../../src/permissions/explainer/permissionExplainer.js')

  const expected = {
    explanation: 'Removes the local build output directory recursively.',
    reasoning: 'I need to clear stale build files before running a clean compile.',
    risk: 'Deletes build/ without confirmation; unrecoverable if untracked files live there.',
    riskLevel: 'MEDIUM' as const,
  }
  nextResponseContent = [
    {
      type: 'tool_use',
      id: 'toolu_explain_1',
      name: 'explain_command',
      input: expected,
    },
  ]

  const result = await generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'rm -rf build/' },
    toolDescription: 'Clean build output',
    messages: [
      {
        type: 'assistant',
        uuid: 'a1' as never,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Next I will clear the stale build folder.' }] },
      } as never,
    ],
    signal: new AbortController().signal,
  })

  check('sends exactly one model request to /v1/messages', requests.length === 1 && requests[0]?.path === '/v1/messages', { count: requests.length, path: requests[0]?.path })
  check('returns the parsed explanation from the tool_use block', JSON.stringify(result) === JSON.stringify(expected), { result })

  const sent = requests[0]?.body ?? {}
  const systemTexts = Array.isArray(sent.system)
    ? (sent.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n')
    : String(sent.system ?? '')
  check('wire request carries the explainer system prompt', systemTexts.includes('Look at the shell command the agent wants to run'), { system: sent.system })

  const sentMessages = Array.isArray(sent.messages) ? (sent.messages as Array<{ role?: string; content?: string }>) : []
  const userText = typeof sentMessages[0]?.content === 'string' ? sentMessages[0].content : ''
  check(
    'wire request carries the user prompt with tool name, input, description and recent assistant context',
    sentMessages.length === 1 &&
      sentMessages[0]?.role === 'user' &&
      userText.includes('Tool: Bash') &&
      userText.includes('rm -rf build/') &&
      userText.includes('Clean build output') &&
      userText.includes('clear the stale build folder'),
    { sentMessages },
  )

  const sentTools = Array.isArray(sent.tools) ? (sent.tools as Array<Record<string, unknown>>) : []
  const tool = sentTools[0] ?? {}
  check(
    'wire tool declares input_schema (not inputSchema) for explain_command',
    sentTools.length === 1 &&
      tool.name === 'explain_command' &&
      typeof tool.input_schema === 'object' &&
      tool.input_schema !== null &&
      !('inputSchema' in tool),
    { tool },
  )
  check(
    'wire request forces explain_command tool_choice',
    JSON.stringify(sent.tool_choice) === JSON.stringify({ type: 'tool', name: 'explain_command' }),
    { tool_choice: sent.tool_choice },
  )

  const second = await generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'ls -la' },
    signal: new AbortController().signal,
  })
  check('a second ask sends one more model request and answers', requests.length === 2 && second?.riskLevel === 'MEDIUM', { count: requests.length, second })

  nextResponseContent = [{ type: 'text', text: 'Not a tool call.' }]
  const noToolUse = await generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    signal: new AbortController().signal,
  })
  check('response without a tool_use block returns null', noToolUse === null && requests.length === 3, { noToolUse, count: requests.length })

  nextResponseContent = [{ type: 'tool_use', id: 'toolu_bad', name: 'explain_command', input: { explanation: 'x', riskLevel: 'CRITICAL' } }]
  const invalidPayload = await generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    signal: new AbortController().signal,
  })
  check('response with invalid schema returns null', invalidPayload === null && requests.length === 4, { invalidPayload, count: requests.length })

  saveGlobalConfig(current => ({ ...current, permissionExplainerEnabled: false }))
  const disabled = await generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    signal: new AbortController().signal,
  })
  check('when disabled returns null without sending a request', disabled === null && requests.length === 4, { disabled, count: requests.length })
} finally {
  server.close()
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nPASS: permission explainer wire and parsing checks green')
