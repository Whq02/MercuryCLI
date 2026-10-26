import { createServer } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
const value = key => args[args.indexOf(key) + 1]
const capture = value('--capture')
if (!existsSync(value('--model')) || args.includes('--mmproj') && !existsSync(value('--mmproj'))) process.exit(2)
if (capture) appendFileSync(capture, JSON.stringify({ args }) + '\n')
if (args.includes('--fail')) process.exit(3)
const model = value('--alias')
const window = Number(value('--ctx-size'))
const server = createServer(async (req, res) => {
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
  if (req.url === '/health') return json({ status: 'ok' })
  if (req.url === '/v1/models') return json({ data: [{ id: model, meta: { n_ctx_train: 131072, size: 512 } }] })
  if (req.url === '/props') return json({ default_generation_settings: { n_ctx: window }, modalities: { vision: true } })
  if (req.url === '/models') return json({ data: [] })
  if (req.url === '/v1/chat/completions') {
    let body = ''
    for await (const chunk of req) body += chunk
    if (capture) appendFileSync(capture, JSON.stringify({ request: JSON.parse(body) }) + '\n')
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
    res.end(chunk({ role: 'assistant', content: 'ready' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')
    return
  }
  res.writeHead(404).end()
})
server.listen(Number(value('--port')), '127.0.0.1')
process.on('SIGTERM', () => { server.close(); process.exit(0) })
