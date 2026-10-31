#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { untilAsync } from '../lib/untilAsync.ts'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, type AvailableCaptureDriver } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { buildRefDist, distBuildTree } from '../lib/refDist.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const KEEP = process.argv.includes('--keep')
const SOURCE_REF = argAfter('--source-ref')
const CLIENT_REF = argAfter('--client-ref')
const log = (line: string): void => console.log(`  ${line}`)
const DIST = argAfter('--dist') ?? (SOURCE_REF !== undefined ? buildRefDist(REPO, SOURCE_REF, { log }).dist : process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs'))
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const CLIENT_DIST = argAfter('--client-dist') ?? (CLIENT_REF !== undefined ? buildRefDist(REPO, CLIENT_REF, { log }).dist : undefined)
if (CLIENT_DIST !== undefined && !existsSync(CLIENT_DIST)) {
  console.error(`✗ ${CLIENT_DIST} missing — the older window's bundle must be built`)
  process.exit(1)
}
const resolved = resolveCaptureDriver()
if (resolved.kind !== 'posix-pty') {
  console.log(`__SUITE_SKIPPED reply-paints-whole: ${resolved.kind === 'unavailable' ? `${resolved.reason} (${resolved.remedy})` : `the ${resolved.kind} capture driver is not driven by this proof`}`)
  process.exit(0)
}
const driver: AvailableCaptureDriver = resolved
const nodeBeside = (dist: string): string => {
  const vendored = join(dirname(dist), 'vendor', 'node', 'bin', 'node')
  return existsSync(vendored) ? vendored : 'node'
}
const NODE = nodeBeside(DIST)

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'reply-paints-whole-')))
const home = join(SCRATCH, 'home')
const work = join(SCRATCH, 'work')
const daemonDir = join(home, 'daemon')
const FRAMES = argAfter('--frames') ?? join(SCRATCH, 'frames')
for (const dir of [home, work, FRAMES]) mkdirSync(dir, { recursive: true })
writeFileSync(join(work, 'README.md'), '# the reply-paints-whole fixture\n')
seedFirstRun(home, [work])
const BUNDLE = readFileSync(DIST, 'utf8')
const BOARD_IN_BUILD = BUNDLE.includes('swarm.enabled')
const BOARD_ROWS_IN_BUILD = BUNDLE.includes('[Crewboard]')
writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { sovereignConsentSeen: true }, activity: { tips: { enabled: false } }, ...(BOARD_IN_BUILD ? { swarm: { enabled: true } } : {}) }))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const words = (text: string): string[] => text.split(' ').map((w, i, all) => (i < all.length - 1 ? `${w} ` : w))
const longReply = (noun: string, mark: string, end: string, count: number): string => Array.from({ length: count }, (_, i) => `${noun} ${i + 1} (${mark}${i + 1}) of the ${noun === 'Sentence' ? 'long' : 'resumed'} reply carries its own distinct words so a cut would show.`).join(' ') + ` ${end}`
const LONG = longReply('Sentence', 'LONG-S', 'THE-LONG-END', 16)
const TOOL_PRE = 'Running the tool now, watch the rows.'
const TOOL_AFTER = 'The tool ran and printed its line. THE-TOOL-END'
const SHORT = 'A short reply in a few chunks. THE-SHORT-END'
const AGAIN = longReply('Line', 'AGAIN-L', 'THE-AGAIN-END', 14)
const SHORT_AGAIN = 'A short resumed reply in a few chunks. THE-SHORT-AGAIN-END'
const OLDER = longReply('Row', 'OLDER-R', 'THE-OLDER-END', 12)
const SHORT_OLDER = 'A short reply to the older window. THE-SHORT-OLDER-END'
const SUMMARY_MARK = 'PAINT-FOLD-SUMMARY'
const SUMMARY = `<analysis>The operator asked for a long reply, a tool run and a short reply; every one was answered in full.</analysis>\n<summary>\n1. Operator Intent: see the replies paint whole.\n2. Technical Ground: ${SUMMARY_MARK} — a fixture conversation with one tool run.\n3. Files and Code Touched: none.\n4. Errors and Corrections: none.\n5. Problems Worked: none.\n6. Operator Messages: the three asks.\n7. Open Work: nothing outstanding.\n8. Where Work Stands: every ask answered.\n9. Next Move: await the next ask.\n</summary>`
const BOARD_POST = '@main PAINT-BOARD-POST the lane finished its reading'
const BOARD_POST_OLDER = '@main PAINT-BOARD-POST-TWO the lane read the older window'
const turns: ScriptedTurn[] = [
  { kind: 'stream', blocks: [{ type: 'thinking', deltas: ['Thinking ', 'about ', 'the long one.'] }, { type: 'text', deltas: words(LONG) }], gapMs: 30, usage: { input_tokens: 12000, output_tokens: 400 }, whenBody: 'paint-long-1' },
  { kind: 'paced_tool_use', preDeltas: words(TOOL_PRE), gapMs: 100, tools: [{ name: 'Bash', input: { command: 'seq 1 6000', description: 'count the ledger rows' } }], whenBody: 'paint-tool-1' },
  { kind: 'stream', blocks: [{ type: 'text', deltas: words(TOOL_AFTER) }], gapMs: 100, usage: { input_tokens: 9000, output_tokens: 40 }, whenBody: 'seq 1 6000' },
  { kind: 'text', text: SUMMARY, whenBody: 'running record of this conversation' },
  { kind: 'paced', deltas: words(SHORT), gapMs: 120, whenBody: 'paint-short-1' },
  { kind: 'stream', blocks: [{ type: 'thinking', deltas: ['Thinking ', 'again.'] }, { type: 'text', deltas: words(AGAIN) }], gapMs: 30, whenBody: 'paint-long-2' },
  { kind: 'paced', deltas: words(SHORT_AGAIN), gapMs: 120, whenBody: 'paint-short-2' },
  { kind: 'stream', blocks: [{ type: 'thinking', deltas: ['Thinking ', 'for the older window.'] }, { type: 'text', deltas: words(OLDER) }], gapMs: 30, whenBody: 'paint-long-3' },
  { kind: 'paced', deltas: words(SHORT_OLDER), gapMs: 120, whenBody: 'paint-short-3' },
  { kind: 'text', text: 'Spare one.' },
  { kind: 'text', text: 'Spare two.' },
  { kind: 'text', text: 'Spare three.' },
]
const api = await startFixtureApi(turns)

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_HOME: join(home, 'proof-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_UPDATE_NOTICE: '0',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CONNECTOR_TRACE: join(SCRATCH, 'connector-trace.jsonl'),
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  BROWSER: '/usr/bin/true',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  COLORTERM: 'truecolor',
}
for (const key of ['NODE_ENV', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL', 'CI']) delete childEnv[key]

type Cell = { c: string }
type Grid = { grid: Cell[][] }
type Payload = Grid & { marks?: ({ label: string; atTick: number } & Grid)[]; endReason?: string; sendReceipts?: unknown[] }
type Send = Record<string, unknown>
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, ''))
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
function paneText(lines: string[]): string {
  const top = lines.findIndex(l => /╭─+╮\s*$/.test(l) && l.indexOf('╭') >= 10)
  const left = top >= 0 ? lines[top]!.indexOf('╭') : 0
  const right = top >= 0 ? lines[top]!.indexOf('╮') : 200
  return collapse(lines.map(l => l.slice(left + 1, right).replace(/[│╭╮╰╯─]/g, ' ')).join(' '))
}
function paintedPrefix(pane: string, text: string): number {
  const want = collapse(text)
  let n = 0
  while (n < want.length && pane.includes(want.slice(0, n + 1))) n++
  return n
}

