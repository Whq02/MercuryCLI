#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_HOME']) {
  delete process.env[ambient]
}
const SCRATCH = process.env.SCRATCHPAD ?? tmpdir()
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(SCRATCH, 'advise-switch-painter-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_OPERATOR = 'sam'
const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.REPRO_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const frameDir = ((): string | null => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]!) : null
})()

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the advise switch drive exceeded 600s')
  process.exit(1)
}, 600_000)
watchdog.unref?.()

const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('the bundle under proof and a node binary are present', false, `${DIST} node=${String(nodeBin)}`)
  process.exit(1)
}
console.log(`bundle under proof: ${DIST}`)

const AGENT_MODEL = 'claude-sonnet-5'
const ADVISOR_MODEL = 'claude-opus-5-5'
const MINUTES = 1
const CADENCE = `every ${MINUTES} minute`
const THINK = 4000
const NOTE_TOKENS = 60
const VENDOR_OUTPUT_CAP = 128_000
const NOTE = 'You have not run the pin on the base yet.\nRun it on the base before you edit, and keep what it prints.'
const EARLIER_NOTE = 'An earlier note, written an hour ago.'
const PLATE = '[advisor]'
const ADVISE_ON = '/advise on'
const SETTINGS_OFF_NOTE = 'off in the settings — /config → Advisor must be on for any chat to get notes'

const wire: Array<{ kind: 'agent' | 'advisor' | 'other'; model: string; path: string; body: Raw; at: number }> = []
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
const bodyText = (body: Raw): string => JSON.stringify(body.messages ?? '')
const lastOperatorLine = (body: Raw): string => {
  const items = Array.isArray(body.messages) ? (body.messages as Raw[]) : []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const content = item.content
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Raw[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')) : []
    const plain = texts.map(t => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(t => t !== '')
    const line = plain.find(t => /^[A-Z] line \d+$/.test(t.split('\n').at(-1) ?? '')) ?? plain.at(-1)
    if (line !== undefined) return line.split('\n').at(-1) ?? line
  }
  return 'nothing'
}
function agentReply(model: string, textOut: string): string {
  const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 }
  return [
    sse('message_start', { type: 'message_start', message: { id: `msg_agent_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: textOut } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}
function advisorReply(model: string, maxTokens: number): string {
  const start = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const out: string[] = [
    sse('message_start', { type: 'message_start', message: { id: `msg_advisor_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: start } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reading the rows since the last note before writing.' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (maxTokens < THINK + NOTE_TOKENS) {
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: maxTokens, output_tokens_details: { thinking_tokens: maxTokens } } }))
    out.push(sse('message_stop', { type: 'message_stop' }))
    return out.join('')
  }
  out.push(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  out.push(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: NOTE } }))
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: THINK + NOTE_TOKENS, output_tokens_details: { thinking_tokens: THINK } } }))
  out.push(sse('message_stop', { type: 'message_stop' }))
  return out.join('')
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Raw = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Raw
    } catch {
      body = {}
    }
    const model = String(body.model ?? '')
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      wire.push({ kind: 'other', model, path, body, at: Date.now() })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (model === ADVISOR_MODEL) {
      wire.push({ kind: 'advisor', model, path, body, at: Date.now() })
      const maxTokens = Number(body.max_tokens)
      if (!Number.isFinite(maxTokens) || maxTokens > VENDOR_OUTPUT_CAP) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > ${VENDOR_OUTPUT_CAP}, which is the maximum allowed number of output tokens for ${model}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(advisorReply(model, maxTokens))
      return
    }
    wire.push({ kind: model === AGENT_MODEL ? 'agent' : 'other', model, path, body, at: Date.now() })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(agentReply(model, `reply to ${lastOperatorLine(body)}`))
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
const FIXTURE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
const advisorRequestsAbout = (marker: string): typeof wire => wire.filter(w => w.kind === 'advisor' && bodyText(w.body).includes(marker))
const agentRequestsAbout = (marker: string): typeof wire => wire.filter(w => w.kind === 'agent' && bodyText(w.body).includes(marker))

