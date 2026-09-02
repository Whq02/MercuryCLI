// ============================================================================
//  scripts/compact/foldFamiliesFixture.ts — the compact suite's own loopback
//  for the SIX chat-completions families the shared three-dialect fixture
//  does not serve: moonshot · deepseek · gemini · huggingface · openai-compat
//  · local. One server, path-routed lanes, every POST captured with its lane
//  (the shared fixture's capture discipline). Suite-local by design: its env
//  block plants credentials for families other suites deliberately probe
//  keyless, so it must never leak into the shared lib.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type FoldFamilyLane = 'moonshot' | 'deepseek' | 'gemini' | 'huggingface' | 'openai-compat' | 'local' | 'other'

export interface FoldFamilyHit {
  lane: FoldFamilyLane
  path: string
  model: string
  body: Record<string, unknown>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** chat-completions SSE: one assistant text, usage, DONE. */
function chatFinal(text: string): string {
  return [
    sse({ id: 'chat_ff', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    sse({ id: 'chat_ff', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ].join('')
}

const LANE_BY_PATH: ReadonlyArray<{ prefix: string; lane: FoldFamilyLane }> = [
  { prefix: '/moonshot/', lane: 'moonshot' },
  { prefix: '/deepseek/', lane: 'deepseek' },
  { prefix: '/gemini/', lane: 'gemini' },
  { prefix: '/hf/', lane: 'huggingface' },
  { prefix: '/compat/', lane: 'openai-compat' },
  { prefix: '/local/', lane: 'local' },
]

export interface FoldFamiliesFixture {
  base: string
  captured: FoldFamilyHit[]
  /** The env pins for the six lanes — credentials AND base overrides. */
  env: Record<string, string>
  close(): Promise<void>
}

export async function startFoldFamiliesFixture(opts: { port: number }): Promise<FoldFamiliesFixture> {
  const captured: FoldFamilyHit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      const lane = LANE_BY_PATH.find(entry => path.startsWith(entry.prefix))?.lane ?? 'other'
      if (req.method === 'GET') {
        // Discovery answers. The LOCAL lane is shape-strict: the sniffer
        // classifies a server by which endpoints answer, so a generic 200
        // on /api/version would dress this lane as an empty Ollama — only
        // the openai-compatible /v1/models listing answers; every other
        // local GET is an honest 404.
        if (lane === 'local') {
          if (path === '/local/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'census-local-model', owned_by: 'vllm' }] }))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
        return
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        captured.push({ lane, path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chatFinal(`${lane}-census body.`))
        return
      }
      captured.push({ lane: 'other', path: `${req.method} ${path}`, model: '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(opts.port, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${opts.port}`
  const env: Record<string, string> = {
    MOONSHOT_API_KEY: 'fixture-moonshot-key',
    MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
    GEMINI_API_KEY: 'fixture-gemini-key',
    MERCURY_GEMINI_API_BASE: `${base}/gemini`,
    HF_TOKEN: 'fixture-hf-token',
    MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
    MERCURY_COMPAT_BASE_URL: `${base}/compat/v1`,
    MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
    MERCURY_COMPAT_MODELS: 'census-endpoint-model',
    MERCURY_LOCAL_BASE_URL: `${base}/local`,
  }
  return {
    base,
    captured,
    env,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