type Capture = { frames: Map<string, string[]>; endReason: string; receipts: number; status: number | null }
async function capture(tag: string, dist: string, argv: string[], sends: Send[], readyText: string, total: number): Promise<Capture> {
  const cfgPath = join(SCRATCH, `${tag}-cfg.json`)
  const outPath = join(SCRATCH, `${tag}-grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [nodeBeside(dist), dist, ...argv], cwd: work, cols: 120, rows: 44, total, sends, readyText: [readyText], stableTicks: 6, out: outPath }))
  const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: work, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += String(c) })
  child.stderr.on('data', c => { output += String(c) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(total * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(join(SCRATCH, `${tag}-vshot.log`), output)
  const frames = new Map<string, string[]>()
  let endReason = 'no capture'
  let receipts = 0
  if (existsSync(outPath)) {
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Payload
    endReason = payload.endReason ?? 'unknown'
    receipts = payload.sendReceipts?.length ?? 0
    for (const m of payload.marks ?? []) {
      frames.set(m.label, linesOf(m))
      writeFileSync(join(FRAMES, `${tag}-${m.label}.txt`), linesOf(m).join('\n') + '\n')
    }
    frames.set('final', linesOf(payload))
    writeFileSync(join(FRAMES, `${tag}-final.txt`), linesOf(payload).join('\n') + '\n')
  }
  return { frames, endReason, receipts, status }
}

type StoreRow = { recordId: string; parentId?: string; kind: string; text: string }
function storeRows(transcript: string): StoreRow[] {
  const latest = new Map<string, StoreRow>()
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row: { recordId: string; parentId?: string; payload?: { kind?: string; content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const kind = row.payload?.kind ?? ''
    if (kind !== 'output' && kind !== 'input') continue
    const content = row.payload?.content
    const text = typeof content === 'string' ? collapse(content) : collapse((Array.isArray(content) ? (content as Array<{ kind?: string; text?: string }>) : []).filter(b => b.kind === 'text').map(b => b.text ?? '').join(' '))
    latest.set(row.recordId, { recordId: row.recordId, ...(row.parentId !== undefined ? { parentId: row.parentId } : {}), kind, text })
  }
  return [...latest.values()]
}
const replies = (rows: StoreRow[]): StoreRow[] => rows.filter(r => r.kind === 'output' && r.text !== '')
function newestTranscript(): string | null {
  const projects = join(home, 'projects')
  const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : [])
  const found = walk(projects).filter(p => /\/[0-9a-f-]{36}\.jsonl$/.test(p) && !p.includes('/lineage/')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0] ?? null
}
const TRACE = join(SCRATCH, 'connector-trace.jsonl')
function paintedRecordIds(): Set<string> {
  const ids = new Set<string>()
  if (!existsSync(TRACE)) return ids
  for (const line of readFileSync(TRACE, 'utf8').split('\n')) {
    if (!line.includes('"list-render"')) continue
    try {
      const entry = JSON.parse(line) as { ev?: string; tail?: string[] }
      if (entry.ev !== 'list-render') continue
      for (const row of entry.tail ?? []) ids.add(row.split(':')[1]?.split('/')[0] ?? '')
    } catch {
      continue
    }
  }
  return ids
}
function judgeReply(label: string, frame: string[] | undefined, text: string, store: StoreRow[]): void {
  const recorded = replies(store).find(r => r.text === collapse(text))
  check(`${label}: the store holds the reply whole`, recorded !== undefined, replies(store).map(r => `${r.recordId.slice(0, 8)}:${r.text.slice(0, 40)}…(${r.text.length})`).join(' | '))
  if (frame === undefined) {
    check(`${label}: the frame after the reply landed was captured`, false, 'the capture never reached that mark')
    return
  }
  const pane = paneText(frame)
  const whole = pane.includes(collapse(text))
  const painted = paintedPrefix(pane, text)
  check(`${label}: the screen paints the reply whole (${collapse(text).length} chars)`, whole, `painted ${painted} of ${collapse(text).length} chars: ${JSON.stringify(collapse(text).slice(0, Math.min(painted, 60)))}${painted < collapse(text).length ? '…' : ''}`)
  if (recorded !== undefined) {
    const ids = paintedRecordIds()
    check(`${label}: the painted row is the store's record ${recorded.recordId.slice(0, 8)}, not a streaming echo left standing`, ids.has(recorded.recordId.slice(0, 8)), `the screen's painted list named ${ids.size} rows and never this record`)
  }
}
function judgeUserRow(label: string, frame: string[] | undefined, text: string, store: StoreRow[]): void {
  const recorded = store.find(r => r.kind === 'input' && r.text === collapse(text))
  check(`${label}: the store holds the operator's row`, recorded !== undefined, store.filter(r => r.kind === 'input').map(r => `${r.recordId.slice(0, 8)}:${r.text.slice(0, 40)}`).join(' | '))
  check(`${label}: the screen paints the operator's row`, frame !== undefined && paneText(frame).includes(collapse(text)), frame === undefined ? 'no frame' : paneText(frame).slice(-300))
  if (recorded !== undefined) check(`${label}: the painted row is the store's record ${recorded.recordId.slice(0, 8)}`, paintedRecordIds().has(recorded.recordId.slice(0, 8)), 'the screen\'s painted list never named this record')
}
function judgeChain(label: string, transcript: string | null): void {
  if (transcript === null) return
  const rows = readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { recordId: string; parentId?: string; payload?: { kind?: string } })
  const chained = rows.filter(r => ['input', 'output', 'attachment', 'notice'].includes(r.payload?.kind ?? ''))
  const roots = chained.filter(r => r.parentId === undefined)
  check(`${label}: the transcript has one root — every row written after the resume chains onto the conversation`, roots.length === 1, `${roots.length} roots: ${roots.map(r => `${r.recordId.slice(0, 8)}:${r.payload?.kind}`).join(', ')}`)
}

