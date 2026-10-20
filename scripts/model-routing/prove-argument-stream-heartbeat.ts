#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { streamOpenaiResponses } = await import(join(ROOT, 'src/services/providers/openai/openaiClient.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const sse = (res: ServerResponse, event: Record<string, unknown>): void => {
  res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
}
type Shape = 'arguments' | 'keepalive'
let shape: Shape = 'arguments'
const DELTAS = 14
const fixture = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    if (shape === 'keepalive') {
      for (let i = 0; i < 5; i++) {
        res.write(': keep-alive\n\n')
        await sleep(500)
      }
    }
    sse(res, { type: 'response.created', response: { id: 'resp_hb' } })
    sse(res, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_hb', call_id: 'call_hb', name: 'Write' } })
    if (shape === 'arguments') {
      for (let i = 0; i < DELTAS; i++) {
        sse(res, { type: 'response.function_call_arguments.delta', item_id: 'fc_hb', delta: i === 0 ? '{"text":"' : i === DELTAS - 1 ? 'end"}' : `part-${i}-` })
        await sleep(160)
      }
    }
    sse(res, { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_hb', name: 'Write', arguments: '{"text":"end"}', id: 'fc_hb' } })
    sse(res, { type: 'response.completed', response: { id: 'resp_hb', usage: { input_tokens: 10, output_tokens: 5 } } })
    res.end()
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

async function run(which: Shape): Promise<{ ticks: number[]; deltas: number; finished: boolean; elapsedMs: number }> {
  shape = which
  const ticks: number[] = []
  let deltas = 0
  let finished = false
  const t0 = Date.now()
  for await (const event of streamOpenaiResponses({
    baseUrl,
    headers: { authorization: 'Bearer fixture' },
    request: { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'write' }], store: false, stream: true } as never,
    onStreamActivity: (atMs: number) => ticks.push(atMs),
    idleTimeoutMs: 20_000,
  })) {
    if (event.type === 'tool-args-delta') deltas++
    if (event.type === 'finish') finished = true
  }
  return { ticks, deltas, finished, elapsedMs: Date.now() - t0 }
}

console.log('the heartbeat on the Responses road — the same rule as the Anthropic road')
try {
  const args = await run('arguments')
  check('a tool-argument stream paints every delta and settles', args.deltas === DELTAS && args.finished && args.elapsedMs >= 1_800, JSON.stringify({ deltas: args.deltas, finished: args.finished, elapsedMs: args.elapsedMs }))
  check('a painted argument delta is a decoded event: no heartbeat is minted while arguments stream (the deltas themselves are the life)', args.ticks.length === 0, `ticks=${args.ticks.length} over ${args.elapsedMs} ms`)
  const quiet = await run('keepalive')
  check('bytes that decode to nothing (keep-alive comments) still mint the heartbeat at most once a second', quiet.ticks.length >= 1 && quiet.ticks.length <= 4 && quiet.finished, `ticks=${quiet.ticks.length} over ${quiet.elapsedMs} ms`)
} finally {
  fixture.close()
}
console.log(failures === 0 ? '\n✅ prove-argument-stream-heartbeat: ALL PASS' : `\n❌ prove-argument-stream-heartbeat: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