const { setIsInteractive } = await import(join(ROOT, 'src/bootstrap/state.ts'))
setIsInteractive(false)
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const React = (await import('react')).default
const { render, Box } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { Message } = await import(join(ROOT, 'src/components/Message.tsx'))
const { normalizeMessages } = await import(join(ROOT, 'src/utils/messages/normalize.ts'))
const { buildMessageLookups } = await import(join(ROOT, 'src/utils/messages/lookups.ts'))
const { deserializeLiveMessages } = await import(join(ROOT, 'src/utils/conversationRecovery.ts'))
const reader = await import(join(ROOT, 'src/utils/sessionStorage/transcriptReader.ts'))
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const text = await import(join(ROOT, 'src/utils/messages/text.ts'))
const { projectSlug } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))
const { seedFirstRun } = await import(join(ROOT, 'scripts/lib/firstRunSeed.ts'))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

function fakeIo(columns: number, rowCount: number): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } {
  const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: rowCount, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  return { stdout, stdin }
}
async function paintChat(messages: Raw[], columns: number, rowCount: number): Promise<string[]> {
  const normalized = normalizeMessages([...(messages as never[])])
  const lookups = buildMessageLookups(normalized, [...(messages as never[])])
  const io = fakeIo(columns, rowCount)
  const body = h(
    Box as never,
    { flexDirection: 'column' },
    ...normalized.map(message =>
      h(Message as never, {
        key: message.uuid,
        message,
        messages: normalized,
        tools: [],
        commands: [],
        verbose: false,
        addMargin: false,
        shouldAnimate: false,
        shouldShowDot: false,
        isTranscriptMode: false,
        isStatic: true,
        inProgressToolUseIDs: new Set<string>(),
        progressMessagesForMessage: [],
        lookups,
        width: columns,
      }),
    ),
  )
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, body), { stdout: io.stdout, stdin: io.stdin, exitOnCtrlC: false, patchConsole: false })
  instance.unmount()
  await instance.waitUntilExit()
  return strip(instance.lastFrame()).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
}

