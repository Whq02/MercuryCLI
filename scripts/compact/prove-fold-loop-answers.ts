#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runTurns, type Frame } from '../lib/rows.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the fold loop drive exceeded 420s')
  process.exit(1)
}, 420_000)
guard.unref?.()

const FIRST = 'FIRST-MESSAGE: my name for this session is Corvid Lantern, my lucky number is 58213, and the code word is MARIGOLD-PANGOLIN-9. Please just acknowledge in one short line.'
const TASK = 'read every notes file under the folder one by one with the Read tool and summarise each in one line'
const QUESTION = 'What was my first message in this session? Quote it word for word.'
const ACK = 'Got it, Corvid Lantern: lucky number 58213, code word MARIGOLD-PANGOLIN-9.'
const ANSWER_HEAD = 'Your first message was: '
const CANNOT = 'I cannot find your first message in what I hold.'
const THRASH_HEAD = 'Auto-compaction is looping: the context refilled within'
const PAUSE_WORDS = 'Automatic compaction is paused for the rest of this run'
const FLOOR_WORDS = "The operator's newest message follows below"

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; system?: unknown; tools?: unknown[]; messages?: Item[] }
const itemsOf = (body: Body | null): Item[] => (Array.isArray(body?.messages) ? body!.messages! : [])
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textBlocksOf = (content: unknown): string[] => typeof content === 'string' ? [content] : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string)
const allTextOf = (content: unknown): string => typeof content === 'string' ? content : blocksOf(content).map(b => b.type === 'text' ? String(b.text ?? '') : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(x => String(x.text ?? '')).join('\n')) : '').join('\n')

type Hit = { seq: number; route: string; atMs: number; tokens: number; items: number; firstFound: boolean; lastBlocks: string[]; summaryRow: string }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
let toolSeq = 0
type Answer = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
function answer(model: string, blocks: Answer[], inputTokens: number): string {
  const usage = { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [`event: message_start\n${sse({ type: 'message_start', message: { id: `msg_loop_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}`]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
    } else {
      parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
    }
  })
  parts.push(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...usage, output_tokens: 40 } })}`, `event: message_stop\n${sse({ type: 'message_stop' })}`)
  return parts.join('')
}
const summaryText = (read: number): string => ['<summary>', '1. Operator Intent: read every notes file one by one and summarise each in one line; an opening message gave a name, a number and a code word (not repeated here).', '2. Technical Ground: the notes folder.', `3. Files and Code Touched: notes files 1..${read} read so far.`, '4. Errors and Corrections: none.', '5. Problems Worked: none.', '6. Operator Messages: the opening acknowledgement ask; the file task.', `7. Open Work: the remaining notes files after ${read}.`, `8. Where Work Stands: reading the notes files in order; ${read} done.`, '9. Next Move (optional): read the next notes file.', '10. Agents in flight: none.', '</summary>'].join('\n')

