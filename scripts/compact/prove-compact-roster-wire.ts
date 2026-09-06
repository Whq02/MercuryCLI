#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the compact roster wire drive exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const ASK = 'roster-drive: launch'
const SEAT_MARK = 'roster-seat:'
const NOTES_FILE = 'station-notes.txt'
const WF_NAME = 'roster-survey'
const PHASE = 'Survey'
const WF_SEATS = ['wf-one', 'wf-two'] as const
const PLAIN_SEAT = 'plain'
const PLAIN_DESCRIPTION = 'plain-survey'
const SHELL_DESCRIPTION = 'roster-shell sleeps'
const SHELL_SECONDS = 20
const POST_DONE = 'ROSTER-POST-DONE'
const NOTED = 'ROSTER-NOTED'
const LAUNCHED = 'ROSTER-LAUNCHED'
const SUMMARY_MARK = 'ROSTER-SUMMARY-BODY'
const WF_READS = 7
const WF_STEP_MS = 3000
const PLAIN_READS = 1
const PLAIN_STEP_MS = 800
const SUMMARY_HOLD_MS = 6000
const WF_SCRIPT = [
  `export const meta = { name: '${WF_NAME}', description: 'two agents survey the stations', phases: [{ title: '${PHASE}' }] }`,
  `phase('${PHASE}')`,
  `const reports = await parallel([${WF_SEATS.map(s => `() => agent('${SEAT_MARK}${s} read the notes file, one read per turn, then report in one line')`).join(', ')}])`,
  'return { reports }',
].join('\n')

type Route = 'launch' | 'launched' | 'summary' | 'post' | 'note' | 'seat' | 'side'
type Seat = (typeof WF_SEATS)[number] | typeof PLAIN_SEAT
type Block = { type?: string; id?: string; name?: string; text?: string; tool_use_id?: string; content?: unknown; input?: Record<string, unknown> }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; system?: unknown; tools?: unknown[]; messages?: Item[] }
const itemsOf = (body: Body | null): Item[] => (Array.isArray(body?.messages) ? body!.messages! : [])
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : blocksOf(content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
const offersTool = (body: Body | null, name: string): boolean =>
  Array.isArray(body?.tools) && body!.tools!.some(t => (t as { name?: string })?.name === name)
function answeredTools(items: Item[]): string[] {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user') return []
  const ids = new Set(blocksOf(last.content).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => b.tool_use_id as string))
  if (ids.size === 0) return []
  const names: string[] = []
  for (let i = items.length - 2; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'assistant') continue
    for (const use of blocksOf(item.content)) if (use.type === 'tool_use' && typeof use.id === 'string' && ids.has(use.id)) names.push(use.name ?? '')
    if (names.length > 0) break
  }
  return names
}
function seatOf(items: Item[]): Seat | null {
  const userText = items
    .filter(i => i.role === 'user')
    .map(i => textOf(i.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))
    .filter(t => !t.includes('task-notification'))
    .join('\n')
  for (const s of [...WF_SEATS, PLAIN_SEAT] as Seat[]) if (userText.includes(`${SEAT_MARK}${s}`)) return s
  return null
}
const readsOf = (items: Item[]): number =>
  items.filter(i => i.role === 'assistant' && blocksOf(i.content).some(b => b.type === 'tool_use' && b.name === 'Read')).length
const userTextsOf = (items: Item[]): string[] =>
  items.filter(i => i.role === 'user').map(i =>
    typeof i.content === 'string'
      ? i.content
      : blocksOf(i.content)
          .map(b => (b.type === 'text' ? String(b.text ?? '') : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(x => String(x.text ?? '')).join('\n')) : ''))
          .join('\n'),
  )