const FACE = { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 }
const BACK = '← back'
const prompt = (tag: string, text: string, awaitText: string, mark?: string): Send[] => [
  { data: `${tag}: ${text}\r`, atTick: 999, awaitText, requireAwait: true, minTick: 2, awaitSettleTicks: 2, ...(mark === undefined ? {} : { mark }) },
]

let transcript: string | null = null
let sessionId: string | null = null
let boardPath: string | null = null
const leadExecution = (): string | null => {
  if (boardPath === null || !existsSync(boardPath)) return null
  const db = new Database(boardPath, { readonly: true })
  try {
    const row = db.prepare("SELECT execution FROM members WHERE agent = 'main'").get() as { execution?: string } | null
    return typeof row?.execution === 'string' ? row.execution : null
  } catch {
    return null
  } finally {
    db.close()
  }
}
async function postWhenTheLeadIsBack(executionBefore: string | null, clientOpId: string, text: string): Promise<string> {
  if (boardPath === null || sessionId === null || !existsSync(boardPath)) return 'no board'
  await untilAsync(() => { const execution = leadExecution(); return execution !== null && execution !== executionBefore }, vshotBudgetMs(90_000), 200)
  const board = await import('../../src/services/crewBoard/store.ts')
  const store = board.open(boardPath, sessionId)
  try {
    const lane = { author: { sessionId, agentId: 'lane-paint', executionId: randomUUID() }, name: 'lane-paint' }
    store.enroll(lane)
    const receipt = store.post(lane, { clientOpId, kind: 'message', text, mentions: ['main'] })
    return receipt.ok === true ? `posted as event ${receipt.eventId} (seq ${receipt.seq}); lead deliveries on the board: ${store.leadPosts(0).length}` : `refused: ${receipt.reason}`
  } finally {
    store.close()
  }
}
async function dispatchWhenRecorded(needle: string, promptText: string): Promise<string> {
  if (transcript === null || sessionId === null) return 'no session'
  await untilAsync(() => replies(storeRows(transcript)).some(r => r.text.includes(needle)), vshotBudgetMs(120_000))
  await untilAsync(() => readFileSync(transcript, 'utf8').split('\n').some(line => line.includes(needle) && line.includes('"outcome"')), vshotBudgetMs(30_000))
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const reply = (await daemonControlRpc({ op: 'sessionDispatch', clientMessageId: randomUUID(), prompt: promptText, workspaceDir: '', targetSessionId: sessionId, by: 'operator' } as never, { timeoutMs: 15_000 })) as { ok?: boolean; error?: string }
  return reply.ok === true ? 'the daemon took the line' : `refused: ${reply.error ?? JSON.stringify(reply)}`
}