interface Arena { home: string; configDir: string; cwd: string; env: Record<string, string> }
const HOME = mkdtempSync(join(SCRATCH, 'advise-switch-home-'))
function makeArena(): Arena {
  const configDir = join(HOME, 'config')
  const cwd = join(HOME, 'work')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(configDir, [cwd])
  writeFileSync(join(cwd, 'notes.txt'), 'the arena file\n')
  const dead: Record<string, string> = {}
  for (const key of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_UPDATE_API_BASE_URL', 'MERCURY_CUSTOM_OAUTH_URL']) dead[key] = 'http://127.0.0.1:1'
  return {
    home: HOME,
    configDir,
    cwd,
    env: {
      ...dead,
      HOME,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      BROWSER: '/usr/bin/true',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
      MERCURY_CREWS_DIR: join(HOME, 'crews'),
      MERCURY_TOOL_SEARCH: '0',
      MERCURY_ADVISOR_MODEL: ADVISOR_MODEL,
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: FIXTURE_URL,
    },
  }
}
const arena = makeArena()
const cfgPath = join(arena.configDir, '.mercury.json')
const settingsRow = (enabled: boolean): void => {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Raw
  cfg.advisor = enabled ? { enabled: true, minutes: MINUTES } : { minutes: MINUTES }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
}
const storedAdvisor = (): unknown => (JSON.parse(readFileSync(cfgPath, 'utf8')) as Raw).advisor
const projectDirOf = (): string => join(arena.configDir, 'projects', projectSlug(realpathSync(arena.cwd).normalize('NFC')))
const transcriptFileOf = (sid: string): string | null => {
  const root = join(arena.configDir, 'projects')
  if (!existsSync(root)) return null
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, `${sid}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}
const memoryOf = (sid: string): string => join(projectDirOf(), sid, 'advisor', `${sid}.jsonl`)
const rawRecordsOf = (file: string | null): Raw[] => (file !== null && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) as Raw } catch { return {} as Raw } }) : [])
function seedEarlierNote(sid: string): string {
  const file = memoryOf(sid)
  mkdirSync(dirname(file), { recursive: true })
  const at = new Date(Date.now() - 60 * 60_000).toISOString()
  writeFileSync(file, `${j({ schema: 1, kind: 'head', agentId: sid })}\n${j({ schema: 1, kind: 'note', at, text: EARLIER_NOTE, model: ADVISOR_MODEL })}\n`)
  return file
}
const notesOnDisk = (sid: string): number => rawRecordsOf(memoryOf(sid)).filter(r => r.kind === 'note' && r.text === NOTE).length
const memoryKindsOf = (sid: string): string[] => rawRecordsOf(memoryOf(sid)).map(r => String(r.kind ?? ''))
const switchRecordsOf = (sid: string): string[] => rawRecordsOf(transcriptFileOf(sid)).filter(r => JSON.stringify(r).includes('"metaKind":"advisor-switch"')).map(r => (JSON.stringify(r).includes('"on":true') ? 'on' : 'off'))

interface Run { exit: number | null; stdout: string; stderr: string; results: number; closedOn: string; frames: Raw[]; resultLines: string[] }
interface Session { sid: string; prompts: string[]; results: number; hold?: (nextIndex: number) => boolean; identity?: 'new' | 'resume'; argv?: string[]; deadlineMs?: number }
function runSession(s: Session): Promise<Run> {
  const identity = s.identity ?? 'new'
  const deadlineMs = s.deadlineMs ?? 120_000
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', AGENT_MODEL, '--permission-mode', 'sovereign', identity === 'resume' ? '--resume' : '--session-id', s.sid, ...(s.argv ?? [])], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    let sent = 0
    let results = 0
    let closed = false
    let closedOn = ''
    let owed = 0
    const started = Date.now()
    const close = (why: string): void => {
      if (closed) return
      closed = true
      closedOn = why
      clearInterval(poll)
      child.stdin.end()
    }
    const sendNext = (): void => {
      if (sent >= s.prompts.length) return
      const prompt = s.prompts[sent]!
      sent++
      child.stdin.write(`${j({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
    }
    const release = (): void => {
      while (owed > 0 && sent < s.prompts.length) {
        if (s.hold !== undefined && !s.hold(sent)) return
        owed--
        sendNext()
      }
    }
    child.stdout.on('data', d => {
      stdout += d
      const seen = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
      while (results < seen) {
        results++
        owed++
      }
      release()
    })
    child.stderr.on('data', d => (stderr += d))
    const poll = setInterval(() => {
      release()
      if (results >= s.results) close(`${s.results} results`)
      else if (Date.now() - started > deadlineMs) close(`the ${deadlineMs} ms deadline`)
    }, 50)
    const killer = setTimeout(() => child.kill('SIGKILL'), deadlineMs + 60_000)
    child.on('close', exit => {
      clearTimeout(killer)
      clearInterval(poll)
      const frames = stdout.split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) as Raw } catch { return {} as Raw } })
      const resultLines = frames.filter(f => f.type === 'result' && typeof f.result === 'string').map(f => String(f.result))
      resolvePromise({ exit, stdout, stderr, results, closedOn, frames, resultLines })
    })
    child.on('spawn', () => sendNext())
  })
}
const chatRowsOf = async (file: string): Promise<Raw[]> => {
  const chain = await reader.readTranscriptChainSince(file, null)
  return deserializeLiveMessages(chain.rows as never) as unknown as Raw[]
}
const contentOf = (row: Raw): string => {
  const content = (row.message as Raw | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => (typeof (b as Raw).text === 'string' ? String((b as Raw).text) : '')).join('')
  return ''
}
const isNoteRow = (r: Raw): boolean => r.type === 'attachment' && (r.attachment as Raw | undefined)?.type === 'queued_command' && rows.isAdvisorOrigin((r.attachment as Raw).origin)
const shapeOf = (chat: Raw[]): string[] => chat.map(r => (isNoteRow(r) ? 'note' : r.type === 'user' ? `user:${contentOf(r).slice(0, 12)}` : String(r.type)))
const adviseLinesOf = (run: Run): string[] => run.resultLines.filter(l => l.startsWith('advisor '))
const frameScenes: Array<[string, string, Raw[]]> = []
const printFrame = async (chat: Raw[], name: string): Promise<void> => {
  const frame = await paintChat(chat, 120, 40)
  console.log(`  ── the chat as painted (${name}, 120 columns) ──`)
  for (const line of frame) console.log(`    ${line}`)
}
const exitWords = (run: Run): string => `exit=${run.exit} results=${run.results} closedOn=${run.closedOn} stderr=${run.stderr.slice(-300)}`

const A = 'c0ffee00-0000-4000-8000-00000000ad10'
const B = 'c0ffee00-0000-4000-8000-00000000ad11'
const E = 'c0ffee00-0000-4000-8000-00000000ad12'
const F = 'c0ffee00-0000-4000-8000-00000000ad13'