async function startEngine(files: string[], perTurn: number): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  let next = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!url.includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(url.endsWith('/models') ? JSON.stringify({ object: 'list', data: [], models: [] }) : '{}')
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Body | null = null
      try { body = JSON.parse(raw) as Body } catch { body = null }
      const model = typeof body?.model === 'string' ? body.model : 'fixture'
      const items = itemsOf(body)
      const lastUser = [...items].reverse().find(i => i.role === 'user')
      const lastBlocks = lastUser ? textBlocksOf(lastUser.content) : []
      const lastText = lastUser ? allTextOf(lastUser.content) : ''
      const lastOperatorBlock = [...lastBlocks].reverse().find(t => !t.trimStart().startsWith('<system-reminder>')) ?? ''
      const inputTokens = Math.ceil(raw.length / 4)
      const everything = items.map(i => allTextOf(i.content)).join('\n') + '\n' + JSON.stringify(body?.system ?? '')
      const firstFound = everything.includes(FIRST)
      const summaryRow = items.flatMap(i => i.role === 'user' ? textBlocksOf(i.content) : []).find(t => t.startsWith('The context window turned over')) ?? ''
      const mainRoad = Array.isArray(body?.tools) && body!.tools!.length > 0
      let route: string
      let blocks: Answer[]
      if (lastText.includes('Produce the summary now.')) {
        route = 'summary'
        blocks = [{ type: 'text', text: summaryText(next) }]
      } else if (!mainRoad) {
        route = 'side'
        blocks = [{ type: 'text', text: 'side' }]
      } else if (lastOperatorBlock.trim() === FIRST) {
        route = 'ack'
        blocks = [{ type: 'text', text: ACK }]
      } else if (lastOperatorBlock.trim() === QUESTION) {
        route = 'question'
        blocks = [{ type: 'text', text: firstFound ? `${ANSWER_HEAD}"${FIRST}"` : CANNOT }]
      } else if (next >= files.length) {
        route = 'done'
        blocks = [{ type: 'text', text: `All ${files.length} notes files are read and summarised.` }]
      } else {
        route = lastText.startsWith('The context window turned over') ? 'resume' : 'task'
        blocks = []
        for (let k = 0; k < perTurn && next < files.length; k++) blocks.push({ type: 'tool_use', id: `toolu_loop_read_${++toolSeq}`, name: 'Read', input: { file_path: files[next++]! } })
      }
      hits.push({ seq: hits.length + 1, route, atMs: Date.now(), tokens: inputTokens, items: items.length, firstFound, lastBlocks, summaryRow })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(answer(model, blocks, inputTokens))
    })
  })
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', () => ok()) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(ok => server.close(() => ok())) }
}

type Drive = { exit: number | null; frames: Frame[]; hits: Hit[]; stderr: string; transcript: string; t0: number; questionSentAt: number }
async function drive(label: string, opts: { files: number; lines: number; perTurn: number; window: string }): Promise<Drive> {
  const nodeBin = Bun.which('node')!
  const home = mkdtempSync(join(tmpdir(), `fold-loop-${label}-home-`))
  const cwd = mkdtempSync(join(tmpdir(), `fold-loop-${label}-cwd-`))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const files: string[] = []
  for (let i = 1; i <= opts.files; i++) {
    const path = join(cwd, `notes-${String(i).padStart(2, '0')}.txt`)
    const lines: string[] = []
    for (let line = 0; line < opts.lines; line++) lines.push(`notes ${i} line ${line}: the station keeps its notes tidy and its checks green`)
    lines.push(`notes ${i} tail ${'x'.repeat(4 * i)}`)
    writeFileSync(path, lines.join('\n') + '\n')
    files.push(path)
  }
  const engine = await startEngine(files, opts.perTurn)
  const SID = `c0ffee00-0000-4000-8000-00000f01d${label === 'loop' ? '100' : '200'}`
  const env: Record<string, string> = {
    HOME: home, PATH: `/usr/bin:/bin:${dirname(nodeBin)}`, TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: engine.base, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_THINKING_BINDING: 'drop_block', MERCURY_BLOCKING_LIMIT_OVERRIDE: opts.window, BROWSER: '/usr/bin/true',
  }
  const t0 = Date.now()
  let questionSentAt = 0
  const r = await runTurns({ node: nodeBin, dist: DIST, args: ['--model', 'claude-fable-5-1', '--sovereign', '--session-id', SID], cwd, env, timeoutMs: 300_000, turns: [FIRST, TASK, { prompt: QUESTION, before: () => { questionSentAt = Date.now() } }] })
  await engine.close()
  const projects = join(home, '.mercury', 'projects')
  let transcript = ''
  if (existsSync(projects)) for (const slug of readdirSync(projects)) for (const f of readdirSync(join(projects, slug))) if (f.endsWith('.jsonl')) transcript = join(projects, slug, f)
  return { exit: r.exit, frames: r.frames, hits: engine.hits, stderr: r.stderr, transcript, t0, questionSentAt }
}