type Long = { tag: string; text: string; firstMark: string; end: string }
type Short = { tag: string; text: string; end: string }
async function resumedJourney(tag: string, dist: string, keptTail: string, post: { clientOpId: string; text: string; mark: string }, long: Long, short: Short): Promise<void> {
  const executionBefore = leadExecution()
  const posting = postWhenTheLeadIsBack(executionBefore, post.clientOpId, post.text)
  const dispatching = dispatchWhenRecorded(long.end, `${short.tag}: ${short.text}`)
  const run = await capture(tag, dist, ['--continue'], [
    { data: '', atTick: 999, awaitText: BACK, requireAwait: true, minTick: 4, awaitSettleTicks: 8, mark: 'boot' },
    { data: '', atTick: 999, awaitText: BACK, requireAwait: true, minTick: 2, awaitSettleTicks: 15, mark: 'posted' },
    ...prompt(long.tag, 'say it again', BACK),
    { data: '', atTick: 999, awaitText: long.firstMark, requireAwait: true, minTick: 2, mark: 'again-streaming' },
    { data: '', atTick: 999, awaitText: long.end, requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'again' },
    { data: '', atTick: 999, awaitText: short.end, requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'again-short' },
  ], short.end, 420)
  log(`the lane's post: ${await posting}`)
  log(`the line sent through the daemon: ${await dispatching}`)
  check(`${tag}: the resumed session ran its journey to the end`, run.endReason === 'stable' || run.endReason === 'ready', `endReason ${run.endReason} · ${run.receipts} sends fired · vshot exit ${run.status}`)
  const store = transcript === null ? [] : storeRows(transcript)
  const boot = run.frames.get('boot')
  check(`${tag}: the resumed screen holds the newest reply the store held before the resume`, boot !== undefined && paneText(boot).includes(collapse(keptTail)), boot === undefined ? 'no boot frame' : paneText(boot).slice(-300))
  const postFrame = run.frames.get('again') ?? run.frames.get('final')
  if (boardPath !== null && existsSync(boardPath) && BOARD_ROWS_IN_BUILD) check(`${tag}: the lane's post painted on the resumed screen as a board row`, postFrame !== undefined && paneText(postFrame).includes(post.mark), postFrame === undefined ? 'no frame' : paneText(postFrame).slice(-300))
  else if (boardPath !== null && existsSync(boardPath)) log('this build does not paint board posts as rows; the post stays on the board')
  const againStreaming = run.frames.get('again-streaming')
  check(`${tag}: the resumed reply streams onto the screen while it is being written`, againStreaming !== undefined && paneText(againStreaming).includes(long.firstMark.replace(/3$/, '1')), againStreaming === undefined ? 'no streaming frame' : paneText(againStreaming).slice(-200))
  judgeReply(`${tag} · the long reply`, run.frames.get('again'), long.text, store)
  judgeUserRow(`${tag} · the line sent through the daemon (the live view's road)`, run.frames.get('again-short'), `${short.tag}: ${short.text}`, store)
  judgeReply(`${tag} · the reply to the line sent through the daemon`, run.frames.get('again-short'), short.text, store)
  judgeChain(tag, transcript)
}