section(`§1 TWO SESSIONS SIDE BY SIDE on one config home with the settings on (${CADENCE}, ${ADVISOR_MODEL} pinned by MERCURY_ADVISOR_MODEL): ${ADVISE_ON} in A, nothing in B; both memories hold an hour-old note so either would be due; turns are driven in both — A receives an [advisor] note at its boundary, B stays quiet with no advisor call on the fixture; then (§2) the settings row goes off and a minute later neither makes a further call`)
settingsRow(true)
const memoryA = seedEarlierNote(A)
seedEarlierNote(B)
let settingsOffAt = 0
const waitedAMinute = (): boolean => settingsOffAt !== 0 && Date.now() - settingsOffAt >= (MINUTES * 60_000 + 5_000)
const noteLandedInA = (): boolean => notesOnDisk(A) >= 1
const holdA = (next: number): boolean => {
  if (next === 2) return noteLandedInA()
  if (next === 3) {
    if (!noteLandedInA()) return false
    if (settingsOffAt === 0) {
      settingsRow(false)
      settingsOffAt = Date.now()
      console.log(`  the settings row went off at ${new Date(settingsOffAt).toISOString()} — the file now holds ${j(storedAdvisor())}`)
    }
    return waitedAMinute()
  }
  return true
}
const holdB = (next: number): boolean => (next === 2 ? waitedAMinute() : true)
const [runA, runB] = await Promise.all([
  runSession({ sid: A, prompts: [ADVISE_ON, 'A line 1', 'A line 2', 'A line 3'], results: 4, hold: holdA, deadlineMs: 240_000 }),
  runSession({ sid: B, prompts: ['B line 1', 'B line 2', 'B line 3'], results: 3, hold: holdB, deadlineMs: 240_000 }),
])
check(`A took ${ADVISE_ON} and three turns, exit 0 (closed on ${runA.closedOn})`, runA.exit === 0 && runA.results === 4, exitWords(runA))
check(`B took three turns, exit 0 (closed on ${runB.closedOn})`, runB.exit === 0 && runB.results === 3, exitWords(runB))
check(`A's ${ADVISE_ON} answered the state line: on for this chat, the model, ${CADENCE}`, adviseLinesOf(runA)[0] === `advisor on for this chat · ${ADVISOR_MODEL} · ${CADENCE}`, j(adviseLinesOf(runA)))
console.log(`  A's /advise line: ${adviseLinesOf(runA)[0] ?? '(none)'}`)
const advisorA = advisorRequestsAbout('A line 1')
const advisorB = advisorRequestsAbout('B line')
check("A: ONE advisor request left the box, at A line 1's end, reading A's rows under the advisor's system prompt", advisorA.length === 1 && j(advisorA[0]!.body.system).includes('You are the Advisor') && bodyText(advisorA[0]!.body).includes(EARLIER_NOTE), j(advisorA.map(w => bodyText(w.body).slice(0, 160))))
check('B: NO advisor request carried any of B\'s rows — the settings on alone spend nothing on a chat that did not say /advise on', advisorB.length === 0 && wire.filter(w => w.kind === 'advisor').length === advisorA.length, j(wire.filter(w => w.kind === 'advisor').map(w => bodyText(w.body).slice(0, 120))))
check("B's seeded memory is untouched — nothing opened it", memoryKindsOf(B).join(',') === 'head,note', j(memoryKindsOf(B)))
const fileA = transcriptFileOf(A)
const chatA = fileA === null ? [] : await chatRowsOf(fileA)
const noteRowsA = chatA.filter(isNoteRow)
const lineTwoAt = chatA.findIndex(r => r.type === 'user' && contentOf(r) === 'A line 2')
check("A's chat carries ONE [advisor] note row, inside the A line 2 turn — beside the prompt, before the reply that reads it", noteRowsA.length === 1 && lineTwoAt >= 0 && chatA.indexOf(noteRowsA[0]!) > lineTwoAt && chatA[chatA.indexOf(noteRowsA[0]!) + 1]?.type === 'assistant', j(shapeOf(chatA)))
const agentA2 = agentRequestsAbout('A line 2')
check("the request that answered A line 2 carried the note framed as advice from a second model, never as the operator's words", agentA2.length >= 1 && bodyText(agentA2[0]!.body).includes(text.ADVISOR_NOTE_HEAD) && bodyText(agentA2[0]!.body).includes(NOTE.split('\n')[0]!) && !bodyText(agentA2[0]!.body).includes('The operator sent a new message'), bodyText(agentA2[0]?.body ?? {}).slice(-200))
const fileB = transcriptFileOf(B)
const chatB = fileB === null ? [] : await chatRowsOf(fileB)
check("B's chat carries no advisor row at all", chatB.filter(isNoteRow).length === 0 && chatB.every(r => !(r.type === 'system' && r.subtype === 'advisor_quiet')), j(shapeOf(chatB)))
{
  const frame = await paintChat(chatA, 120, 40)
  const plateAt = frame.findIndex(l => l.includes(`${PLATE} · ${ADVISOR_MODEL} · ${CADENCE}`))
  check(`A's chat paints the muted ${PLATE} plate with the model and the cadence beneath A line 2`, plateAt > 0 && frame.slice(0, plateAt).some(l => l.includes('A line 2')) && (frame[plateAt + 1] ?? '').trim() === NOTE.split('\n')[0], frame.join('\n'))
  await printFrame(chatA, 'session A')
  frameScenes.push(['advise-switch-a', "session A: /advise on, then the note lands beside A line 2", chatA])
  frameScenes.push(['advise-switch-b', 'session B: three turns and never an advisor row', chatB])
}

