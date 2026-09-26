#!/usr/bin/env bun
import { createServer } from 'node:http'

const delayMs = Number(process.argv[2] ?? '1500')
const growAfterRequests = Number(process.argv[3] ?? '0')
let requests = 0

const GROWN = { id: 'nvidia/nemotron-3-ultra:free', name: 'NVIDIA: Nemotron 3 Ultra (free)', context_length: 1_000_000 }

const MODELS = [
  { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', context_length: 1_000_000 },
  { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', context_length: 1_050_000 },
  { id: 'google/gemini-3.1-pro', name: 'Google: Gemini 3.1 Pro', context_length: 2_000_000 },
  { id: 'deepseek/deepseek-v4', name: 'DeepSeek: DeepSeek V4', context_length: 256_000 },
  { id: 'meta-llama/llama-5-405b-instruct', name: 'Meta: Llama 5 405B Instruct', context_length: 131_072 },
].map(m => ({
  ...m,
  pricing: { prompt: '0.000001', completion: '0.000002' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
}))

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url ?? '').startsWith('/api/v1/models')) {
    requests += 1
    const grown = growAfterRequests > 0 && requests > growAfterRequests
    const data = grown ? [...MODELS, { ...GROWN, pricing: MODELS[0]!.pricing, architecture: MODELS[0]!.architecture }] : MODELS
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data, total_count: data.length, links: { next: null } }))
    }, delayMs)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${req.url}` } }))
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