console.log('every assistant reply paints whole on the screen — streamed and final, in a fresh and a resumed session, with a tool turn and a compaction before the resume, a board post on the way back and a line sent through the daemon')
console.log(`  bundle ${DIST} (build tree ${distBuildTree(DIST)?.slice(0, 12) ?? 'unknown'}${BOARD_IN_BUILD ? (BOARD_ROWS_IN_BUILD ? ', with the crew board and its rows' : ', with the crew board') : ', before the crew board'})${SOURCE_REF !== undefined ? ` from --source-ref ${SOURCE_REF}` : ''}${CLIENT_DIST !== undefined ? `\n  older window ${CLIENT_DIST} (build tree ${distBuildTree(CLIENT_DIST)?.slice(0, 12) ?? 'unknown'})` : ''}\n  fixture ${api.url}\n  scratch ${SCRATCH}\n  frames ${FRAMES}`)

let daemon: ChildProcess | null = null
try {
  section('§0 the reader law — a live stretch rooted after the newest fold paints, in file order')
  {
    const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
    const vnext = await import('../../src/utils/sessionStorage/vnext.ts')
    const factories = await import('../../src/utils/messages/factories.ts')
    const systemMessages = await import('../../src/utils/messages/systemMessages.ts')
    const dir = join(SCRATCH, 'reader-law')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${randomUUID()}.jsonl`)
    let clock = Date.parse('2026-10-31T18:00:00.000Z')
    const tick = (): string => new Date((clock += 1000)).toISOString()
    type Row = Record<string, unknown> & { uuid: string }
    const names = new Map<string, string>()
    const keep = (name: string, row: Row): Row => {
      names.set(row.uuid, name)
      return row
    }
    const user = (name: string, text: string, parentUuid: string | null): Row => keep(name, { ...(factories.createUserMessage({ content: text }) as Row), parentUuid, isSidechain: false, timestamp: tick() })
    const assistant = (name: string, text: string, parentUuid: string | null): Row => keep(name, { ...(factories.createAssistantMessage({ content: [{ type: 'text', text, citations: [] }] }) as Row), parentUuid, isSidechain: false, timestamp: tick() })
    const write = (rows: Row[]): void => {
      for (const row of rows) appendFileSync(path, (vnext.encodeTranscriptLine(path, row) as { line: string }).line)
    }
    const named = (rows: ReadonlyArray<{ uuid: string }>): string[] => rows.map(r => names.get(r.uuid) ?? r.uuid.slice(0, 4))
    const u1 = user('u1', 'the first words, folded', null)
    const a1 = assistant('a1', 'the first reply, folded', u1.uuid)
    const B = keep('B', { ...(systemMessages.createCompactBoundaryMessage('manual', 1000) as Row), parentUuid: null, isSidechain: false, timestamp: tick() })
    const S = keep('S', { ...(factories.createUserMessage({ content: 'the summary of the folded stretch', isCompactSummary: true }) as Row), parentUuid: B.uuid, isSidechain: false, timestamp: tick() })
    const u2 = user('u2', 'words after the fold', S.uuid)
    const a2 = assistant('a2', 'the reply after the fold', u2.uuid)
    write([u1, a1, B, S, u2, a2])
    let chain = await reader.readTranscriptChainSince(path, null)
    check('the fold paints with the turn after it', JSON.stringify(named(chain.rows)) === JSON.stringify(['B', 'S', 'u2', 'a2']), JSON.stringify(named(chain.rows)))
    const n1 = user('n1', '<crew-board>{"name":"lane","kind":"message","text":"@main a post the resumed runner painted first"}</crew-board>', null)
    const u3 = user('u3', 'the words after the resume', n1.uuid)
    const a3 = assistant('a3', 'the reply after the resume', u3.uuid)
    write([n1, u3, a3])
    chain = await reader.readTranscriptChainSince(path, chain.cursor)
    check('a row written after the resume with no parent, and the turn chained onto it, paint after the kept rows in file order', JSON.stringify(named(chain.rows)) === JSON.stringify(['B', 'S', 'u2', 'a2', 'n1', 'u3', 'a3']), JSON.stringify(named(chain.rows)))
    const u4 = user('u4', 'a later line through the daemon', a3.uuid)
    const a4 = assistant('a4', 'its reply', u4.uuid)
    write([u4, a4])
    chain = await reader.readTranscriptChainSince(path, chain.cursor)
    check('every later turn on that stretch follows', JSON.stringify(named(chain.rows)) === JSON.stringify(['B', 'S', 'u2', 'a2', 'n1', 'u3', 'a3', 'u4', 'a4']), JSON.stringify(named(chain.rows)))
    reader._resetTranscriptReaderForTesting()
    const cold = await reader.readTranscriptChainSince(path, null)
    check('a cold read (a reattach) paints the same rows', JSON.stringify(named(cold.rows)) === JSON.stringify(named(chain.rows)), JSON.stringify(named(cold.rows)))
  }

  section('§1 a fresh session: a tool turn, a long streamed reply, the swarm switch, a compaction, a short reply')
  const fresh = await capture('fresh', DIST, [], [
    FACE,
    { data: '', atTick: 999, awaitText: BACK, requireAwait: true, minTick: 4, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'boot' },
    ...prompt('paint-tool-1', 'run the tool', BACK),
    { data: '', atTick: 999, awaitText: 'THE-TOOL-END', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'tool' },
    ...prompt('paint-long-1', 'say the long one', 'THE-TOOL-END'),
    { data: '', atTick: 999, awaitText: 'LONG-S3', requireAwait: true, minTick: 2, mark: 'long-streaming' },
    { data: '', atTick: 999, awaitText: 'THE-LONG-END', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'long' },
    ...(BOARD_IN_BUILD ? [{ data: '/swarm on\r', atTick: 999, awaitText: 'THE-LONG-END', requireAwait: true, minTick: 2, awaitSettleTicks: 8 }] : []),
    { data: '/compact\r', atTick: 999, awaitText: BACK, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
    { data: '', atTick: 999, awaitText: 'summary', requireAwait: true, minTick: 2, awaitSettleTicks: 12, mark: 'compacted' },
    ...prompt('paint-short-1', 'say the short one', BACK),
    { data: '', atTick: 999, awaitText: 'THE-SHORT-END', requireAwait: true, minTick: 2, awaitSettleTicks: 10, mark: 'short' },
  ], 'THE-SHORT-END', 480)
  check('the fresh session ran its journey to the end', fresh.endReason === 'stable' || fresh.endReason === 'ready', `endReason ${fresh.endReason} · ${fresh.receipts} sends fired · vshot exit ${fresh.status}`)
  transcript = newestTranscript()
  check('the session has a transcript', transcript !== null)
  const freshStore = transcript === null ? [] : storeRows(transcript)
  const streaming = fresh.frames.get('long-streaming')
  check('the long reply streams onto the screen while it is being written', streaming !== undefined && paneText(streaming).includes('LONG-S1'), streaming === undefined ? 'no streaming frame' : paneText(streaming).slice(-200))
  judgeReply('fresh · the long reply', fresh.frames.get('long'), LONG, freshStore)
  judgeReply('fresh · the words before the tool', fresh.frames.get('tool'), TOOL_PRE, freshStore)
  judgeReply('fresh · the reply after the tool', fresh.frames.get('tool'), TOOL_AFTER, freshStore)
  const compacted = fresh.frames.get('compacted')
  const boundaries = transcript === null ? 0 : readFileSync(transcript, 'utf8').split('\n').filter(l => l.includes('"kind":"boundary"') && l.includes('"boundaryKind":"compact"')).length
  check('the compaction landed: the store holds a compaction boundary and the screen names the summary', boundaries >= 1 && compacted !== undefined && paneText(compacted).includes('summary'), `${boundaries} boundary rows · ${compacted === undefined ? 'no compacted frame' : paneText(compacted).slice(-200)}`)
  judgeReply('fresh · the short reply after the compaction', fresh.frames.get('short'), SHORT, freshStore)
  sessionId = transcript === null ? null : (JSON.parse(readFileSync(transcript, 'utf8').split('\n')[0]!) as { sessionId: string }).sessionId
  boardPath = transcript === null || sessionId === null ? null : join(dirname(transcript), sessionId, 'boards', 'wave', 'board.sqlite')
  log(`board ${boardPath !== null && existsSync(boardPath) ? 'opened by the session' : BOARD_IN_BUILD ? 'absent after /swarm on' : 'not in this build (no crew board, no post)'}${boardPath === null ? '' : ` at ${boardPath}`}`)
  if (BOARD_IN_BUILD) check('the session opened its crew board on /swarm on', boardPath !== null && existsSync(boardPath), boardPath ?? 'no transcript')
  await untilAsync(() => transcript === null || !existsSync(`${transcript}.writer.lock`), vshotBudgetMs(30_000))

  section('§2 the same session resumed: a lane posts to the lead the moment the board is open again, a long streamed reply, a line sent through the daemon and its reply')
  await resumedJourney('resumed', DIST, SHORT, { clientOpId: 'paint-board-post-1', text: BOARD_POST, mark: 'PAINT-BOARD-POST' }, { tag: 'paint-long-2', text: AGAIN, firstMark: 'AGAIN-L3', end: 'THE-AGAIN-END' }, { tag: 'paint-short-2', text: SHORT_AGAIN, end: 'THE-SHORT-AGAIN-END' })

  if (CLIENT_DIST !== undefined) {
    section('§3 the older window: a window from the previous build keeps painting whole against a daemon on this build')
    await untilAsync(() => transcript === null || !existsSync(`${transcript}.writer.lock`), vshotBudgetMs(30_000))
    const logFd = openSync(join(SCRATCH, 'older-window-daemon.log'), 'a')
    daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env: childEnv, stdio: ['ignore', logFd, logFd] })
    const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
    const serving = await untilAsync(async () => ((await daemonControlRpc({ op: 'ping' } as never, { timeoutMs: 1000 })) as { ok?: boolean }).ok === true, vshotBudgetMs(60_000))
    check('a daemon on this build serves the older window', serving)
    await resumedJourney('older-window', CLIENT_DIST, SHORT_AGAIN, { clientOpId: 'paint-board-post-2', text: BOARD_POST_OLDER, mark: 'PAINT-BOARD-POST-TWO' }, { tag: 'paint-long-3', text: OLDER, firstMark: 'OLDER-R3', end: 'THE-OLDER-END' }, { tag: 'paint-short-3', text: SHORT_OLDER, end: 'THE-SHORT-OLDER-END' })
  }
} finally {
  if (daemon !== null) {
    try {
      const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 5000 })
    } catch {
    }
    daemon.kill('SIGTERM')
  }
  await api.close()
  if (failures === 0 && !KEEP && argAfter('--frames') === undefined) removeScratch(SCRATCH)
  else console.log(`\n  frames and transcripts kept at ${SCRATCH}`)
}

console.log(failures === 0 ? `\n✅ EVERY REPLY PAINTS WHOLE — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
