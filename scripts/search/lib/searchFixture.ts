import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FixtureLane = 'anthropic' | 'openai' | 'openai-models' | 'ddg-html' | 'ddg-lite' | 'brave' | 'tavily' | 'other'
export interface SearchFixtureHit {
  lane: FixtureLane
  method: string
  path: string
  headers: Record<string, string>
  body: string
}
export type DoorMode = 'results' | 'anomaly' | 'poison' | 'entity-poison' | 'http-401' | 'http-500'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = [join(HERE, '..', 'fixtures'), join(HERE, 'fixtures')].find(p => existsSync(p)) ?? join(HERE, '..', 'fixtures')
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function anthropicSearchSse(query: string): string {
  const usage = { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx_search', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_fx_1', name: 'web_search', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fx_1', content: [{ type: 'web_search_result', title: 'Anthropic Fixture Hit', url: 'https://example.org/anthropic-hit', encrypted_content: 'fx', page_age: null }] } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 1 })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'fixture-native-commentary body.' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 2 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

function openaiSearchSse(query: string): string {
  const citation = { type: 'url_citation', url: 'https://example.org/openai-hit', title: 'OpenAI Fixture Hit', start_index: 0, end_index: 10 }
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx_search' } }),
    sse({ type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_fx_1', status: 'in_progress' } }),
    sse({ type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_fx_1', status: 'completed', action: { type: 'search', query } } }),
    sse({ type: 'response.output_text.delta', delta: 'gpt-native-commentary body.' }),
    sse({ type: 'response.output_text.annotation.added', annotation: citation }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'gpt-native-commentary body.', annotations: [citation] }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx_search', usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

export interface SearchFixture {
  base: string
  port: number
  hits: SearchFixtureHit[]
  modes: { ddgHtml: DoorMode; ddgLite: DoorMode; brave: DoorMode; tavily: DoorMode; openai: DoorMode }
  env: Record<string, string>
  hitsOn(lane: FixtureLane): SearchFixtureHit[]
  reset(): void
  close(): Promise<void>
}

export async function startSearchFixture(port: number): Promise<SearchFixture> {
  const hits: SearchFixtureHit[] = []
  const modes: SearchFixture['modes'] = { ddgHtml: 'results', ddgLite: 'results', brave: 'results', tavily: 'results', openai: 'results' }
  const page = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

  function laneOf(path: string): FixtureLane {
    if (path === '/v1/messages') return 'anthropic'
    if (path.startsWith('/api/web/domain_info')) return 'anthropic'
    if (path === '/openai/v1/responses') return 'openai'
    if (path === '/openai/v1/models') return 'openai-models'
    if (path.startsWith('/ddg/html')) return 'ddg-html'
    if (path.startsWith('/ddg/lite')) return 'ddg-lite'
    if (path.startsWith('/brave/')) return 'brave'
    if (path.startsWith('/tavily/')) return 'tavily'
    return 'other'
  }

  function answerDoor(res: ServerResponse, mode: DoorMode, kind: 'html' | 'lite' | 'brave' | 'tavily'): void {
    if (mode === 'http-401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized (fixture)' }))
      return
    }
    if (mode === 'http-500') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('fixture 500')
      return
    }
    if (kind === 'html' || kind === 'lite') {
      if (mode === 'anomaly') {
        res.writeHead(202, { 'content-type': 'text/html' })
        res.end(page(kind === 'html' ? 'ddg-html-anomaly-202.html' : 'ddg-lite-anomaly-202.html'))
        return
      }
      if (mode === 'poison') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body><div class="totally-new-shape"><a href="https://example.com/x">A link</a></div></body></html>')
        return
      }
      if (mode === 'entity-poison') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          kind === 'html'
            ? '<html><body><div id="links"><div class="result results_links"><a class="result__a" href="https://example.com/entity">poison &#x110000; title</a></div></div></body></html>'
            : "<html><body><table><tr><td><a class='result-link' href=\"https://example.com/entity\">poison &#x110000; title</a></td></tr></table></body></html>",
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(kind === 'html' ? 'ddg-html-results.html' : 'ddg-lite-results.html'))
      return
    }
    if (mode === 'poison') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ shape: 'never-seen' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(page(kind === 'brave' ? 'brave-web-search.json' : 'tavily-search.json'))
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const lane = laneOf(path)
      const body = Buffer.concat(chunks).toString('utf8')
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(',') : String(value ?? '')
      hits.push({ lane, method: req.method ?? '', path: req.url ?? '', headers, body })
      switch (lane) {
        case 'anthropic': {
          if (path.startsWith('/api/web/domain_info')) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ can_fetch: true }))
            return
          }
          let query = 'unknown'
          try {
            const text = JSON.stringify(JSON.parse(body))
            const match = /Perform a web search for the query: ([^"\\]*)/.exec(text)
            if (match?.[1]) query = match[1]
          } catch {
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(anthropicSearchSse(query))
          return
        }
        case 'openai': {
          if (modes.openai !== 'results') {
            answerDoor(res, modes.openai, 'brave')
            return
          }
          let query = 'unknown'
          const match = /Perform a web search for the query: ([^"\\]*)/.exec(body)
          if (match?.[1]) query = match[1]
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(openaiSearchSse(query))
          return
        }
        case 'openai-models': {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5', object: 'model' }] }))
          return
        }
        case 'ddg-html':
          answerDoor(res, modes.ddgHtml, 'html')
          return
        case 'ddg-lite':
          answerDoor(res, modes.ddgLite, 'lite')
          return
        case 'brave':
          answerDoor(res, modes.brave, 'brave')
          return
        case 'tavily':
          answerDoor(res, modes.tavily, 'tavily')
          return
        default:
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    port,
    hits,
    modes,
    env: {
      ANTHROPIC_BASE_URL: base,
      MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
      MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
      MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
      MERCURY_SEARCH_DDG_HTML_URL: `${base}/ddg/html/`,
      MERCURY_SEARCH_DDG_LITE_URL: `${base}/ddg/lite/`,
      MERCURY_SEARCH_BRAVE_URL: `${base}/brave/res/v1/web/search`,
      MERCURY_SEARCH_TAVILY_URL: `${base}/tavily/search`,
    },
    hitsOn: lane => hits.filter(hit => hit.lane === lane),
    reset: () => {
      hits.length = 0
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