section(`§2 THE SETTINGS OFF STOPPED BOTH: the row's write landed while both sessions stood; a minute and more later A line 3 and B line 3 ran, and neither made an advisor call`)
check('the settings write happened after A\'s note and before the last turns', settingsOffAt !== 0 && advisorA[0]!.at < settingsOffAt, j({ settingsOffAt, noteAt: advisorA[0]?.at }))
const lateAdvisor = wire.filter(w => w.kind === 'advisor' && w.at > settingsOffAt)
check('no advisor request left the box after the settings went off — from A (on, and due again) or from B', lateAdvisor.length === 0 && agentRequestsAbout('A line 3').length === 1 && agentRequestsAbout('B line 3').length === 1, j(lateAdvisor.map(w => bodyText(w.body).slice(0, 120))))
check("A's memory holds exactly the one note of this life beside the seeded one", notesOnDisk(A) === 1 && memoryKindsOf(A).join(',') === 'head,note,digest,note', j(memoryKindsOf(A)))
check("A's record carries its switch on (the chat's own switch stands through the settings going off)", switchRecordsOf(A).length >= 1 && switchRecordsOf(A).every(s => s === 'on') && switchRecordsOf(B).length === 0, j({ a: switchRecordsOf(A), b: switchRecordsOf(B) }))

section(`§3 THE ON-SESSION RESUMED: the settings back on (which turns no chat on), then -p --resume of A: bare /advise says on for this chat, and with its memory's notes aged an hour the next note lands inside the next turn`)
settingsRow(true)
{
  const aged = rawRecordsOf(memoryA).map(r => (r.kind === 'note' ? { ...r, at: new Date(Date.now() - 60 * 60_000).toISOString() } : r))
  writeFileSync(memoryA, `${aged.map(r => j(r)).join('\n')}\n`)
}
const wireBefore = wire.length
let secondNoteAt = 0
const resumed = await runSession({ sid: A, prompts: ['/advise', 'A line 4', 'A line 5'], results: 3, identity: 'resume', hold: next => {
  if (next !== 1) return true
  if (notesOnDisk(A) < 2) return false
  if (secondNoteAt === 0) secondNoteAt = Date.now()
  return Date.now() - secondNoteAt >= 400
} })
check(`the resumed A took bare /advise and two turns, exit 0 (closed on ${resumed.closedOn})`, resumed.exit === 0 && resumed.results === 3, exitWords(resumed))
check("bare /advise on the resumed session says on for this chat — nobody typed /advise on in this life", adviseLinesOf(resumed)[0] === `advisor on for this chat · ${ADVISOR_MODEL} · ${CADENCE}`, j(adviseLinesOf(resumed)))
console.log(`  the resumed A's /advise line: ${adviseLinesOf(resumed)[0] ?? '(none)'}`)
const resumedAdvisor = wire.slice(wireBefore).filter(w => w.kind === 'advisor')
check("one advisor request in the resumed life, composed at the bare /advise boundary (the memory's note an hour old), reading the rows the first life never digested (A line 2, A line 3) and never A line 4", resumedAdvisor.length === 1 && bodyText(resumedAdvisor[0]!.body).includes('A line 3') && !bodyText(resumedAdvisor[0]!.body).includes('A line 1') && !bodyText(resumedAdvisor[0]!.body).includes('A line 4'), j(resumedAdvisor.map(w => bodyText(w.body).slice(0, 160))))
const chatA2 = fileA === null ? [] : await chatRowsOf(fileA)
const noteRowsA2 = chatA2.filter(isNoteRow)
const lineFourAt = chatA2.findIndex(r => r.type === 'user' && contentOf(r) === 'A line 4')
const replyAfterFour = chatA2.findIndex((r, i) => i > lineFourAt && r.type === 'assistant')
check('the second note landed inside the A line 4 turn of the resumed life — after the prompt, before the reply that reads it', noteRowsA2.length === 2 && lineFourAt >= 0 && chatA2.indexOf(noteRowsA2[1]!) > lineFourAt && chatA2.indexOf(noteRowsA2[1]!) < replyAfterFour, j(shapeOf(chatA2)))
await printFrame(chatA2.slice(Math.max(0, lineFourAt - 4)), 'session A resumed, from A line 4')
frameScenes.push(['advise-switch-a-resumed', 'session A resumed: bare /advise says on, the next note lands beside A line 4', chatA2])

