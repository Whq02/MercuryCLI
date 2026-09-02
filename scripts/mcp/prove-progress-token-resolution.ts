#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { callMCPToolWithUrlElicitationRetry } = await import(join(SRC, 'services/mcp/client.ts'))
const { wireSafeMcpToolName } = await import(join(SRC, 'services/mcp/mcpStringUtils.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SERVER = 'progress-srv'
const sdkClient = { name: SERVER, config: { type: 'sdk' }, client: {} } as never

type Call = { toolUseId: string | undefined; progress: Array<Record<string, unknown>> }

async function drive(tool: string, parentContent: unknown[]): Promise<Call> {
  const progress: Array<Record<string, unknown>> = []
  const parentMessage = { message: { content: parentContent } } as never
  const result: Call = { toolUseId: 'UNSET', progress } as never
  await callMCPToolWithUrlElicitationRetry({
    client: sdkClient,
    tool,
    args: {},
    signal: new AbortController().signal,
    parentMessage,
    onProgress: (event: unknown) => progress.push(event as Record<string, unknown>),
    callFn: async (_c: unknown, toolUseId: string | undefined) => {
      result.toolUseId = toolUseId
      return { content: 'ok' }
    },
  } as never)
  return result
}

const wire = (tool: string): string => wireSafeMcpToolName(SERVER, tool)

console.log('L1 a narrating model — text block first, the call still has its id')
{
  const r = await drive('long_search', [
    { type: 'text', text: 'Let me search for that.' },
    { type: 'tool_use', id: 'toolu_A', name: wire('long_search'), input: {} },
  ])
  check('the id is the matching block, not undefined', r.toolUseId === 'toolu_A', `resolved=${String(r.toolUseId)}`)
  const started = r.progress.find(p => (p.data as { type?: string } | undefined)?.type === 'mcp_progress')
  check('progress flows (the started event carries the id)', started !== undefined && started.toolUseID === 'toolu_A', JSON.stringify(r.progress[0] ?? null))
}

console.log('L2 two parallel calls — each resolves ITS OWN block')
{
  const content = [
    { type: 'tool_use', id: 'toolu_ONE', name: wire('alpha'), input: {} },
    { type: 'tool_use', id: 'toolu_TWO', name: wire('beta'), input: {} },
  ]
  const first = await drive('alpha', content)
  const second = await drive('beta', content)
  check('the first call owns its block', first.toolUseId === 'toolu_ONE', `resolved=${String(first.toolUseId)}`)
  check('the second call owns its block (never the first block id)', second.toolUseId === 'toolu_TWO', `resolved=${String(second.toolUseId)}`)
  check('their progress routes are distinct', first.progress.every(p => p.toolUseID === 'toolu_ONE') && second.progress.every(p => p.toolUseID === 'toolu_TWO'))
}

console.log('L3 the bare tool name matches too')
{
  const r = await drive('gamma', [
    { type: 'text', text: 'thinking…' },
    { type: 'tool_use', id: 'toolu_BARE', name: 'gamma', input: {} },
  ])
  check('a bare-named block resolves', r.toolUseId === 'toolu_BARE', `resolved=${String(r.toolUseId)}`)
}

console.log('L4 controls')
{
  const lead = await drive('delta', [{ type: 'tool_use', id: 'toolu_LEAD', name: wire('delta'), input: {} }])
  check('a tool_use-first message still resolves (the old happy path)', lead.toolUseId === 'toolu_LEAD', `resolved=${String(lead.toolUseId)}`)
  const none = await drive('epsilon', [{ type: 'text', text: 'no call here' }])
  check('no matching block yields undefined — no fabricated id, no progress sink', none.toolUseId === undefined && none.progress.length === 0, `resolved=${String(none.toolUseId)} progress=${none.progress.length}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
