// ============================================================================
//  scripts/agent-experience/lib/fixture.ts — the benchmark's loopback model.
//
//  ONE node:http server, four provider lanes, content-routed and stateless:
//    POST …/v1/messages                        → the Anthropic family
//    POST /openai/v1/responses                 → the OpenAI Responses family
//    POST /zai/v4/chat/completions             → chat-completions (Z.AI)
//    POST /openrouter/api/v1/chat/completions  → chat-completions (OpenRouter carrier)
//  plus the discovery GETs each lane makes at boot and the fixture web page
//  the Browser task drives (GET /fixture.html).
//
//  Routing law: the conversation OPENER (its first user message) names the
//  script — `[ax:<task>]` for a main seat, `[ax-seat:<seat>]` for a
//  subagent — and the number of tool results already delivered is the step
//  clock. A request with no tools, or a forced tool choice, or no marker is a
//  side query (title, classifier, summary) and gets a harmless final text.
//  Every request is captured (lane · family · kind · step · body) so the
//  scorer can read the prompt size, the tool roster, and the seat requests.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { FIXTURE_PAGE_HTML } from './project.ts'
import {
  encode,
  hasForcedToolChoice,
  refusedCallCount,
  toolResultCount,
  userTexts,
  type Dialect,
  type ScriptedTurn,
} from './wire.ts'

export type FamilyId = 'anthropic' | 'openai' | 'chat' | 'openrouter'

export interface FamilySpec {
  id: FamilyId
  dialect: Dialect
  model: string
  backend: string
  label: string
}

export const FAMILIES: Record<FamilyId, FamilySpec> = {
  anthropic: { id: 'anthropic', dialect: 'anthropic', model: 'claude-opus-4-8', backend: 'anthropic-messages', label: 'Anthropic Messages' },
  openai: { id: 'openai', dialect: 'responses', model: 'gpt-5.5', backend: 'openai-responses', label: 'OpenAI Responses' },
  chat: { id: 'chat', dialect: 'chat', model: 'glm-5.3', backend: 'zai-glm', label: 'chat-completions (Z.AI)' },
  openrouter: { id: 'openrouter', dialect: 'chat', model: 'openrouter/stealth/ox-alpha', backend: 'openrouter-chat', label: 'chat-completions (OpenRouter carrier)' },
}

export const MECHANICAL_FAMILIES: FamilyId[] = ['anthropic', 'openai', 'chat', 'openrouter']

export interface FixtureHit {
  family: FamilyId | null
  dialect: Dialect | null
  kind: 'main' | 'seat' | 'side' | 'other'
  method: string
  path: string
  model: string
  taskId?: string
  seatId?: string
  step?: number
  results?: number
  body: Record<string, unknown>
  raw: string
  at: number
}

export interface ScriptBook {
  main: Map<string, ScriptedTurn[]>
  seats: Map<string, ScriptedTurn[]>
}

export interface BenchmarkFixture {
  base: string
  port: number
  pageUrl: string
  hits: FixtureHit[]
  /** Bind (or rebind) a family's task script; seats are per family too. */
  setScript(family: FamilyId, taskId: string, turns: ScriptedTurn[]): void
  setSeat(family: FamilyId, seatId: string, turns: ScriptedTurn[]): void
  clearFamily(family: FamilyId): void
  /** The env for ONE family's leg: every family's base URL pinned at this
   *  fixture (so no boot probe leaves the machine), but only THIS family's
   *  credential — the shape an operator signed into one provider has (a
   *  subagent that resolves onto another family's wire must fail here the
   *  way it fails for them). */
  envFor(family: FamilyId, mode?: 'pinned' | 'bare'): Record<string, string>
  close(): Promise<void>
}

const MAIN_MARKER = /\[ax:([a-z0-9-]+)\]/
const SEAT_MARKER = /\[ax-seat:([a-z0-9-]+)\]/

/** The step for a results count: the first step whose cumulative call count
 *  equals the results delivered. A final consumes nothing, so a replayed
 *  request (a continuation, a retry) re-derives the same answer. A count no
 *  step matches is a mismatch — the text says so, loudly, in the transcript. */
export function pickTurn(script: ScriptedTurn[], results: number): ScriptedTurn {
  let cum = 0
  for (const step of script) {
    if (cum === results) return step
    if ('calls' in step) cum += step.calls.length
  }
  if (cum === results) {
    const last = script[script.length - 1]
    if (last && 'final' in last) return last
  }
  return { final: `ax-mismatch: ${results} tool results delivered, no scripted step at that count (script ends at ${cum}).` }
}

function familyOf(path: string): { family: FamilyId; dialect: Dialect } | null {
  if (path === '/openai/v1/responses') return { family: 'openai', dialect: 'responses' }
  if (path === '/zai/v4/chat/completions') return { family: 'chat', dialect: 'chat' }
  if (path === '/openrouter/api/v1/chat/completions') return { family: 'openrouter', dialect: 'chat' }
  if (path.endsWith('/v1/messages')) return { family: 'anthropic', dialect: 'anthropic' }
  return null
}

