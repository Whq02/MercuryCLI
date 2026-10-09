import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'

export const LEAD_ASK = 'crew-look: launch the crew'
export const LEAD_DONE = 'crew-look: the crew is out.'
export const CREW_NAMES = ['atlas', 'fjord', 'harbour'] as const
export type CrewName = (typeof CREW_NAMES)[number]
export const MATE_TAG = 'crew-look-mate'
export const SLEEP_SECONDS = 287
export const HARBOUR_SLEEP_SECONDS = 24
export const TABLE = 'atlas.tsv'
export const WIDE = 'atlas-wide.txt'
export const LONG_LINE_A = 'atlas: one line that never breaks on its own — the ledger of every seam the lane walked, the frame it filed, the count it pinned, the words it kept and the border it did not cross, written out as one sentence so the transcript has to wrap it inside the view and never past it, and then a little more so it wraps twice at the widest tier too.'
export const LONG_LINE_F = 'fjord: the second crewmate says one long thing too — a wide unbroken line of prose that carries its own weight across the whole width of the centre and past it, so the view has to fold it under its nameplate without losing a character or painting one past the border of the view.'
export const HARBOUR_DONE = `${MATE_TAG} harbour: finished — its turn ended while it was on screen`
export const ATLAS_HOLD = 'atlas: holding the line for the view'
export const ATLAS_LEDGER = [ATLAS_HOLD, ...Array.from({ length: 80 }, (_, i) => `ledger row ${String(i + 1).padStart(2, '0')} — a row of the crewmate's own transcript, tall enough that the view has to scroll`)].join('\n')
export const HARBOUR_OPEN = 'harbour: a short run, then the turn ends'
export const WIDE_ROW = (n: number): string => `wide-${n} ` + Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, '0')}=${String(n * 31 + i).padStart(4, '0')}`).join(' ')
export const TABLE_BEFORE = ['name\tid\tstage\tnote', 'harbour\tq7\tstage two\theld on the tree, uncommitted, pending the ruling; the options are listed on the shared page beside the second commit', 'lantern\tp3\tstage one\theld'].join('\n') + '\n'
export const TABLE_AFTER = ['name\tid\tstage\tnote', 'harbour\tq7\tstage two\tfolded on the tree, committed after the ruling; the options are listed on the shared page beside the second commit', 'lantern\tp3\tstage one\tfolded'].join('\n') + '\n'
export const WIDE_TEXT = [WIDE_ROW(1), WIDE_ROW(2), WIDE_ROW(3)].join('\n') + '\n'

export type Route = 'lead' | 'lead-ack' | 'mate' | 'mate-ack' | 'side'
export type Hit = { route: Route; mate: CrewName | null; model: string; ask: string; at: number; step: number }
export type Fixture = { base: string; port: number; hits: Hit[]; close: () => Promise<void> }

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

function offersAgent(body: unknown): boolean {
  const tools = (body as { tools?: unknown[] })?.tools
  return Array.isArray(tools) && tools.some(t => String((t as { name?: string })?.name ?? '') === 'Agent')
}

export function routeOf(body: unknown): { route: Route; mate: CrewName | null; ask: string; step: number } {
  const ask = askOf(body)
  const ack = isToolResultItem(itemsOf(body)[itemsOf(body).length - 1])
  const step = stepOf(body)
  const mate = CREW_NAMES.find(name => ask.includes(`${MATE_TAG} ${name}:`)) ?? null
  if (mate !== null) return { route: ack ? 'mate-ack' : 'mate', mate, ask, step }
  if (offersAgent(body) && ask.includes(LEAD_ASK)) return { route: ack ? 'lead-ack' : 'lead', mate: null, ask, step }
  return { route: 'side', mate: null, ask, step }
}

function answer(model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    sse('message_start', { type: 'message_start', message: { id: `msg_crewlook_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
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
        sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_crewlook_${Date.now() % 100000}_${index}`, name: block.name, input: {} } }),
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

const matePrompt = (name: CrewName): string => `${MATE_TAG} ${name}: run your part of the look drive`
const launch = (name: CrewName): Block => ({ type: 'tool_use', name: 'Agent', input: { description: name, prompt: matePrompt(name), subagent_type: 'mercury-crew', run_in_background: true } })

export function blocksFor(route: Route, mate: CrewName | null, step: number, cwd: string): { blocks: Block[]; usage: { input: number; output: number } } {
  const usageOf = (name: CrewName | null): { input: number; output: number } => (name === 'atlas' ? { input: 900, output: 40 } : name === 'fjord' ? { input: 800, output: 40 } : name === 'harbour' ? { input: 700, output: 40 } : { input: 1200, output: 80 })
  switch (route) {
    case 'lead':
    case 'lead-ack': {
      if (step === 0) return { blocks: [{ type: 'text', text: 'launching the crew — three crewmates, one after another' }, launch('atlas')], usage: usageOf(null) }
      if (step === 1) return { blocks: [launch('fjord')], usage: usageOf(null) }
      if (step === 2) return { blocks: [launch('harbour')], usage: usageOf(null) }
      return { blocks: [{ type: 'text', text: LEAD_DONE }], usage: { input: 1500, output: 30 } }
    }
    case 'mate':
    case 'mate-ack': {
      const usage = usageOf(mate)
      if (mate === 'atlas') {
        if (step === 0) return { blocks: [{ type: 'text', text: LONG_LINE_A }, { type: 'tool_use', name: 'Read', input: { file_path: join(cwd, TABLE) } }], usage }
        if (step === 1) return { blocks: [{ type: 'tool_use', name: 'Write', input: { file_path: join(cwd, TABLE), content: TABLE_AFTER } }], usage }
        if (step === 2) return { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `cat ${WIDE}`, description: 'the wide table' } }], usage }
        if (step === 3) return { blocks: [{ type: 'text', text: ATLAS_LEDGER }, { type: 'tool_use', name: 'Sleep', input: { seconds: SLEEP_SECONDS } }], usage }
        return { blocks: [{ type: 'text', text: `${MATE_TAG} atlas: done` }], usage }
      }
      if (mate === 'fjord') {
        if (step === 0) return { blocks: [{ type: 'text', text: LONG_LINE_F }, { type: 'tool_use', name: 'Sleep', input: { seconds: SLEEP_SECONDS } }], usage }
        return { blocks: [{ type: 'text', text: `${MATE_TAG} fjord: done` }], usage }
      }
      if (step === 0) return { blocks: [{ type: 'text', text: HARBOUR_OPEN }, { type: 'tool_use', name: 'Sleep', input: { seconds: HARBOUR_SLEEP_SECONDS } }], usage }
      return { blocks: [{ type: 'text', text: HARBOUR_DONE }], usage }
    }
    default:
      return { blocks: [{ type: 'text', text: 'ok' }], usage: { input: 20, output: 2 } }
  }
}

export async function startCrewLookFixture(opts: { port?: number; cwd: string }): Promise<Fixture> {
  const hits: Hit[] = []
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
      const { route, mate, ask, step } = routeOf(body)
      hits.push({ route, mate, model, ask: ask.trim().slice(0, 160), at: Date.now(), step })
      const { blocks, usage } = blocksFor(route, mate, step, opts.cwd)
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