section(`§4 HEADLESS: a -p run with --advise gets a note; the same run without the flag, the settings on, makes no advisor call`)
seedEarlierNote(E)
seedEarlierNote(F)
const wireBeforeE = wire.length
const runE = await runSession({ sid: E, prompts: ['E line 1', 'E line 2'], results: 2, argv: ['--advise'], hold: next => next !== 1 || notesOnDisk(E) >= 1 })
check(`E (--advise) took two turns, exit 0 (closed on ${runE.closedOn})`, runE.exit === 0 && runE.results === 2, exitWords(runE))
const advisorE = wire.slice(wireBeforeE).filter(w => w.kind === 'advisor')
const chatE = ((): Promise<Raw[]> => { const f = transcriptFileOf(E); return f === null ? Promise.resolve([]) : chatRowsOf(f) })()
check('E: one advisor request and the note inside the second turn; the record carries the switch on', advisorE.length === 1 && notesOnDisk(E) === 1 && (await chatE).filter(isNoteRow).length === 1 && switchRecordsOf(E).every(s => s === 'on') && switchRecordsOf(E).length >= 1, j({ advisor: advisorE.length, notes: notesOnDisk(E), switches: switchRecordsOf(E) }))
const wireBeforeF = wire.length
const runF = await runSession({ sid: F, prompts: ['F line 1', 'F line 2'], results: 2 })
check(`F (no flag) took two turns, exit 0 (closed on ${runF.closedOn})`, runF.exit === 0 && runF.results === 2, exitWords(runF))
const advisorF = wire.slice(wireBeforeF).filter(w => w.kind === 'advisor')
check('F: no advisor call, no note, no switch record — the settings on alone do nothing for a headless run', advisorF.length === 0 && notesOnDisk(F) === 0 && memoryKindsOf(F).join(',') === 'head,note' && switchRecordsOf(F).length === 0, j({ advisor: advisorF.length, kinds: memoryKindsOf(F) }))
check('nothing went anywhere but the two models on the fixture', wire.every(w => w.kind !== 'other'), j(wire.filter(w => w.kind === 'other').map(w => [w.path, w.model])))

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const index: string[] = ["the advise switch drive's frames — the real runner's transcripts as the chat paints them", '']
  for (const [name, words, messages] of frameScenes) {
    for (const [columns, rowCount] of [[178, 51], [120, 40]] as Array<[number, number]>) {
      const frame = await paintChat(messages, columns, rowCount)
      const fileName = `${name}-${columns}x${rowCount}.txt`
      writeFileSync(join(frameDir, fileName), `${frame.join('\n')}\n`)
      index.push(`${fileName}: ${words}`)
      console.log(`  wrote ${fileName} (${frame.length} lines)`)
    }
  }
  writeFileSync(join(frameDir, 'advise-switch-index.txt'), `${index.join('\n')}\n`)
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advise switch drive: ${checks - failures}/${checks} checks passed · home ${HOME}`)
process.exit(failures === 0 ? 0 : 1)
