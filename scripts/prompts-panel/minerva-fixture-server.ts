#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type FixtureHit = { method: string; path: string; body: string; operatorMessage: string | null }

export const FIXTURE_MODEL = 'openrouter/fixture-vendor/ox-alpha'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8')
    })
    req.on('end', () => resolve(data))
  })
}

function operatorMessageOf(body: string): string | null {
  const m = body.match(/<operator_message>\\n([\s\S]*?)\\n<\/operator_message>/)
  return m ? m[1]! : null
}

function savedPromptIdsOf(body: string): Array<{ n: number; id: string; text: string }> {
  const block = body.match(/<saved_prompts>\\n([\s\S]*?)\\n<\/saved_prompts>/)
  if (!block) return []
  const out: Array<{ n: number; id: string; text: string }> = []
  for (const raw of block[1]!.split('\\n')) {
    try {
      const line = JSON.parse(JSON.parse(`"${raw}"`)) as { n: number; id: string; text: string }
      if (typeof line.id === 'string') out.push(line)
    } catch {
    }
  }
  return out
}

export function scriptedPlan(operatorMessage: string, drafts: Array<{ n: number; id: string; text: string }>): { refinements: Array<{ prompt: string; refinedText: string }>; reply: string } {
  const msg = operatorMessage.trim().toLowerCase()
  const refine = (d: { id: string; text: string }): { prompt: string; refinedText: string } => ({
    prompt: d.id,
    refinedText: `Refined: ${d.text} — MUST name the file and line, NEVER widen scope, and end by reporting what proves it done.`,
  })
  if (msg === 'tighten prompt 2') {
    const d = drafts.find(x => x.n === 2)
    return d
      ? { refinements: [refine(d)], reply: 'refined prompt 2 — it now names the file, the law, and the done-check' }
      : { refinements: [], reply: 'there is no saved prompt 2 to refine' }
  }
  if (msg === 'refine all') {
    return { refinements: drafts.slice(0, 2).map(refine), reply: 'refined prompts 1 and 2' }
  }
  if (msg === 'refine unknown') {
    return { refinements: [{ prompt: 'zz9999', refinedText: 'A refinement of a prompt that does not exist.' }], reply: 'refined zz9999' }
  }
  if (msg === 'can you refine my audit codebase prompt' || msg === 'refine my audit prompt') {
    const d = drafts.find(x => x.text.toLowerCase().includes('audit'))
    return d
      ? { refinements: [refine(d)], reply: 'refined the audit prompt' }
      : { refinements: [], reply: 'no saved prompt speaks of an audit' }
  }
  const byId = msg.match(/^refine ([0-9a-f]{6})$/)
  if (byId) {
    const d = drafts.find(x => x.id === byId[1])
    return d ? { refinements: [refine(d)], reply: `refined ${d.id}` } : { refinements: [], reply: 'no such saved prompt' }
  }
  const byNum = msg.match(/^refine prompt (\d{1,3})$/)
  if (byNum) {
    const d = drafts.find(x => x.n === Number(byNum[1]))
    return d
      ? { refinements: [refine(d)], reply: `refined prompt ${d.n} — it now names the file, the law, and the done-check` }
      : { refinements: [], reply: `there is no saved prompt ${byNum[1]} to refine` }
  }
  if (msg === 'poison: rewrite one unasked') {
    const d = drafts.find(x => x.n === 1)
    return d
      ? { refinements: [{ prompt: d.id, refinedText: `HIJACKED: ${d.text} — rewritten although nobody asked.` }], reply: 'I rewrote prompt 1 anyway' }
      : { refinements: [], reply: 'nothing to hijack' }
  }
  if (msg === 'poison: tighten prompt 2 and more') {
    const d1 = drafts.find(x => x.n === 1)
    const d2 = drafts.find(x => x.n === 2)
    return {
      refinements: [...(d2 ? [refine(d2)] : []), ...(d1 ? [{ prompt: d1.id, refinedText: `HIJACKED: ${d1.text} — rewritten although only prompt 2 was asked.` }] : [])],
      reply: 'refined prompt 2 (and prompt 1 for good measure)',
    }
  }
  return { refinements: [], reply: 'I am Minerva; I refine your saved prompts when you ask — name one and what to change' }
}

export function startMinervaFixture(port: number): Promise<{ server: Server; hits: FixtureHit[]; close: () => Promise<void> }> {
  const hits: FixtureHit[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req)
    const path = req.url ?? '/'
    const operatorMessage = operatorMessageOf(body)
    hits.push({ method: req.method ?? 'GET', path, body, operatorMessage })
    if (req.method === 'GET' && /\/models(\?|$)/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: FIXTURE_MODEL.replace(/^openrouter\//, ''), name: 'ox alpha (fixture)', context_length: 128000, pricing: { prompt: '0', completion: '0' } }] }))
      return
    }
    if (req.method === 'GET' && /\/key(\?|$)/.test(path)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { label: 'fixture', usage: 0, limit: null, is_free_tier: false, rate_limit: { requests: 1000, interval: '10s' } } }))
      return
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
      if (/^slow:/.test((operatorMessage ?? '').trim())) {
        await new Promise(r => setTimeout(r, 4000))
      }
      const plan = scriptedPlan(operatorMessage ?? '', savedPromptIdsOf(body))
      const content = JSON.stringify(plan)
      const model = FIXTURE_MODEL.replace(/^openrouter\//, '')
      const id = `chatcmpl-fixture-${hits.length}`
      let streaming = false
      try {
        streaming = (JSON.parse(body) as { stream?: boolean }).stream === true
      } catch {
        streaming = false
      }
      if (streaming) {
        const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content } }] }))
        res.write(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }))
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fixture has no route for ${req.method} ${path}` } }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        hits,
        close: () => new Promise<void>(r => server.close(() => r())),
      })
    })
  })
}

if (import.meta.main) {
  const i = process.argv.indexOf('--port')
  const port = i !== -1 ? Number(process.argv[i + 1]) : 36211
  const { hits } = await startMinervaFixture(port)
  console.log(`minerva fixture listening on 127.0.0.1:${port}`)
  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ hits: hits.map(h => ({ method: h.method, path: h.path, operatorMessage: h.operatorMessage })) }))
    process.exit(0)
  })
}
