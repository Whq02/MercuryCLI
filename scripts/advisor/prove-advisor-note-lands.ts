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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(SCRATCH, 'advisor-lands-painter-'))
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
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — advisor note-lands prover exceeded 300s')
  process.exit(1)
}, 300_000)
watchdog.unref?.()

const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('the bundle under proof and a node binary are present', false, `${DIST} node=${String(nodeBin)}`)
  process.exit(1)
}
console.log(`bundle under proof: ${DIST}`)

const AGENT_MODEL = 'claude-sonnet-5'
const ADVISOR_MODEL = 'claude-opus-5-5'
const MINUTES = 3
const THINK = 4000
const NOTE_TOKENS = 60
const VENDOR_OUTPUT_CAP = 128_000
const NOTE = 'You have not run the pin on the base yet.\nRun it on the base before you edit, and keep what it prints.'
const EARLIER_NOTE = 'An earlier note, written an hour ago.'
const QUIET_WORDS = 'had nothing to say this round — answered with no text, twice'
const PLATE = '[advisor]'
const CADENCE = `every ${MINUTES} minutes`
const ADVISE_ON = '/advise on'
const adviseLineOf = (run: { frames: Raw[] }): string => String(run.frames.find(f => f.type === 'result' && typeof f.result === 'string' && String(f.result).startsWith('advisor '))?.result ?? '')
const HANDLE = '[sam]'
const DOT = '●'

