import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export const LEAD_ASK_MATE = 'crew-stop: spawn the ping mate'
export const LEAD_ASK_SLEEPER = 'crew-stop: launch the sleeper'
export const LEAD_ASK_HELD = 'crew-stop: hold on the sleeper'
export const LEAD_DONE = 'crew-stop: done.'
export const MATE_NAME = 'sonnet-ping'
export const MATE_TEAM = 'ping-team'
export const MATE_PROMPT = 'crew-mate: reply with the word ping and nothing else'
export const MATE_REPLY = 'ping'
export const SEAT_NAME = 'sleeper'
export const SEAT_PROMPT = 'crew-seat: run the long sleep'
export const SEAT_SLEEP_SECONDS = 287
export const SEAT_ACK = 'crew-seat: the sleep ended'
export const SIDE_REPLY = 'ok'

export type Route = 'lead' | 'lead-ack' | 'mate' | 'mate-ack' | 'seat' | 'seat-ack' | 'side'
export type Hit = { route: Route; model: string; ask: string; at: number; toolNames: string[]; step: number }
export type Fixture = { base: string; port: number; hits: Hit[]; close: () => Promise<void> }
export type SeatTool = 'bash' | 'sleep'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
type Item = { role?: string; content?: unknown }

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`

function itemsOf(body: unknown): Item[] {
  const b = body as { messages?: unknown }
  return Array.isArray(b?.messages) ? (b.messages as Item[]) : []
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) text += `\n${part.text}`
  }
  return text
}

function askOf(body: unknown): string {
  const items = itemsOf(body)
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const text = textOf(item.content)
    if (text.trim() !== '') return text
  }
  return ''
}

function isToolResultItem(item: Item | undefined): boolean {
  return item?.role === 'user' && Array.isArray(item.content) && (item.content as Array<{ type?: string }>).some(b => b.type === 'tool_result')
}

function lastIsToolResult(body: unknown): boolean {
  const items = itemsOf(body)
  return isToolResultItem(items[items.length - 1])
}

export function stepOf(body: unknown): number {
  const items = itemsOf(body)
  let askAt = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role === 'user' && textOf(item.content).trim() !== '') {
      askAt = i
      break
    }
  }
  return items.slice(askAt + 1).filter(isToolResultItem).length
}

function toolNamesOf(body: unknown): string[] {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) ? tools.map(t => String((t as { name?: string })?.name ?? '')) : []
}

export function routeOf(body: unknown): { route: Route; ask: string; step: number } {
  const ask = askOf(body)
  const ack = lastIsToolResult(body)
  const step = stepOf(body)
  const offersAgent = toolNamesOf(body).includes('Agent')
  if (ask.includes('crew-mate:')) return { route: ack ? 'mate-ack' : 'mate', ask, step }
  if (ask.includes('crew-seat:')) return { route: ack ? 'seat-ack' : 'seat', ask, step }
  if (offersAgent && ask.includes('crew-stop:')) {
    if (ask.includes(LEAD_ASK_MATE) && step === 1) return { route: 'lead', ask, step }
    return { route: ack ? 'lead-ack' : 'lead', ask, step }
  }
  return { route: 'side', ask, step }
}

function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    sse('message_start', { type: 'message_start', message: { id: `msg_crewstop_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }),
        sse('content_block_stop', { type: 'content_block_stop', index }),
      )
    } else {
      parts.push(
        sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_crewstop_${Date.now() % 100000}_${index}`, name: block.name, input: {} } }),
        sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }),
        sse('content_block_stop', { type: 'content_block_stop', index }),
      )
    }
  })
  parts.push(
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } }),
    sse('message_stop', { type: 'message_stop' }),
  )
  return parts.join('')
}

export function blocksFor(route: Route, ask: string, seatTool: SeatTool, step = 0): { blocks: Block[]; usage: { input: number; output: number } } {
  switch (route) {
    case 'lead': {
      if (ask.includes(LEAD_ASK_MATE)) {
        if (step === 0) {
          return {
            blocks: [
              { type: 'text', text: 'making the ping team' },
              { type: 'tool_use', name: 'TeamCreate', input: { team_name: MATE_TEAM, description: 'the ping team' } },
            ],
            usage: { input: 1100, output: 60 },
          }
        }
        return {
          blocks: [
            { type: 'text', text: 'spawning the ping mate' },
            { type: 'tool_use', name: 'Agent', input: { name: MATE_NAME, team_name: MATE_TEAM, description: MATE_NAME, prompt: MATE_PROMPT, subagent_type: 'mercury-general' } },
          ],
          usage: { input: 1200, output: 80 },
        }
      }
      const background = !ask.includes(LEAD_ASK_HELD)
      return {
        blocks: [
          { type: 'text', text: 'launching the sleeper' },
          { type: 'tool_use', name: 'Agent', input: { description: SEAT_NAME, prompt: SEAT_PROMPT, subagent_type: 'mercury-general', ...(background ? { run_in_background: true } : {}) } },
        ],
        usage: { input: 1200, output: 80 },
      }
    }
    case 'lead-ack':
      return { blocks: [{ type: 'text', text: LEAD_DONE }], usage: { input: 1500, output: 30 } }
    case 'mate':
      return { blocks: [{ type: 'text', text: MATE_REPLY }], usage: { input: 31_600, output: 5 } }
    case 'mate-ack':
      return { blocks: [{ type: 'text', text: MATE_REPLY }], usage: { input: 31_700, output: 5 } }
    case 'seat':
      return {
        blocks: [
          seatTool === 'bash'
            ? { type: 'tool_use', name: 'Bash', input: { command: `sleep ${SEAT_SLEEP_SECONDS}`, description: 'the long sleep' } }
            : { type: 'tool_use', name: 'Sleep', input: { seconds: SEAT_SLEEP_SECONDS } },
        ],
        usage: { input: 900, output: 40 },
      }
    case 'seat-ack':
      return { blocks: [{ type: 'text', text: SEAT_ACK }], usage: { input: 950, output: 30 } }
    default:
      return { blocks: [{ type: 'text', text: SIDE_REPLY }], usage: { input: 20, output: 2 } }
  }
}

export async function startCrewStopFixture(opts: { port?: number; seatTool?: SeatTool } = {}): Promise<Fixture> {
  const hits: Hit[] = []
  const seatTool = opts.seatTool ?? 'bash'
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const { route, ask, step } = routeOf(body)
      hits.push({ route, model, ask: ask.trim().slice(0, 160), at: Date.now(), toolNames: toolNamesOf(body), step })
      const { blocks, usage } = blocksFor(route, ask, seatTool, step)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks, usage))
    })
  })
  await new Promise<void>(resolve => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 0)
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
