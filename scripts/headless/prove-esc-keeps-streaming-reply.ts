#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally } from '../daemon/dupline-world.ts'
import { HANDOFF_ASK_MARK } from '../lib/fixtureApi.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'esc-keeps-reply-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const tally = makeTally('prove-esc-keeps-streaming-reply')
type Frame = Record<string, unknown>
const ASK = 'write two paragraphs, slowly'
const FOLLOW_UP = 'are you still there'
const SETTLED = 'The first paragraph settled before the cut.'
const PARTIAL = 'The second paragraph was still streaming when the interrupt landed'
const MODEL = 'claude-fable-5-1'
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }

console.log('============================================================')
console.log(' a reply still streaming when the interrupt lands is kept: the words already on the wire mint as the assistant block, the interruption row follows')
console.log('============================================================')

if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  tally.finish()
}
console.log(`build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'esc-keeps-reply-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)

let streamed = 0
let hanging: ServerResponse | null = null
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const id = `msg_esc_${randomUUID().slice(0, 8)}`
    if (raw.includes(HANDOFF_ASK_MARK) || raw.includes(FOLLOW_UP)) {
      const words = raw.includes(FOLLOW_UP) ? 'still here' : 'The note for the next session.'
      if (!raw.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: words }], stop_reason: 'end_turn', stop_sequence: null, usage }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end([
        sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }),
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
        sse('message_stop', { type: 'message_stop' }),
      ].join(''))
      return
    }
    streamed++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SETTLED } }))
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PARTIAL } }))
    hanging = res
    req.on('close', () => {
      if (hanging === res) hanging = null
    })
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const runner = bootRunner({ cwd, env: childEnv(runHome, port), capabilities: { partial_rows: true } as never })
runner.proc.stdin?.on('error', () => {})
const textOf = (f: Frame): string => String(f.text ?? '')
const transcriptText = (): string => {
  const projects = join(runHome, 'projects')
  if (!existsSync(projects)) return ''
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl')) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(projects)
  return out.join('\n')
}
try {
  tally.section('§1 the seat on the built product: the interrupt lands while the second paragraph streams')
  void runner.prompt(ASK, randomUUID())
  const settledRow = await runner.waitFor('the settled paragraph as a text row', f => f.type === 'text' && textOf(f).includes(SETTLED), bound(60_000))
  tally.check('the first paragraph settled and painted as a text row (block 0)', settledRow !== null && settledRow.block === 0, JSON.stringify(settledRow).slice(0, 200))
  const partialDelta = await runner.waitFor('the partial words streaming as a delta row', f => f.type === 'text_delta' && textOf(f).includes(PARTIAL), bound(30_000))
  tally.check('the second paragraph was on the wire and consumed (a text_delta row carries it) before the interrupt — the product mark the interrupt waits on', partialDelta !== null && partialDelta.block === 1, JSON.stringify(partialDelta).slice(0, 200))
  const before = runner.frames.length
  void runner.request('turn/interrupt', { op_id: `esc-${randomUUID().slice(0, 8)}` }).catch(() => undefined)
  const outcome = await runner.waitFor('the interrupted turn\'s outcome', isOutcome, bound(30_000), before)
  tally.check('the turn closes on the interrupt', outcome !== null && outcome.status === 'interrupted', `outcome ${outcome === null ? 'none' : String(outcome.status)} · exit ${String(runner.proc.exitCode)}`)
  const partialRow = runner.frames.slice(before).find(f => f.type === 'text' && textOf(f).includes(PARTIAL))
  tally.check('red on the base: the words still streaming when the interrupt landed are minted as the assistant block (a text row, block 1) after the interrupt — nothing of the reply is lost', partialRow !== undefined && partialRow.block === 1, runner.frames.slice(before).map(f => `${String(f.type)}${f.type === 'text' ? `:${textOf(f).slice(0, 40)}` : ''}`).join(' · ').slice(0, 400))
  tally.check('nothing was re-requested: one streamed request on the wire', streamed === 1, `${streamed} streamed request(s)`)
  tally.check('the stream was released (the fixture saw its socket close)', hanging === null)

  const afterInterrupt = runner.frames.length
  void runner.prompt(FOLLOW_UP, randomUUID())
  const follow = await runner.waitFor('the follow-up outcome', f => isOutcome(f), bound(60_000), afterInterrupt)
  tally.check('the runner lives and answers the next message', follow !== null && follow.status === 'completed', String(follow?.status))

  tally.section('§2 the record: the transcript carries the settled paragraph, the partial paragraph and the interruption row after them')
  await runner.stop(bound(15_000))
  const code = await runner.exited
  tally.check('stdin close ends the seat with exit 0', code === 0, `exit ${String(code)}`)
  const transcript = transcriptText()
  const settledAt = transcript.indexOf(SETTLED)
  const partialAt = transcript.indexOf(PARTIAL)
  const markAt = transcript.indexOf('[Request interrupted by user]')
  tally.check('the transcript keeps the settled paragraph', settledAt !== -1)
  tally.check('red on the base: the transcript keeps the paragraph that was still streaming', partialAt !== -1, transcript.length === 0 ? 'no transcript found under the run home' : `${transcript.length} chars, partial absent`)
  tally.check('the interruption row stands after the kept words — the mark the product gives an interrupted turn', markAt !== -1 && markAt > partialAt && partialAt > settledAt, `settled@${settledAt} partial@${partialAt} mark@${markAt}`)
} finally {
  runner.kill()
  if (hanging !== null) (hanging as ServerResponse).end()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}
tally.finish()