type Hit = { seq: number; route: Route; seat: Seat | null; atMs: number; answeredAtMs: number; model: string; body: Body | null; lastUserText: string }
type Answer =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let msgSeq = 0
const SMALL_USAGE = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const FAT_USAGE = { input_tokens: 97_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function answer(model: string, blocks: Answer[], usage: typeof SMALL_USAGE): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_roster_${++msgSeq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}`,
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...usage, output_tokens: 40 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

const SUMMARY_TEXT = [
  '<analysis>the launch turn</analysis>',
  '<summary>',
  `1. Operator Intent: ${SUMMARY_MARK} — launch the survey.`,
  '2. Technical Ground: the loopback fixture.',
  '3. Files and Code Touched: none.',
  '4. Errors and Corrections: none.',
  '5. Problems Worked: none.',
  `6. Operator Messages: "${ASK}".`,
  '7. Open Work: the survey.',
  '8. Where Work Stands: the launches landed.',
  '9. Next Move (optional): wait for the agents.',
  `10. Agents in flight: the workflow ${WF_NAME} (${WF_SEATS.join(', ')}), the sub-agent ${PLAIN_DESCRIPTION}, the shell.`,
  '</summary>',
].join('\n')

async function startFixture(port: number, cwd: string): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  let toolSeq = 0
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
      let body: Body | null = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      } catch {
        body = null
      }
      const model = typeof body?.model === 'string' ? body.model : 'fixture'
      const items = itemsOf(body)
      const lastUser = [...items].reverse().find(i => i.role === 'user')
      const lastUserText = lastUser ? textOf(lastUser.content) : ''
      const firstUserText = textOf(items.find(i => i.role === 'user')?.content)
      const seat = seatOf(items)
      const answered = answeredTools(items)
      let route: Route
      if (seat !== null) route = 'seat'
      else if (lastUserText.includes('Reply with prose only')) route = 'summary'
      else if (lastUserText.includes('task-notification')) route = 'note'
      else if (firstUserText.includes('The context window turned over')) route = 'post'
      else if (answered.includes('Workflow') || answered.includes('Agent')) route = 'launched'
      else if (lastUserText.includes(ASK) && offersTool(body, 'Workflow')) route = 'launch'
      else route = 'side'
      const priorReads = readsOf(items)
      const hit: Hit = { seq: hits.length + 1, route, seat, atMs: Date.now(), answeredAtMs: 0, model, body, lastUserText }
      hits.push(hit)
      let blocks: Answer[]
      let delayMs = 0
      let usage = SMALL_USAGE
      switch (route) {
        case 'launch':
          blocks = [
            { type: 'text', text: 'launching the survey, the plain sub-agent and the shell' },
            { type: 'tool_use', id: `toolu_roster_wf_${++toolSeq}`, name: 'Workflow', input: { script: WF_SCRIPT } },
            {
              type: 'tool_use',
              id: `toolu_roster_agent_${++toolSeq}`,
              name: 'Agent',
              input: { description: PLAIN_DESCRIPTION, prompt: `${SEAT_MARK}${PLAIN_SEAT} read the notes file once, then report in one line`, subagent_type: 'mercury-general', run_in_background: true },
            },
            { type: 'tool_use', id: `toolu_roster_shell_${++toolSeq}`, name: 'Bash', input: { command: `sleep ${SHELL_SECONDS}`, description: SHELL_DESCRIPTION, run_in_background: true } },
          ]
          usage = FAT_USAGE
          break
        case 'launched':
          blocks = [{ type: 'text', text: LAUNCHED }]
          break
        case 'summary':
          blocks = [{ type: 'text', text: SUMMARY_TEXT }]
          delayMs = SUMMARY_HOLD_MS
          break
        case 'post':
          blocks = [{ type: 'text', text: POST_DONE }]
          break
        case 'note':
          blocks = [{ type: 'text', text: NOTED }]
          break
        case 'seat': {
          const reads = seat === PLAIN_SEAT ? PLAIN_READS : WF_READS
          if (priorReads >= reads) {
            blocks = [{ type: 'text', text: `SEAT-DONE-${seat}` }]
          } else {
            blocks = [{ type: 'tool_use', id: `toolu_roster_read_${++toolSeq}`, name: 'Read', input: { file_path: join(cwd, NOTES_FILE) } }]
            delayMs = seat === PLAIN_SEAT ? PLAIN_STEP_MS : WF_STEP_MS
          }
          break
        }
        default:
          blocks = [{ type: 'text', text: 'side' }]
      }
      const payload = answer(model, blocks, usage)
      setTimeout(() => {
        hit.answeredAtMs = Date.now()
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(payload)
      }, delayMs).unref?.()
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolvePromise())
  })
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
  }
}

interface RunResult { exit: number | null; stdout: string; stderr: string }
interface Arena { home: string; cwd: string; env: Record<string, string> }
function makeArena(fixtureBase: string, nodeBin: string): Arena {
  const home = mkdtempSync(join(tmpdir(), 'compact-roster-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'compact-roster-cwd-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  writeFileSync(join(cwd, NOTES_FILE), 'the station notes\n')
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixtureBase,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9',
    },
  }
}
function runStreaming(nodeBin: string, arena: Arena, args: string[], prompt: string, killAfterMs: number): Promise<RunResult> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    let ended = false
    child.stdout.on('data', d => {
      stdout += d
      if (!ended && stdout.includes('"type":"result"')) {
        ended = true
        child.stdin.end()
      }
    })
    child.stderr.on('data', d => (stderr += d))
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
    child.on('close', exit => {
      clearTimeout(killer)
      resolvePromise({ exit, stdout, stderr })
    })
    child.on('spawn', () => {
      child.stdin.write(j({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
    })
  })
}

console.log('============================================================')
console.log(' the roster after a fold — real bundle, the stream-json road')
console.log('============================================================')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const PORT = Number(process.env.COMPACT_ROSTER_PORT ?? 34121)
    const arenaSeed = makeArena('', nodeBin)
    const fixture = await startFixture(PORT, arenaSeed.cwd)
    const arena: Arena = { ...arenaSeed, env: { ...arenaSeed.env, ANTHROPIC_BASE_URL: fixture.base } }
    const SID = 'c0ffee00-0000-4000-8000-0000000ab0c1'
    const debugFile = join(arena.home, 'roster.debug.log')
    const r = await runStreaming(
      nodeBin,
      arena,
      ['-p', '--input-format', 'stream-json', '--model', 'claude-fable-5-1', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--session-id', SID, '--debug-file', debugFile],
      ASK,
      150_000,
    )
    await fixture.close()
    const hits = fixture.hits
    const t0 = hits[0]?.atMs ?? 0
    console.log(`  exit=${r.exit} · ${hits.length} requests`)
    for (const h of hits) console.log(`  #${h.seq} +${((h.atMs - t0) / 1000).toFixed(1)}s ${h.seat !== null ? `seat:${h.seat}` : h.route} model=${h.model} items=${itemsOf(h.body).length} · ${h.lastUserText.replace(/\s+/g, ' ').slice(0, 90)}`)
    const debug = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
    const captureDir = process.env.COMPACT_ROSTER_CAPTURE_DIR
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true })
      const summaryHit = hits.find(h => h.route === 'summary')
      const postHit = hits.find(h => h.route === 'post')
      writeFileSync(join(captureDir, 'summary-prompt.txt'), summaryHit?.lastUserText ?? '(no summary request)')
      writeFileSync(join(captureDir, 'post-fold-request.txt'), postHit !== undefined ? userTextsOf(itemsOf(postHit.body)).join('\n\n=== next user item ===\n\n') : '(no post-fold request)')
      writeFileSync(join(captureDir, 'hits.json'), JSON.stringify(hits.map(h => ({ seq: h.seq, route: h.route, seat: h.seat, atMs: h.atMs - t0, answeredAtMs: h.answeredAtMs - t0, lastUserText: h.lastUserText.slice(0, 2000) })), null, 2))
    }

    section('W0 the run')
    check('the run exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 600)}`)
    const launch = hits.find(h => h.route === 'launch')
    check('the launch turn went out and was answered with the three launches', launch !== undefined)
    const summary = hits.find(h => h.route === 'summary')
    const launchResults = itemsOf(summary?.body ?? null)
      .filter(i => i.role === 'user')
      .flatMap(i => blocksOf(i.content).filter(b => b.type === 'tool_result').map(b => (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(x => String(x.text ?? '')).join('\n'))))
      .join('\n')
    check('every launch landed (no permission refusal among the launch results)', summary !== undefined && !/permission|denied|approval/i.test(launchResults), launchResults.split('\n').filter(l => /permission|approval|denied/i.test(l)).slice(0, 3).join(' | ').slice(0, 400))
    check('the fold fired on the cycle after the launches (the summariser request went out)', summary !== undefined, hits.map(h => h.route).join(' → '))
    check('the fold took the cache-sharing fork road (Claude Fable 5.1 on the Anthropic wire)', debug.includes('forkedAgent(compact)'), debug.split('\n').filter(l => l.includes('compact')).slice(0, 3).join(' | ').slice(0, 300))
    const post = hits.find(h => h.route === 'post')
    check('a post-fold request went out (its first user item is the summary row)', post !== undefined)
    check('the post-fold turn answered', r.stdout.includes(POST_DONE))

    section('W1 the summariser asks for the agents in flight')
    const promptText = summary?.lastUserText ?? ''
    check('the prompt lists ten numbered sections', promptText.includes('ten numbered sections'), promptText.slice(promptText.indexOf('numbered sections') - 40, promptText.indexOf('numbered sections') + 40))
    check('…the tenth is Agents in flight', /10\. Agents in flight/.test(promptText))
    check('…and it says a running agent is never re-spawned and a pending result is collected, not re-derived', /never re-spawn/i.test(promptText) && /collected, not re-derived/i.test(promptText))
    check('…the output example shows the tenth section', /10\. Agents in flight:\n\s+\[\.\.\.\]/.test(promptText))

    section('W2 the post-fold request carries ONE roster naming every agent')
    const postTexts = post !== undefined ? userTextsOf(itemsOf(post.body)) : []
    const postAll = postTexts.join('\n')
    check('the post-fold request starts from the summary row (the fold happened)', postAll.includes('The context window turned over'))
    check('…and carries the summary whole, the tenth section included', postAll.includes(SUMMARY_MARK) && postAll.includes('10. Agents in flight'))
    const reminders = postAll.split('<system-reminder>').filter(t => t.includes('Agents in flight at the context turnover'))
    const roster = reminders[0] ?? ''
    for (const line of roster.split('\n').filter(l => l.startsWith('- '))) console.log(`  roster: ${line.slice(0, 260)}`)
    check('ONE roster attachment rides the post-fold request', reminders.length === 1, `${reminders.length} roster reminder(s); user items ${postTexts.length}`)
    check('the roster names the workflow run by its name and kind', roster.includes(`local_workflow "${WF_NAME}"`))
    for (const s of WF_SEATS) check(`…and the workflow agent ${s} (by its prompt head, with the run view's own state word)`, roster.includes(`${SEAT_MARK}${s}`))
    check(`…the plain sub-agent ${PLAIN_DESCRIPTION} with the crew view's status word`, new RegExp(`local_agent "${PLAIN_DESCRIPTION}" \\[a[0-9a-z]+\\]: (running|waiting|landed)`).test(roster))
    check(`…the shell by its command, asked "${SHELL_DESCRIPTION}"`, roster.includes(`local_bash "sleep ${SHELL_SECONDS}"`) && roster.includes(`asked: ${SHELL_DESCRIPTION}`))
    check('every row names what is owed and the doors (SendMessage for the sub-agent, TaskOutput and TaskStop for the rest)', /owed:/.test(roster) && /reach it: SendMessage to "a[0-9a-z]+"/.test(roster) && roster.includes('reach it: TaskOutput and TaskStop by its id'))
    check('the sub-agent row carries its output path', new RegExp(`\\[a[0-9a-z]+\\][^\\n]*output: [^\\n]*\\.output`).test(roster))
    check('the roster says a running agent is never re-spawned and an owed result is collected', roster.includes('A running agent is never re-spawned') && roster.includes('never re-derived'))
    check('no second announcer names the plain sub-agent (the old per-task line is gone)', !postAll.includes('is still running. Do NOT spawn a duplicate'))

    section('W3 the agents are untouched by the fold')
    const summaryAnsweredAt = summary?.answeredAtMs ?? Number.POSITIVE_INFINITY
    for (const s of WF_SEATS) {
      const after = hits.filter(h => h.seat === s && h.atMs > summaryAnsweredAt).length
      check(`workflow seat ${s} kept calling after the summary landed (${after} calls)`, after >= 2)
    }
    const notes = hits.filter(h => h.route === 'note')
    for (const n of notes) console.log(`  note: ${n.lastUserText.replace(/\s+/g, ' ').slice(0, 260)}`)
    check('no agent was stopped by the fold (no killed notice)', notes.every(n => !n.lastUserText.includes('<status>killed</status>')))
    check('the workflow settled on its own after the fold (its completion notice reached the main)', notes.some(n => /<task-id>local_workflow_/.test(n.lastUserText) && /<status>completed/.test(n.lastUserText)))

    section('W4 a result that lands during the fold is delivered once, after the boundary')
    const plainDone = hits.find(h => h.seat === PLAIN_SEAT && readsOf(itemsOf(h.body)) >= PLAIN_READS)
    const summaryStartedAt = summary?.atMs ?? 0
    check('the plain sub-agent settled while the summary was held', plainDone !== undefined && plainDone.answeredAtMs > summaryStartedAt && plainDone.answeredAtMs < summaryAnsweredAt, plainDone ? `settled +${((plainDone.answeredAtMs - t0) / 1000).toFixed(1)}s; summary +${((summaryStartedAt - t0) / 1000).toFixed(1)}s → +${((summaryAnsweredAt - t0) / 1000).toFixed(1)}s` : 'no settle seen')
    const plainNotes = notes.filter(n => n.lastUserText.includes(PLAIN_DESCRIPTION))
    check('exactly one notice carried the plain sub-agent\'s completion', plainNotes.length === 1, `${plainNotes.length} notice(s)`)
    check('…delivered after the boundary (its request starts from the summary row)', plainNotes.length === 1 && (userTextsOf(itemsOf(plainNotes[0]!.body))[0] ?? '').includes('The context window turned over'))
    check('…and never twice across every later request', hits.filter(h => h.seat === null && h.lastUserText.includes(PLAIN_DESCRIPTION) && h.lastUserText.includes('task-notification')).length === 1)
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ COMPACT ROSTER WIRE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACT ROSTER WIRE FAILURE(S) (${checks} checks)`)
process.exit(1)
