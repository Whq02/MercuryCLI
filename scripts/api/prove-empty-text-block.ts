#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { bootRunner } from '../daemon/dupline-world.ts'
import { bound, childEnv, findTranscripts, isResult, makeTally, requireDist, runTurn, scratchWorld, seedScratchHome, startScriptedFixture, user, type Script } from '../lib/scratchSeat.ts'

requireDist()
const tally = makeTally('prove-empty-text-block')
type Rec = Record<string, unknown>

tally.section('turn 1: a tool-using assistant turn is recorded')
const { runHome, cwd } = scratchWorld('empty-text-block')
seedScratchHome(runHome, cwd)
const script: Script = req => (req.step === 0 ? [{ type: 'tool_use', name: 'Bash', input: { command: 'true', description: 'a true' } }] : [{ type: 'text', text: 'first done' }])
const fixture = await startScriptedFixture(script)
const first = await runTurn({ runHome, cwd, base: fixture.base, ask: 'empty block probe first' })
await fixture.close()
const sid = String(first.result?.session_id ?? '')
const path = findTranscripts(runHome)[0]
tally.check('turn 1 settled and wrote a transcript', first.result?.subtype === 'success' && path !== undefined)

tally.section('the transcript now holds an assistant turn with an empty text block beside its tool_use')
const lines = readFileSync(path!, 'utf8').split('\n').filter(l => l.trim() !== '')
let patched = 0
const rewritten = lines.map(line => {
  const rec = JSON.parse(line) as Rec
  const payload = rec.payload as Rec | undefined
  if (payload?.kind !== 'output' || !Array.isArray(payload.content)) return line
  if (!(payload.content as Rec[]).some(b => b.kind === 'tool-use')) return line
  patched++
  return JSON.stringify({ ...rec, payload: { ...payload, content: [{ kind: 'text', text: '', citations: null }, ...(payload.content as Rec[])] } })
})
writeFileSync(path!, rewritten.join('\n') + '\n')
tally.check('the tool-using output record was rewritten with a leading empty text block', patched > 0, `${patched} line(s)`)

tally.section('turn 2: the resumed session\'s next request must not carry the empty text block')
const bodies: Rec[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    if (req.method !== 'POST' || !(req.url ?? '').split('?')[0]!.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Rec = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rec } catch {}
    bodies.push(body)
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const n = bodies.length
    const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `msg_r_${n}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'second done' }], stop_reason: 'end_turn', stop_sequence: null, usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_r_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}` +
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}` +
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second done' } })}` +
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}` +
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}` +
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
    )
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const runner = bootRunner({ cwd, env: childEnv(runHome, port), extraArgv: ['--resume', sid] })
runner.send(user('empty block probe second', randomUUID()))
const second = await runner.waitFor('result', isResult, bound(90_000))
await runner.stop(bound(5_000))
server.close()
tally.check('turn 2 settled in the same session', second !== null && (second as Rec).session_id === sid, JSON.stringify(second).slice(0, 120))
const items = (bodies[0]?.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
const offending = items.filter(
  m => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Rec[]).some(b => b.type === 'text' && b.text === '') && (m.content as Rec[]).some(b => b.type === 'tool_use'),
)
console.log(`  requests captured: ${bodies.length} · assistant items: ${items.filter(m => m.role === 'assistant').length} · with an empty text block beside a tool_use: ${offending.length}`)
tally.check('no assistant item on the wire carries an empty text block (the live API refuses "text content blocks must be non-empty")', bodies.length > 0 && offending.length === 0)
tally.finish()