type Boundary = { pre: number; post: number; epoch: number; rounds: Record<string, unknown>; memory: string }
function boundariesOnDisk(transcript: string): Boundary[] {
  if (transcript === '' || !existsSync(transcript)) return []
  const out: Boundary[] = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('"kind":"boundary"')) continue
    const start = line.lastIndexOf('{"schemaVersion"')
    const record = JSON.parse(start > 0 ? line.slice(start) : line) as { payload?: { kind?: string; fields?: { compactMetadata?: { preTokens?: number; postTokens?: number; ledger?: { epoch?: number }; recentRounds?: Record<string, unknown>; memory?: { state?: string } } } } }
    const meta = record.payload?.kind === 'boundary' ? record.payload.fields?.compactMetadata : undefined
    if (meta === undefined) continue
    out.push({ pre: Number(meta.preTokens), post: Number(meta.postTokens), epoch: Number(meta.ledger?.epoch), rounds: meta.recentRounds ?? {}, memory: meta.memory?.state ?? 'none' })
  }
  return out
}
const outcomesOf = (frames: Frame[]): Frame[] => frames.filter(f => f.type === 'outcome')
const noticesOf = (frames: Frame[]): string[] => frames.filter(f => f.type === 'notice').map(f => String(f.text ?? ''))
const landedRows = (frames: Frame[]): Frame[] => frames.filter(f => f.type === 'compaction' && f.state === 'ended' && f.exit === 'landed')
const turnOf = (hit: Hit, hits: Hit[]): number => hits.filter(h => h.seq <= hit.seq && h.route === 'ack').length + hits.filter(h => h.seq <= hit.seq && h.route === 'question').length
const fmt = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  section('D1 the box\'s shape: a file task whose reads are large against the window, the folds at the seams, then the question — one fold, one answer, never the thrash')
  {
    const d = await drive('loop', { files: 40, lines: 500, perTurn: 2, window: '150000' })
    const main = d.hits.filter(h => h.route !== 'side')
    for (const h of main) console.log(`  #${h.seq} +${fmt(h.atMs - d.t0)} ${h.route} ≈${h.tokens} tokens · items ${h.items} · first ${h.firstFound ? 'in' : 'OUT'}`)
    const outcomes = outcomesOf(d.frames)
    for (const o of outcomes) console.log(`  outcome: ${o.status} ${String(o.answer ?? '').slice(0, 120)}${o.error ? ` · ${String((o.error as { message?: string }).message ?? '').slice(0, 120)}` : ''}`)
    const boundaries = boundariesOnDisk(d.transcript)
    for (const b of boundaries) console.log(`  boundary: ${b.pre} → ${b.post} · ${JSON.stringify(b.rounds)} · memory ${b.memory}`)
    check('three turns, exit 0', d.exit === 0 && outcomes.length === 3, `exit=${d.exit} outcomes=${outcomes.length} stderr=${d.stderr.slice(0, 300)}`)
    check('the opening message was acknowledged', String(outcomes[0]?.answer ?? '') === ACK)
    check('the file task ran to its end — no breaker ended it (red on the base: the run ended on the thrash after three folds one round apart)', outcomes[1]?.status === 'completed' && String(outcomes[1]?.answer ?? '').startsWith('All 40 notes files'), `${outcomes[1]?.status} ${JSON.stringify(outcomes[1]?.error ?? null).slice(0, 160)}`)
    check('no thrash notice anywhere in the drive', !noticesOf(d.frames).some(t => t.includes(THRASH_HEAD)) && !outcomes.some(o => JSON.stringify(o).includes(THRASH_HEAD)), JSON.stringify(noticesOf(d.frames)).slice(0, 300))
    const summaries = main.filter(h => h.route === 'summary')
    check('the folds came at the seams: at least two automatic folds in the task run', summaries.length >= 2, String(summaries.length))
    const readCalls = d.frames.filter(f => f.type === 'tool_call' && f.tool === 'Read')
    const successfulReads = new Set(d.frames.filter(f => f.type === 'tool_result' && f.status === 'ok').map(f => f.call_id))
    const readIds = new Set(readCalls.map(f => f.call_id))
    check('all forty file reads have their own successful tool result, not just the fixture\'s final sentence', readIds.size === 40 && successfulReads.size === 40 && [...readIds].every(id => successfulReads.has(id)), `${readIds.size} read ids / ${successfulReads.size} successful results`)
    const foldEnds = d.frames.flatMap((f, i) => f.type === 'compaction' && f.state === 'ended' && f.exit === 'landed' ? [i] : [])
    const resumedReads = foldEnds.map(at => {
      const next = d.frames.findIndex((f, i) => i > at && f.type === 'compaction' && f.state === 'started')
      const resumed = d.frames.slice(at + 1, next < 0 ? undefined : next)
      const calls = new Set(resumed.filter(f => f.type === 'tool_call' && f.tool === 'Read').map(f => f.call_id))
      return resumed.filter(f => f.type === 'tool_result' && f.status === 'ok' && calls.has(f.call_id)).length
    })
    check('each landed fold resumes successful file work before the next fold starts; the last fold may resume the final answer', foldEnds.length >= 2 && resumedReads.slice(0, -1).every(n => n > 0), resumedReads.join(','))
    const threshold = Number('150000') - 20_000
    check('every fold landed with a turn of room under the threshold (post ≤ threshold − 20k)', boundaries.length >= 2 && boundaries.every(b => b.post <= threshold - 20_000), boundaries.map(b => `${b.pre}→${b.post}`).join(' '))
    const questionHit = main.find(h => h.route === 'question')
    const foldsBetween = questionHit === undefined ? -1 : main.filter(h => h.route === 'summary' && h.atMs >= d.questionSentAt && h.seq < questionHit.seq).length
    check(`the question was answered with the first message's exact words (red on the base: "${CANNOT}")`, outcomes[2]?.status === 'completed' && String(outcomes[2]?.answer ?? '') === `${ANSWER_HEAD}"${FIRST}"`, String(outcomes[2]?.answer ?? '').slice(0, 160))
    check(`at most one summariser call between the question and the answer (${foldsBetween})`, foldsBetween >= 0 && foldsBetween <= 1, String(foldsBetween))
    check('the first message rode whole in the request that answered: the operator block carries the session\'s opening message across every fold', questionHit?.firstFound === true)
    check('the question was the last text block of its request, after the summary and the preserved rounds', questionHit !== undefined && (questionHit.lastBlocks.at(-1) ?? '').trim() === QUESTION, JSON.stringify(questionHit?.lastBlocks.map(t => t.slice(0, 50))))
    check('when a fold preceded the answer, the summary message gave the newest message the floor', foldsBetween === 0 || (questionHit?.summaryRow.includes(FLOOR_WORDS) === true && !questionHit.summaryRow.includes('Carry the last task on as if the break never happened')), questionHit?.summaryRow.slice(-300))
    const answerAt = outcomes[2] !== undefined ? Date.parse(String(outcomes[2].timestamp ?? '')) : 0
    console.log(`  [record] question → answer: ${fmt(answerAt - d.questionSentAt)} with ${foldsBetween} summariser call(s); the whole drive ${fmt(Date.now() - d.t0)}; ${summaries.length} folds in all`)
    const rows = landedRows(d.frames)
    check('one painted compaction row per boundary on disk, each with the boundary\'s own before figure', rows.length === boundaries.length && rows.every((row, i) => Number(row.tokens_before) === boundaries[i]!.pre), `${rows.length} rows / ${boundaries.length} boundaries · ${rows.map(r => r.tokens_before).join(',')} vs ${boundaries.map(b => b.pre).join(',')}`)
    check('every boundary carries its own figures: the after figure is the fold\'s own, under its before, and each boundary is its own fold — the ledger epochs strictly increase', boundaries.every(b => b.post < b.pre) && boundaries.every((b, i) => Number.isFinite(b.epoch) && (i === 0 || b.epoch > boundaries[i - 1]!.epoch)), boundaries.map(b => `epoch ${b.epoch}: ${b.pre}→${b.post}`).join(' '))
    check('the before figures are distinct by construction (every file carries a tail of its own length), so no two folds can share one', new Set(boundaries.map(b => b.pre)).size === boundaries.length, boundaries.map(b => b.pre).join(','))
    const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
    const chain = await reader.readTranscriptChainSince(d.transcript, null)
    const chainBoundaries = chain.rows.filter((r: Record<string, unknown>) => r.type === 'system' && r.subtype === 'compact_boundary') as Array<{ compactMetadata?: { preTokens?: number; postTokens?: number } }>
    const last = boundaries.at(-1)
    check('the chain the chat reads after the run carries the newest boundary with its own figures', chainBoundaries.length >= 1 && last !== undefined && chainBoundaries.at(-1)?.compactMetadata?.preTokens === last.pre && chainBoundaries.at(-1)?.compactMetadata?.postTokens === last.post, JSON.stringify(chainBoundaries.map(b => b.compactMetadata)))
    check('the memory move was never claimed where nothing substantive stood (a headless drive holds no run state)', boundaries.every(b => b.memory === 'failed'), boundaries.map(b => b.memory).join(','))
  }

  section('D2 the breaker on purpose: each round brings more than a fold can free — the notice rides beside the work, the pause is said once, the question is still answered')
  {
    const d = await drive('trip', { files: 30, lines: 1_200, perTurn: 3, window: '120000' })
    const main = d.hits.filter(h => h.route !== 'side')
    for (const h of main) console.log(`  #${h.seq} +${fmt(h.atMs - d.t0)} ${h.route} ≈${h.tokens} tokens · items ${h.items} · first ${h.firstFound ? 'in' : 'OUT'}`)
    const outcomes = outcomesOf(d.frames)
    for (const o of outcomes) console.log(`  outcome: ${o.status} ${String(o.answer ?? '').slice(0, 120)}${o.error ? ` · ${String((o.error as { message?: string }).message ?? '').slice(0, 160)}` : ''}`)
    const notices = noticesOf(d.frames)
    const thrash = notices.filter(t => t.includes(THRASH_HEAD))
    check('three turns ran', outcomes.length === 3, `outcomes=${outcomes.length} exit=${d.exit}`)
    check('the breaker tripped once: ONE warning row carries the thrash words and the pause, said once', thrash.length === 1 && thrash[0]!.includes(PAUSE_WORDS), JSON.stringify(thrash).slice(0, 400))
    const thrashFrame = d.frames.find(f => f.type === 'notice' && String(f.text ?? '').includes(THRASH_HEAD))
    const thrashAt = thrashFrame !== undefined ? Date.parse(String(thrashFrame.timestamp ?? '')) : 0
    const callsAfter = main.filter(h => h.route !== 'summary' && h.atMs >= thrashAt - 50).length
    check('the turn went on after the notice: the engine was called again (the notice rides beside the work, never instead of it; red on the base: the run ended there)', thrashAt > 0 && callsAfter >= 1, `calls after the notice: ${callsAfter}`)
    const taskError = String((outcomes[1]?.error as { message?: string } | undefined)?.message ?? '')
    check('the pause then stopped a later refill in the same run with the breaker\'s own ending, the pause named — not the thrash words as the reply', outcomes[1]?.status === 'failed' && (outcomes[1]?.error as { class?: string } | undefined)?.class === 'refill_breaker', `${outcomes[1]?.status} ${JSON.stringify(outcomes[1]?.error ?? null).slice(0, 200)}`)
    check('the ladder\'s refusal names the pause', d.frames.some(f => f.type === 'notice' && String(f.text ?? '').includes(PAUSE_WORDS)) || taskError.includes('refilled'), taskError.slice(0, 200))
    check('the question, a fresh run, was still answered with the first message\'s exact words', outcomes[2]?.status === 'completed' && String(outcomes[2]?.answer ?? '') === `${ANSWER_HEAD}"${FIRST}"`, String(outcomes[2]?.answer ?? '').slice(0, 160))
    const boundaries = boundariesOnDisk(d.transcript)
    const rows = landedRows(d.frames)
    check('one painted compaction row per boundary on disk, each with its own figure', rows.length === boundaries.length && rows.every((row, i) => Number(row.tokens_before) === boundaries[i]!.pre), `${rows.length} rows / ${boundaries.length} boundaries`)
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ FOLD LOOP ANSWERS GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} FOLD LOOP ANSWERS FAILURE(S) (${checks} checks)`)
process.exit(1)
