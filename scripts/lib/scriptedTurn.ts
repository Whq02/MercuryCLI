import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { PROBE_KEY, bootRunner, bound, childEnv, configKeyOf, isResult, user } from '../daemon/dupline-world.ts'

export type WireBlock = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
export type SeenResult = { toolUseId: string; text: string; isError: boolean }
export type ScriptedRequest = { n: number; ask: string; opening: string; step: number; results: SeenResult[]; toolNames: string[] }
export type Script = (req: ScriptedRequest) => WireBlock[]
export type ScriptedFixture = { base: string; requests: ScriptedRequest[]; close: () => Promise<void> }

type Block = { type?: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: unknown }
type Item = { role?: string; content?: unknown }

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => ((b as Block).type === 'text' ? ((b as Block).text ?? '') : '')).join('')
      : ''

function askOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}

const carriesResults = (item: Item): boolean => item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')

function resultsOf(item: Item | undefined): SeenResult[] {
  if (!item || !Array.isArray(item.content)) return []
  return (item.content as Block[])
    .filter(p => p.type === 'tool_result')
    .map(p => ({ toolUseId: String(p.tool_use_id ?? ''), text: textOf(p.content), isError: p.is_error === true }))
}

export function describeRequest(body: unknown, n: number): ScriptedRequest {
  const items = Array.isArray((body as { messages?: unknown })?.messages) ? ((body as { messages: Item[] }).messages) : []
  const toolNames = Array.isArray((body as { tools?: unknown })?.tools)
    ? ((body as { tools: Array<{ name?: unknown }> }).tools).map(t => String(t.name ?? ''))
    : []
  let askIndex = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role === 'user' && !carriesResults(item) && askOf(item.content) !== '') {
      askIndex = i
      break
    }
  }
  let opening = ''
  for (const item of items) {
    if (item.role !== 'user') continue
    const a = askOf(item.content)
    if (a !== '') {
      opening = a
      break
    }
  }
  const after = askIndex === -1 ? [] : items.slice(askIndex + 1).filter(carriesResults)
  return {
    n,
    ask: askIndex === -1 ? '' : askOf(items[askIndex]!.content),
    opening,
    step: after.length,
    results: resultsOf(after[after.length - 1]),
    toolNames,
  }
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }

function jsonAnswer(n: number, model: string, blocks: WireBlock[]): string {
  const content = blocks.map((b, i) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: `toolu_st_${n}_${i}`, name: b.name, input: b.input }))
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  return JSON.stringify({ id: `msg_st_${n}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage })
}

function sseAnswer(n: number, model: string, blocks: WireBlock[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts = [`event: message_start\n${sse({ type: 'message_start', message: { id: `msg_st_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}`]
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_st_${n}_${index}`, name: b.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage })}`, `event: message_stop\n${sse({ type: 'message_stop' })}`)
  return parts.join('')
}

export async function startScriptedFixture(script: Script): Promise<ScriptedFixture> {
  const requests: ScriptedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const streaming = (body as { stream?: unknown })?.stream === true
      const described = describeRequest(body, requests.length + 1)
      requests.push(described)
      let blocks: WireBlock[]
      try {
        blocks = script(described)
      } catch (err) {
        blocks = [{ type: 'text', text: `fixture script failed: ${err instanceof Error ? err.message : String(err)}` }]
      }
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonAnswer(described.n, model, blocks))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(sseAnswer(described.n, model, blocks))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export function seedScratchHome(runHome: string, cwd: string): void {
  rmSync(runHome, { recursive: true, force: true })
  mkdirSync(runHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(runHome, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [configKeyOf(cwd)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(runHome, 'settings.json'), '{}')
}

export type ScriptedTurn = { result: Record<string, unknown> | null; stderr: string; exitCode: number | null }

export async function runScriptedTurn(args: { runHome: string; cwd: string; base: string; ask: string; timeoutMs?: number; extraEnv?: Record<string, string>; extraArgv?: string[] }): Promise<ScriptedTurn> {
  seedScratchHome(args.runHome, args.cwd)
  const port = Number(new URL(args.base).port)
  const runner = bootRunner({ cwd: args.cwd, env: { ...childEnv(args.runHome, port), ...(args.extraEnv ?? {}) }, ...(args.extraArgv ? { extraArgv: args.extraArgv } : {}) })
  runner.send(user(args.ask, randomUUID()))
  const result = await runner.waitFor('result', isResult, bound(args.timeoutMs ?? 90_000))
  await runner.stop(bound(5_000))
  return { result, stderr: runner.stderr(), exitCode: await runner.exited }
}