export async function startBenchmarkFixture(opts: { port: number }): Promise<BenchmarkFixture> {
  const hits: FixtureHit[] = []
  const books = new Map<FamilyId, ScriptBook>()
  const bookFor = (family: FamilyId): ScriptBook => {
    let book = books.get(family)
    if (!book) {
      book = { main: new Map(), seats: new Map() }
      books.set(family, book)
    }
    return book
  }

  const openrouterModels = {
    data: [
      {
        id: 'stealth/ox-alpha',
        canonical_slug: 'stealth/ox-alpha',
        name: 'Ox Alpha',
        created: 1_756_000_000,
        description: 'fixture row',
        context_length: 1_048_576,
        architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        top_provider: { context_length: 1_048_576, max_completion_tokens: 32_768, is_moderated: false },
        supported_parameters: ['tools', 'tool_choice', 'max_tokens', 'temperature', 'reasoning', 'include_reasoning', 'response_format'],
      },
    ],
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      const method = req.method ?? ''
      if (method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      if (method === 'GET') {
        if (path === '/fixture.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(FIXTURE_PAGE_HTML)
          return
        }
        if (path === '/openai/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-5.5',
                  display_name: 'GPT-5.5',
                  supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
                  default_reasoning_level: 'high',
                  visibility: 'list',
                  priority: 1,
                  context_window: 272_000,
                  input_modalities: ['text'],
                  supported_in_api: true,
                },
              ],
            }),
          )
          return
        }
        if (path === '/openrouter/api/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(openrouterModels))
          return
        }
        if (path === '/openrouter/api/v1/key') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: { label: 'fixture', usage: 0, limit: null, is_free_tier: true, rate_limit: { requests: 200, interval: '10s' } } }))
          return
        }
        hits.push({ family: null, dialect: null, kind: 'other', method, path, model: '', body, raw, at: Date.now() })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
        return
      }
      const lane = method === 'POST' ? familyOf(path) : null
      if (!lane) {
        hits.push({ family: null, dialect: null, kind: 'other', method, path, model: '', body, raw, at: Date.now() })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const { family, dialect } = lane
      const model = String(body.model ?? '')
      // The markers ride USER texts only (a main conversation quotes seat
      // markers inside assistant tool inputs, never in a user message). The
      // wires differ in where the prompt sits — the Responses and chat wires
      // open with a system-reminder user message and carry the prompt in
      // the second — so every user text is scanned: a seat marker names a
      // seat conversation; otherwise the NEWEST task marker names the task
      // (a resumed conversation opens with phase 1's prompt and asks phase
      // 2's).
      const texts = userTexts(body, dialect)
      let seat: string | undefined
      let task: string | undefined
      for (const text of texts) {
        const s = SEAT_MARKER.exec(text)
        if (s && seat === undefined) seat = s[1]
        const m = MAIN_MARKER.exec(text)
        if (m) task = m[1]
      }
      if (seat !== undefined) task = undefined
      const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
      const side = tools.length === 0 || hasForcedToolChoice(body) || (seat === undefined && task === undefined)
      // The step clock: delivered results plus calls the harness refused
      // before execution (each refusal is a round the script has passed).
      const results = toolResultCount(body, dialect) + refusedCallCount(body, dialect)
      let turn: ScriptedTurn
      let kind: FixtureHit['kind']
      if (side) {
        kind = 'side'
        turn = { final: 'ax-side: ok.' }
      } else if (seat !== undefined) {
        kind = 'seat'
        const script = bookFor(family).seats.get(seat)
        turn = script ? pickTurn(script, results) : { final: `ax-unknown-seat: ${seat}` }
      } else {
        kind = 'main'
        const script = bookFor(family).main.get(task!)
        turn = script ? pickTurn(script, results) : { final: `ax-unknown-task: ${task}` }
      }
      hits.push({ family, dialect, kind, method, path, model, taskId: task, seatId: seat, results, body, raw, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.end(encode(dialect, turn))
    })
  })
  await new Promise<void>(resolve => server.listen(opts.port, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${opts.port}`
  return {
    base,
    port: opts.port,
    pageUrl: `${base}/fixture.html`,
    hits,
    setScript: (family, taskId, turns) => {
      bookFor(family).main.set(taskId, turns)
    },
    setSeat: (family, seatId, turns) => {
      bookFor(family).seats.set(seatId, turns)
    },
    clearFamily: family => {
      books.delete(family)
    },
    envFor: (family, mode = 'pinned') => {
      const bases: Record<FamilyId, Record<string, string>> = {
        anthropic: { ANTHROPIC_BASE_URL: base },
        openai: { MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`, MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth` },
        chat: { MERCURY_ZAI_API_BASE: `${base}/zai/v4` },
        openrouter: { MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`, MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth` },
      }
      const credentials: Record<FamilyId, Record<string, string>> = {
        anthropic: { ANTHROPIC_API_KEY: 'fixture-key-000' },
        openai: { OPENAI_API_KEY: 'fixture-openai-key' },
        chat: { ZAI_API_KEY: 'fixture-zai-key' },
        openrouter: { OPENROUTER_API_KEY: 'fixture-openrouter-key' },
      }
      // 'pinned' (default): every family's base URL at the fixture so no
      // boot probe leaves the machine. 'bare': only this family's base — the
      // literal shape of an operator signed into one provider, where a
      // dispatch that resolves onto another family's wire has NO base pin
      // to hide behind.
      const pins = mode === 'bare' ? bases[family] : Object.assign({}, ...Object.values(bases))
      return { ...pins, ...credentials[family] }
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