type AdvisorMode = 'note' | 'empty'
let advisorMode: AdvisorMode = 'note'
let agentReplies = 0
let agentScript: Array<{ read: string } | { text: string }> = []
let agentDelayMs = 0
const wire: Array<{ kind: 'agent' | 'advisor' | 'other'; model: string; path: string; body: Raw }> = []
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
const bodyText = (body: Raw): string => JSON.stringify(body.messages ?? '')
function agentReply(model: string, text: string): string {
  const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 }
  return [
    sse('message_start', { type: 'message_start', message: { id: `msg_agent_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}
function agentToolReply(model: string, filePath: string): string {
  const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 }
  return [
    sse('message_start', { type: 'message_start', message: { id: `msg_agent_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu_read_${wire.length}`, name: 'Read', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: filePath }) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}
function advisorReply(model: string, maxTokens: number, mode: AdvisorMode): string {
  const start = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const out: string[] = [
    sse('message_start', { type: 'message_start', message: { id: `msg_advisor_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: start } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reading the rows since the last note before writing.' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (mode === 'empty') {
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 30 } } }))
    out.push(sse('message_stop', { type: 'message_stop' }))
    return out.join('')
  }
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
      wire.push({ kind: 'other', model, path, body })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (model === ADVISOR_MODEL) {
      wire.push({ kind: 'advisor', model, path, body })
      const maxTokens = Number(body.max_tokens)
      if (!Number.isFinite(maxTokens) || maxTokens > VENDOR_OUTPUT_CAP) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > ${VENDOR_OUTPUT_CAP}, which is the maximum allowed number of output tokens for ${model}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(advisorReply(model, maxTokens, advisorMode))
      return
    }
    wire.push({ kind: model === AGENT_MODEL ? 'agent' : 'other', model, path, body })
    const step = agentScript[agentReplies] ?? { text: `reply ${agentReplies + 1}` }
    agentReplies++
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('read' in step ? agentToolReply(model, step.read) : agentReply(model, step.text))
    }
    if (agentDelayMs > 0) setTimeout(answer, agentDelayMs)
    else answer()
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
const FIXTURE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

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
function makeArena(name: string): Arena {
  const home = mkdtempSync(join(SCRATCH, `advisor-lands-${name}-`))
  const configDir = join(home, 'config')
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(configDir, [cwd])
  const cfgPath = join(configDir, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Raw
  cfg.advisor = { enabled: true, minutes: MINUTES }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
  writeFileSync(join(cwd, 'notes.txt'), 'the arena file the agent reads\n')
  const dead: Record<string, string> = {}
  for (const key of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_AUTH_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_UPDATE_API_BASE_URL', 'MERCURY_CUSTOM_OAUTH_URL']) dead[key] = 'http://127.0.0.1:1'
  return {
    home,
    configDir,
    cwd,
    env: {
      ...dead,
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      BROWSER: '/usr/bin/true',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
      MERCURY_TOOL_SEARCH: '0',
      MERCURY_ADVISOR_MODEL: ADVISOR_MODEL,
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: FIXTURE_URL,
    },
  }
}
function transcriptFileOf(arena: Arena, sid: string): string | null {
  const root = join(arena.configDir, 'projects')
  if (!existsSync(root)) return null
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, `${sid}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}
const advisorMemoryOf = (file: string, sid: string): string => join(dirname(file), sid, 'advisor', `${sid}.jsonl`)
const rawRecordsOf = (file: string | null): Raw[] => (file !== null && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) as Raw } catch { return {} as Raw } }) : [])
const projectDirOf = (arena: Arena): string => join(arena.configDir, 'projects', projectSlug(realpathSync(arena.cwd).normalize('NFC')))
function seedEarlierNote(arena: Arena, sid: string): string {
  const file = join(projectDirOf(arena), sid, 'advisor', `${sid}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  const at = new Date(Date.now() - 60 * 60_000).toISOString()
  writeFileSync(file, `${j({ schema: 1, kind: 'head', agentId: sid })}\n${j({ schema: 1, kind: 'note', at, text: EARLIER_NOTE, model: ADVISOR_MODEL })}\n`)
  return file
}
const noteOnDisk = (memory: string): boolean => rawRecordsOf(memory).some(r => r.kind === 'note' && r.text === NOTE)

interface Run { exit: number | null; stdout: string; stderr: string; results: number; closedOn: string; frames: Raw[] }
function runSession(arena: Arena, sid: string, prompts: string[], closeWhen: { results: number; also?: () => boolean; label: string }, deadlineMs: number, holdNextUntil?: (nextIndex: number) => boolean, identity: 'new' | 'resume' = 'new'): Promise<Run> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', AGENT_MODEL, '--permission-mode', 'sovereign', identity === 'resume' ? '--resume' : '--session-id', sid], { cwd: arena.cwd, env: arena.env })
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
      if (sent >= prompts.length) return
      const prompt = prompts[sent]!
      sent++
      child.stdin.write(`${j({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
    }
    const release = (): void => {
      while (owed > 0 && sent < prompts.length) {
        if (holdNextUntil !== undefined && !holdNextUntil(sent)) return
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
      if (results >= closeWhen.results && (closeWhen.also?.() ?? true)) close(closeWhen.label)
      else if (Date.now() - started > deadlineMs) close(`the ${deadlineMs} ms deadline`)
    }, 50)
    const killer = setTimeout(() => child.kill('SIGKILL'), deadlineMs + 60_000)
    child.on('close', exit => {
      clearTimeout(killer)
      clearInterval(poll)
      const frames = stdout.split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) as Raw } catch { return {} as Raw } })
      resolvePromise({ exit, stdout, stderr, results, closedOn, frames })
    })
    child.on('spawn', () => sendNext())
  })
}
const chatRowsOf = async (file: string): Promise<Raw[]> => {
  const chain = await reader.readTranscriptChainSince(file, null)
  console.log(`  the chat's reader: ${chain.rows.length} chain rows from ${rawRecordsOf(file).length} records at ${file}`)
  return deserializeLiveMessages(chain.rows as never) as unknown as Raw[]
}
const memoryKindsOf = (file: string | null, sid: string): string[] => (file === null ? [] : rawRecordsOf(advisorMemoryOf(file, sid)).map(r => String(r.kind ?? '')))
const contentOf = (row: Raw): string => {
  const content = (row.message as Raw | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => (typeof (b as Raw).text === 'string' ? String((b as Raw).text) : '')).join('')
  return ''
}
const frameScenes: Array<[string, string, Raw[]]> = []

const isNoteRow = (r: Raw): boolean => r.type === 'attachment' && (r.attachment as Raw | undefined)?.type === 'queued_command' && rows.isAdvisorOrigin((r.attachment as Raw).origin)
const noteWordsOf = (r: Raw): string => String((r.attachment as Raw).prompt)
const shapeOf = (chat: Raw[]): string[] => chat.map(r => (isNoteRow(r) ? 'note' : r.type === 'user' ? `user:${contentOf(r).slice(0, 15)}` : String(r.type)))
const paintsTheNote = async (chat: Raw[], beneathWords: string, sceneWords: string): Promise<void> => {
  for (const [columns, rowCount] of [[178, 51], [80, 21]] as Array<[number, number]>) {
    const frame = await paintChat(chat, columns, rowCount)
    const plateAt = frame.findIndex(l => l.includes(`${PLATE} · ${ADVISOR_MODEL} · ${CADENCE}`))
    check(`${columns} columns: the chat paints the muted [advisor] plate with the model and the minutes cadence, beneath ${beneathWords} (red on the base: turns, or no plate)`, plateAt > 0 && frame.slice(0, plateAt).some(l => l.includes(sceneWords)), frame.join('\n'))
    check(`${columns} columns: the note's two lines stand beneath the plate`, plateAt >= 0 && (frame[plateAt + 1] ?? '').trim() === NOTE.split('\n')[0] && (frame[plateAt + 2] ?? '').trim() === NOTE.split('\n')[1], frame.slice(plateAt, plateAt + 3).join('\n'))
    check(`${columns} columns: no accent dot and no operator handle on the advisor row`, plateAt >= 0 && !frame[plateAt]!.includes(DOT) && !frame[plateAt]!.includes(HANDLE), frame[plateAt] ?? '')
    if (columns === 178) console.log(frame.map(l => `    ${l}`).join('\n'))
  }
}

section(`§1 A NOTE COMPOSED AT A TURN'S END LANDS INSIDE THE NEXT TURN: the real headless runner with the settings on in its home and ${ADVISE_ON} typed as the chat's first line, ${ADVISOR_MODEL} advising ${AGENT_MODEL} ${CADENCE} with its memory holding an hour-old note, the advisor thinking ${THINK} tokens before it writes — the note composed after turn 1 lands beside the operator's second prompt as an attachment row with the advisor origin, framed for the model as advice from a second model, and the agent takes no extra turn (red on the base: the note was queued as a prompt and started a turn of its own)`)
{
  advisorMode = 'note'
  agentScript = []
  const arena = makeArena('note')
  const SID = 'c0ffee00-0000-4000-8000-00000000ad01'
  const memory = seedEarlierNote(arena, SID)
  const prompts = [ADVISE_ON, 'operator line 1', 'operator line 2', 'operator line 3']
  let releasedAt = 0
  const run = await runSession(arena, SID, prompts, { results: 4, label: 'four results' }, 60_000, next => {
    if (next !== 2) return true
    if (!noteOnDisk(memory)) return false
    if (releasedAt === 0) releasedAt = Date.now()
    return Date.now() - releasedAt >= 400
  })
  check(`the session took ${ADVISE_ON} and the three operator turns and no more, then exit 0 (closed on ${run.closedOn}) — the note cost the agent no turn`, run.exit === 0 && run.results === 4 && adviseLineOf(run) === `advisor on for this chat · ${ADVISOR_MODEL} · ${CADENCE}`, `exit=${run.exit} results=${run.results} closedOn=${run.closedOn} stderr=${run.stderr.slice(-400)}`)
  const advisorRequests = wire.filter(w => w.kind === 'advisor')
  const agentRequests = wire.filter(w => w.kind === 'agent')
  check(`ONE advisor request left the box — at turn 1's end, the hour-old note making it due — on ${ADVISOR_MODEL}, under the advisor's system prompt, carrying the first operator row and the earlier note as memory; the later turn ends were within the interval`, advisorRequests.length === 1 && j(advisorRequests[0]!.body.system).includes('You are the Advisor') && bodyText(advisorRequests[0]!.body).includes('operator line 1') && !bodyText(advisorRequests[0]!.body).includes('operator line 2') && bodyText(advisorRequests[0]!.body).includes(EARLIER_NOTE), j(advisorRequests.map(w => [w.model, w.body.max_tokens, bodyText(w.body).slice(0, 200)])))
  const body = advisorRequests[0]?.body ?? {}
  check("that request rides the model's own ceiling with no thinking key (the always-on law) — red on the base: max_tokens 1200", body.max_tokens === VENDOR_OUTPUT_CAP && !('thinking' in body), j({ max: body.max_tokens, thinking: body.thinking }))
  check("the agent made three requests, one per operator turn; the second carries the note framed as advice from the advisor, the first does not, and none carries the note as the operator's words", agentRequests.length === 3 && !bodyText(agentRequests[0]!.body).includes(NOTE.split('\n')[0]!) && bodyText(agentRequests[1]!.body).includes(text.ADVISOR_NOTE_HEAD) && bodyText(agentRequests[1]!.body).includes(NOTE.split('\n')[0]!) && agentRequests.every(w => !bodyText(w.body).includes('The operator sent a new message')), `${agentRequests.length}: ${agentRequests.map(w => bodyText(w.body).slice(-160)).join(' | ')}`)
  check('no request went anywhere but the two models (nothing to a usage or catalogue door)', wire.every(w => w.kind !== 'other'), j(wire.filter(w => w.kind === 'other').map(w => [w.path, w.model])))
  const file = transcriptFileOf(arena, SID)
  check("the session's transcript file exists under the arena's projects, in the store the seed named", file !== null && file === join(projectDirOf(arena), `${SID}.jsonl`), `${arena.configDir} · ${file}`)
  const chat = file === null ? [] : await chatRowsOf(file)
  const operatorRows = chat.filter(r => r.type === 'user' && contentOf(r).startsWith('operator line'))
  const noteRows = chat.filter(isNoteRow)
  const note = noteRows[0]
  const noteAt = note === undefined ? -1 : chat.indexOf(note)
  const secondPromptAt = chat.indexOf(operatorRows[1]!)
  const replyAfterSecond = chat.findIndex((r, i) => i > secondPromptAt && r.type === 'assistant')
  check(`the chat's own reader hands back the three operator rows and ONE advisor row — an attachment row with origin { advisor, ${ADVISOR_MODEL}, minutes ${MINUTES} } and the note whole — inside the second turn: after the second operator row, among the prompt's attachment rows, before the reply that reads it (red on the base: a user row the advisor started a turn with)`, operatorRows.length === 3 && noteRows.length === 1 && note !== undefined && ((note.attachment as Raw).origin as Raw).model === ADVISOR_MODEL && ((note.attachment as Raw).origin as Raw).minutes === MINUTES && noteWordsOf(note) === NOTE && noteAt > secondPromptAt && noteAt < replyAfterSecond && chat[noteAt + 1]?.type === 'assistant', j(shapeOf(chat)))
  check('no user row anywhere carries the advisor origin: the note never started a turn', chat.every(r => !(r.type === 'user' && rows.isAdvisorOrigin(r.origin))))
  check('no quiet row was written for a round that landed a note', chat.every(r => !(r.type === 'system' && r.subtype === 'advisor_quiet')))
  const kinds = memoryKindsOf(file, SID)
  check("the advisor's own record beside the transcript holds the seeded note, then the digest and the new note (the record a live run is read by)", kinds.join(',') === 'head,note,digest,note' && rawRecordsOf(memory).some(r => r.kind === 'note' && r.text === NOTE && r.model === ADVISOR_MODEL), j(kinds))
  const stdoutNote = run.frames.find(f => f.type === 'user' && rows.isAdvisorOrigin((f as Raw).origin ?? ((f.message as Raw | undefined) ?? {}).origin))
  console.log(`  the stream-json host saw ${run.frames.filter(f => f.type === 'result').length} result frames; an advisor-origin user frame on stdout: ${stdoutNote !== undefined ? 'yes' : 'no'}`)
  await paintsTheNote(chat, "the operator's second prompt", 'operator line 2')
  frameScenes.push(['advisor-note-lands', "the real runner's transcript: the note composed at turn 1's end lands beside the operator's second prompt as the muted row, then the reply that reads it", chat])
  wire.length = 0
  agentReplies = 0
}

section(`§1c A RESUMED SESSION REMEMBERS ITS SWITCH: the §1 session comes back through -p --resume; bare /advise says on for this chat without anyone saying /advise on again, and with its memory's notes aged an hour the advisor reads the turns it never saw and the note lands inside the next turn (red on the base: no per-chat switch to remember)`)
{
  advisorMode = 'note'
  agentScript = []
  const arena = makeArena('resume')
  const SID = 'c0ffee00-0000-4000-8000-00000000ad06'
  const memory = seedEarlierNote(arena, SID)
  const first = await runSession(arena, SID, [ADVISE_ON, 'operator line 1', 'operator line 2'], { results: 3, label: 'three results' }, 60_000, next => next !== 2 || noteOnDisk(memory))
  check(`the first life took ${ADVISE_ON} and two turns, exit 0, one note on disk`, first.exit === 0 && first.results === 3 && noteOnDisk(memory), j({ exit: first.exit, results: first.results, stderr: first.stderr.slice(-300) }))
  const file = transcriptFileOf(arena, SID)
  const switches = rawRecordsOf(file).filter(r => JSON.stringify(r).includes('"metaKind":"advisor-switch"'))
  check("the session's own record carries the switch as an advisor-switch entry reading on (red on the base: no such record)", file !== null && switches.length >= 1 && switches.every(r => JSON.stringify(r).includes('"on":true')), j(switches.map(r => JSON.stringify(r).slice(0, 160))))
  const aged = rawRecordsOf(memory).map(r => (r.kind === 'note' ? { ...r, at: new Date(Date.now() - 60 * 60_000).toISOString() } : r))
  writeFileSync(memory, `${aged.map(r => j(r)).join('\n')}\n`)
  wire.length = 0
  agentReplies = 0
  const resumed = await runSession(arena, SID, ['/advise', 'operator line 3', 'operator line 4'], { results: 3, label: 'three results' }, 60_000, next => next !== 2 || wire.some(w => w.kind === 'advisor'), 'resume')
  check(`the resumed life took bare /advise and two turns, exit 0`, resumed.exit === 0 && resumed.results === 3, j({ exit: resumed.exit, results: resumed.results, stderr: resumed.stderr.slice(-300) }))
  check("bare /advise on the resumed session says on for this chat — nobody said /advise on in this life", adviseLineOf(resumed) === `advisor on for this chat · ${ADVISOR_MODEL} · ${CADENCE}`, adviseLineOf(resumed))
  const advisorRequests = wire.filter(w => w.kind === 'advisor')
  check("one advisor request left the box in the resumed life: due (the memory's note an hour old) and reading the rows since its last look — operator line 2, which the first life never digested", advisorRequests.length === 1 && bodyText(advisorRequests[0]!.body).includes('operator line 2') && !bodyText(advisorRequests[0]!.body).includes('operator line 1'), j(advisorRequests.map(w => bodyText(w.body).slice(0, 200))))
  const chat = file === null ? [] : await chatRowsOf(file)
  const noteRows = chat.filter(isNoteRow)
  const lineThreeAt = chat.findIndex(r => r.type === 'user' && contentOf(r) === 'operator line 3')
  check("the chat's reader hands back two advisor rows across both lives, the second inside the resumed life's first operator turn", noteRows.length === 2 && chat.indexOf(noteRows[1]!) > lineThreeAt && lineThreeAt >= 0, j(shapeOf(chat)))
  wire.length = 0
  agentReplies = 0
}

section(`§1b A NOTE COMPOSED INSIDE A RUNNING TURN LANDS AT ITS NEXT TOOL-ROUND BOUNDARY: the agent reads a file twice before it answers; the boundary after the first read falls due (the hour-old note), the note is composed while the second read's request is answered, and it lands after the second read's result, before the reply — inside the one turn, never as a turn of its own (red on the base: the note waited for the next turn)`)
{
  advisorMode = 'note'
  const arena = makeArena('mid-turn')
  const SID = 'c0ffee00-0000-4000-8000-00000000ad05'
  const memory = seedEarlierNote(arena, SID)
  const file = join(arena.cwd, 'notes.txt')
  agentScript = [{ read: file }, { read: file }, { text: 'done after two reads' }]
  agentDelayMs = 400
  const run = await runSession(arena, SID, [ADVISE_ON, 'operator line 1'], { results: 2, label: 'two results' }, 60_000)
  agentDelayMs = 0
  check(`the session took ${ADVISE_ON} and the one operator turn and no more, then exit 0 (closed on ${run.closedOn})`, run.exit === 0 && run.results === 2, `exit=${run.exit} results=${run.results} closedOn=${run.closedOn} stderr=${run.stderr.slice(-400)}`)
  const advisorRequests = wire.filter(w => w.kind === 'advisor')
  const agentRequests = wire.filter(w => w.kind === 'agent')
  check("ONE advisor request left the box — at the boundary after the first read, inside the turn — carrying the first tool call", advisorRequests.length === 1 && bodyText(advisorRequests[0]!.body).includes('[tool] Read'), j(advisorRequests.map(w => bodyText(w.body).slice(0, 200))))
  check("the agent made three requests in the one turn: the third, after the second boundary, carries the note framed as advice from the advisor; the first two do not; none carries it as the operator's words", agentRequests.length === 3 && !bodyText(agentRequests[1]!.body).includes(NOTE.split('\n')[0]!) && bodyText(agentRequests[2]!.body).includes(text.ADVISOR_NOTE_HEAD) && bodyText(agentRequests[2]!.body).includes(NOTE.split('\n')[0]!) && agentRequests.every(w => !bodyText(w.body).includes('The operator sent a new message')), `${agentRequests.length}: ${agentRequests.map(w => bodyText(w.body).slice(-160)).join(' | ')}`)
  const transcript = transcriptFileOf(arena, SID)
  const chat = transcript === null ? [] : await chatRowsOf(transcript)
  const shape = shapeOf(chat)
  const noteAt = shape.indexOf('note')
  const results = chat.map((r, i) => (r.type === 'user' && Array.isArray((r.message as Raw).content) && ((r.message as Raw).content as Raw[]).some(b => b.type === 'tool_result') ? i : -1)).filter(i => i >= 0)
  check("the chat's own reader hands back the note as an attachment row after the second tool result and before the final reply — inside the turn (red on the base: no such row in the turn)", noteAt >= 0 && results.length === 2 && noteAt === results[1]! + 1 && chat[noteAt + 1]?.type === 'assistant' && chat.filter(isNoteRow).length === 1 && noteWordsOf(chat[noteAt]!) === NOTE, j(shape))
  check("the memory holds the seeded note, then the digest and the note", memoryKindsOf(transcript, SID).join(',') === 'head,note,digest,note' && noteOnDisk(memory), j(memoryKindsOf(transcript, SID)))
  await paintsTheNote(chat, "the operator's line (the tool rows need their tools to paint)", 'operator line 1')
  for (const [columns, rowCount] of [[178, 51], [80, 21]] as Array<[number, number]>) {
    const frame = await paintChat(chat, columns, rowCount)
    const plateAt = frame.findIndex(l => l.includes(`${PLATE} · ${ADVISOR_MODEL} · ${CADENCE}`))
    check(`${columns} columns: the reply that read the note stands beneath it`, plateAt >= 0 && frame.slice(plateAt + 1).some(l => l.includes('done after two reads')), frame.join('\n'))
  }
  frameScenes.push(['advisor-note-mid-turn', "the real runner's transcript: the note composed inside a running turn lands after the second tool result, before the reply", chat])
  wire.length = 0
  agentReplies = 0
  agentScript = []
}

section(`§2 THE ADVISOR HAD NOTHING: the fixture answers thinking only, twice, at turn 1's end — the chat gets the muted [advisor] row saying so as a display-only record on the transcript, the agent gets no turn, and turn 2's end asks nothing more (the quiet look starts the interval); red on the base: one advisor request, silence`)
{
  advisorMode = 'empty'
  const arena = makeArena('quiet')
  const SID = 'c0ffee00-0000-4000-8000-00000000ad02'
  seedEarlierNote(arena, SID)
  const prompts = [ADVISE_ON, 'operator line 1', 'operator line 2']
  let file: string | null = null
  const quietOnDisk = (): boolean => {
    if (file === null) file = transcriptFileOf(arena, SID)
    return rawRecordsOf(file).some(r => JSON.stringify(r).includes('"advisor_quiet"'))
  }
  const run = await runSession(arena, SID, prompts, { results: 3, also: quietOnDisk, label: 'the quiet row on disk while the session was still open' }, 30_000, next => next !== 2 || quietOnDisk())
  check(`the session took ${ADVISE_ON} and the two operator turns and no more, then exit 0 (closed on ${run.closedOn})`, run.exit === 0 && run.results === 3, `exit=${run.exit} results=${run.results} closedOn=${run.closedOn} stderr=${run.stderr.slice(-400)}`)
  check("the quiet row reached the transcript file while the session was still open — the chat's reader would have painted it then", run.closedOn === 'the quiet row on disk while the session was still open', run.closedOn)
  const advisorRequests = wire.filter(w => w.kind === 'advisor')
  const agentRequests = wire.filter(w => w.kind === 'agent')
  check('the advisor was asked twice for the one round — once more after the empty answer, never a third time, and not again at the next turn end (red on the base: once)', advisorRequests.length === 2 && bodyText(advisorRequests[0]!.body) === bodyText(advisorRequests[1]!.body), String(advisorRequests.length))
  check('the agent made exactly two requests — a quiet round costs it no turn', agentRequests.length === 2, String(agentRequests.length))
  if (file === null) file = transcriptFileOf(arena, SID)
  const chat = file === null ? [] : await chatRowsOf(file)
  const quiet = chat.filter(r => r.type === 'system' && r.subtype === 'advisor_quiet')
  const row = quiet[0]
  check(`the chat's own reader hands back ONE quiet system row after the first operator row, with the advisor origin { minutes ${MINUTES} } and the had-nothing words (red on the base: no such row)`, quiet.length === 1 && row !== undefined && rows.isAdvisorOrigin(row.origin) && (row.origin as Raw).model === ADVISOR_MODEL && (row.origin as Raw).minutes === MINUTES && row.content === QUIET_WORDS && chat.indexOf(row) > chat.findIndex(r => r.type === 'user' && contentOf(r) === 'operator line 1'), j(shapeOf(chat)))
  check('no advisor note row exists: the quiet row is not a note', chat.every(r => !isNoteRow(r) && !(r.type === 'user' && rows.isAdvisorOrigin(r.origin))))
  const kinds = memoryKindsOf(file, SID)
  check("the advisor's own record gained no digest and no note for the quiet round — its cursor stays, so the next look reads the same rows again", kinds.join(',') === 'head,note', j(kinds))
  for (const [columns, rowCount] of [[178, 51], [80, 21]] as Array<[number, number]>) {
    const frame = await paintChat(chat, columns, rowCount)
    const plateAt = frame.findIndex(l => l.includes(`${PLATE} · ${ADVISOR_MODEL} · ${CADENCE}`))
    check(`${columns} columns: the chat paints the muted [advisor] plate with the minutes cadence for the quiet round (red on the base: nothing)`, plateAt > 0, frame.join('\n'))
    check(`${columns} columns: the had-nothing line stands beneath the plate`, plateAt >= 0 && (frame[plateAt + 1] ?? '').trim() === QUIET_WORDS, frame.slice(plateAt, plateAt + 2).join('\n'))
    check(`${columns} columns: no accent dot and no operator handle on the quiet row`, plateAt >= 0 && !frame[plateAt]!.includes(DOT) && !frame[plateAt]!.includes(HANDLE), frame[plateAt] ?? '')
    if (columns === 178) console.log(frame.map(l => `    ${l}`).join('\n'))
  }
  frameScenes.push(['advisor-note-quiet', "the real runner's transcript: the operator's turn, then the muted row that says the advisor had nothing to say", chat])
}

section('§3 the real session runner under the daemon crewmate role: the settings on never reach a crewmate — no advisor request, the seeded memory untouched (red on the base: a crewmate opt-in served it)')
{
  wire.length = 0
  agentReplies = 0
  advisorMode = 'note'
  const arena = makeArena('crew')
  arena.env.MERCURY_CREW = '1'
  arena.env.MERCURY_CREW_AGENT = 'advisor-proof-crewmate'
  const cfgPath = join(arena.configDir, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Raw
  cfg.advisor = { enabled: true, crewmates: true, minutes: MINUTES }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
  const sid = 'c0ffee00-0000-4000-8000-00000000ad03'
  seedEarlierNote(arena, sid)
  const run = await runSession(arena, sid, ['crew line 1', 'crew line 2'], { results: 2, label: 'two results' }, 30_000)
  check('daemon crewmate: finishes with two turns and no more', run.exit === 0 && run.results === 2, j({ exit: run.exit, results: run.results, stderr: run.stderr.slice(-300) }))
  const requests = wire.filter(w => w.kind === 'advisor')
  check('daemon crewmate: no scheduled advisor request, even with a crewmates key written by hand into the settings', requests.length === 0, String(requests.length))
  const file = transcriptFileOf(arena, sid)
  const kinds = memoryKindsOf(file, sid)
  check('daemon crewmate: the seeded memory is untouched — nothing was opened', file !== null && kinds.join(',') === 'head,note', j(kinds))
}

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const index: string[] = ['the advisor note frames — the real runner\'s transcript as the chat paints it, at the named width', '']
  for (const [name, words, messages] of frameScenes) {
    for (const [columns, rowCount] of [[178, 51], [80, 21]] as Array<[number, number]>) {
      const frame = await paintChat(messages, columns, rowCount)
      const fileName = `${name}-${columns}x${rowCount}.txt`
      writeFileSync(join(frameDir, fileName), `${frame.join('\n')}\n`)
      index.push(`${fileName}: ${words}`)
      console.log(`  wrote ${fileName} (${frame.length} lines)`)
    }
  }
  writeFileSync(join(frameDir, 'note-lands-index.txt'), `${index.join('\n')}\n`)
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advisor note lands: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
