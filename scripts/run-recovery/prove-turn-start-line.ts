#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { handoffTurn, isHandoffRequest, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)' : '❌ no node binary on PATH')
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'turn-start-line-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const loaderCwd = join(scratch, 'loader-cwd')
mkdirSync(loaderCwd, { recursive: true })
bootstrap.setOriginalCwd(loaderCwd)
bootstrap.setProjectRoot(loaderCwd)
const { loadConversationForResume, getResumePrompt } = await import('../../src/utils/conversationRecovery.ts')
const sdk = await import('../../sdk/src/index.ts')
const acp = await import('@agentclientprotocol/sdk')
const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseWorkers.ts')
const { buildRunnerInvocation } = await import('../../src/daemon/headlessRun.ts')
const { transcriptExport, transcriptExportText, truncateExportResults } = await import('../../src/commands/export/transcript.ts')
const { createSecretRedactor, redactSecretValues } = await import('../../src/utils/redactSecrets.ts')
const { sessionPromptFromWindow } = await import('../../src/utils/sessionStorage/sessionIndex.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const j = (value: unknown): string => JSON.stringify(value) ?? ''

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the turn-start proof exceeded 420s')
  process.exit(1)
}, 420_000)
guard.unref?.()

const CONTINUATION = getResumePrompt()
const ASKED_AGAIN_WORDS = 'say it again, with feeling'
const MODEL = 'claude-opus-4-8'
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

type Arena = { home: string; cwd: string; env: Record<string, string> }
function makeArena(name: string, fixture: FixtureApi, extra: Record<string, string> = {}): Arena {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'cwd')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: ['/usr/bin:/bin', dirname(nodeBin!)].join(delimiter),
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_TMPDIR: join(scratch, name, 'tmp'),
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
      ...extra,
    },
  }
}
function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, stdout, stderr })
    })
  })
}
const rowsOf = (stdout: string): Array<Record<string, unknown>> => stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
const outcomesOf = (stdout: string): Array<Record<string, unknown>> => rowsOf(stdout).filter(row => row.type === 'outcome')
async function oneProcess(arena: Arena, sessionId: string, asks: string[]): Promise<string> {
  const child = spawn(nodeBin!, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--session-id', sessionId], { cwd: arena.cwd, env: arena.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout!.on('data', chunk => (stdout += String(chunk)))
  child.stderr!.on('data', () => {})
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  for (let n = 1; n <= asks.length; n++) {
    child.stdin!.write(JSON.stringify({ type: 'prompt', content: asks[n - 1] }) + '\n')
    const until = Date.now() + 60_000
    while (Date.now() < until && outcomesOf(stdout).length < n) await new Promise(tick => setTimeout(tick, 20))
  }
  child.stdin!.end()
  const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  await exited
  clearTimeout(killer)
  return stdout
}
function recordsOf(arena: Arena): { sessions: string[]; sidechains: string[] } {
  const sessions: string[] = []
  const sidechains: string[] = []
  const stack = [join(arena.home, '.mercury', 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop()!
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (/^agent-.*\.jsonl$/.test(entry.name)) sidechains.push(path)
      else if (/^[0-9a-f-]{36}\.jsonl$/.test(entry.name)) sessions.push(path)
    }
  }
  return { sessions, sidechains }
}
const recordOf = (arena: Arena, sessionId: string): string => recordsOf(arena).sessions.find(path => path.endsWith(`${sessionId}.jsonl`)) ?? ''

type Line = { kind: string; metaKind?: string; fields?: Record<string, unknown>; raw: string }
const linesOf = (file: string): Line[] =>
  file === '' || !existsSync(file)
    ? []
    : readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(raw => {
          const payload = ((JSON.parse(raw) as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>
          return { kind: String(payload.kind), ...(typeof payload.metaKind === 'string' ? { metaKind: payload.metaKind } : {}), ...(payload.fields !== undefined ? { fields: payload.fields as Record<string, unknown> } : {}), raw }
        })
const isStart = (line: Line): boolean => line.kind === 'session-meta' && line.metaKind === 'turn-start'
const isEnd = (line: Line): boolean => line.kind === 'session-meta' && line.metaKind === 'turn-end'
const isConversation = (line: Line): boolean => line.kind === 'input' || line.kind === 'output'
const shapeOf = (lines: Line[]): string => lines.filter(line => isStart(line) || isEnd(line) || isConversation(line) || line.kind === 'boundary').map(line => (isStart(line) ? 'start' : isEnd(line) ? 'end' : line.kind)).join(' ')
function turnsOf(lines: Line[]): { whole: boolean; ids: string[]; detail: string } {
  const marks = lines.filter(line => isStart(line) || isEnd(line))
  const ids: string[] = []
  let whole = marks.length % 2 === 0
  for (let at = 0; at + 1 < marks.length; at += 2) {
    const start = marks[at]!
    const end = marks[at + 1]!
    if (!isStart(start) || !isEnd(end) || start.fields?.turnId !== end.fields?.turnId) whole = false
    ids.push(String(start.fields?.turnId))
  }
  for (const line of lines.filter(isConversation)) {
    const at = lines.indexOf(line)
    const startsBefore = lines.slice(0, at).filter(isStart).length
    const endsBefore = lines.slice(0, at).filter(isEnd).length
    if (startsBefore !== endsBefore + 1) whole = false
  }
  return { whole, ids, detail: shapeOf(lines) }
}
const turnIdsOf = (stdout: string): string[] => outcomesOf(stdout).map(row => String(row.turn_id))
const wireSays = (request: { body: unknown } | undefined, words: string): number => j(((request?.body ?? {}) as { messages?: unknown }).messages ?? []).split(JSON.stringify(words).slice(1, -1)).length - 1
const lastRequest = (fixture: FixtureApi): { body: unknown } | undefined => fixture.messageRequests().filter(request => !isHandoffRequest(request)).at(-1)
const replies = (tag: string, count: number): ScriptedTurn[] => Array.from({ length: count }, (_, n) => ({ kind: 'text' as const, text: `${tag}-REPLY-${n + 1}.` }))
let serial = 0
const sid = (): string => `facef00d-0000-4000-8000-${String(0xb7000000 + ++serial).padStart(12, '0')}`

console.log('============================================================')
console.log(' the run states that its turn began: one start row a turn')
console.log('============================================================')

try {
  section('A — mercury run: one turn, its start row ahead of its rows and its end line behind them; a resumed turn adds its own two')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), ...replies('RUN', 2)])
    const arena = makeArena('run', fixture)
    try {
      const first = await run(arena, ['run', 'RUN first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
      const file = recordOf(arena, SID)
      const lines = linesOf(file)
      const read = turnsOf(lines)
      check('A1 one turn: one start row and one end line, both with the id the outcome row gives the turn, every conversation row between them', first.exit === 0 && read.whole && j(read.ids) === j(turnIdsOf(first.stdout)) && read.ids.length === 1, j({ exit: first.exit, read, outcome: turnIdsOf(first.stdout) }))
      const starts = lines.filter(isStart)
      check('A2 the start row is a session row named turn-start that carries the session and the turn and nothing else', starts.length === 1 && j(Object.keys(starts[0]!.fields ?? {}).sort()) === j(['sessionId', 'turnId']) && starts[0]!.fields?.sessionId === SID, j(starts.map(line => line.fields)))
      console.log(`       on disk: ${starts[0]?.raw ?? ''}`)
      const second = await run(arena, ['run', 'RUN second prompt.', '--model', MODEL, '--resume', SID, '--format', 'rows'])
      const after = turnsOf(linesOf(file))
      check('A3 a resumed turn in a second process adds one start row and one end line of its own', second.exit === 0 && after.whole && after.ids.length === 2 && after.ids[1] === turnIdsOf(second.stdout).at(-1), j({ exit: second.exit, after }))
      const loaded = await loadConversationForResume(SID, file)
      check('A4 the loader reads a finished turn and builds the conversation without the two kinds of line', loaded?.turnInterruptionState.kind === 'none' && (loaded?.messages ?? []).filter(row => row.type === 'user' || row.type === 'assistant').length >= 4, j({ state: loaded?.turnInterruptionState.kind, rows: loaded?.messages.length }))
      const document = truncateExportResults(redactSecretValues(transcriptExport((loaded?.messages ?? []) as never, { id: SID, cwd: arena.cwd }), createSecretRedactor([])))
      const exported = transcriptExportText(document)
      check('A5 the document /export builds from that conversation, through its mask, holds the two prompts and the two replies and nothing of either line', j(document.messages.map(message => [message.role, message.text])) === j([['user', 'RUN first prompt.'], ['assistant', 'RUN-REPLY-1.'], ['user', 'RUN second prompt.'], ['assistant', 'RUN-REPLY-2.']]) && after.ids.every(id => !exported.includes(id)), exported.slice(0, 600))
      const head = readFileSync(file, 'utf8').slice(0, 65536)
      check('A6 the reader that finds a session\'s first prompt for the sessions list passes over the start row ahead of it', sessionPromptFromWindow(head, undefined, true) === 'RUN first prompt.', j(sessionPromptFromWindow(head, undefined, true)))
      const listed = await run(arena, ['sessions', 'list'])
      const row = listed.stdout.split('\n').find(line => line.startsWith(SID)) ?? ''
      check('A7 the sessions list names the session by its last prompt, as it does for a record with no start row', listed.exit === 0 && row.endsWith('RUN second prompt.'), j({ exit: listed.exit, row, err: listed.stderr.slice(-200) }))
    } finally {
      await fixture.close()
    }
  }

  section("B — a hosted session's runner, started as the daemon starts the one behind a window: three turns, a typed command among them")
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), ...replies('HOSTED', 2)])
    const arena = makeArena('hosted', fixture)
    const spec = buildConcourseWorkerSpec({ runnerId: 'concourse-w1', workspaceId: arena.cwd, modelKey: MODEL, sessionId: SID, resume: false, runnerArgv: [] })
    const invocation = buildRunnerInvocation(spec).argv
    const host = hostRunner({ dist: DIST, node: nodeBin!, cwd: arena.cwd, home: arena.env.MERCURY_CONFIG_DIR, env: { ...arena.env, MERCURY_CONCOURSE_WORKER: '1' }, argv: ['--model', MODEL, invocation[invocation.indexOf(spec.appendSystemPrompt) - 1] ?? '', spec.appendSystemPrompt, ...(spec.extraArgv ?? [])] })
    try {
      await host.initialize({}, 90_000)
      const ids: string[] = []
      for (const [turn, ask] of ['HOSTED first prompt.', '/context', 'HOSTED third prompt.'].entries()) {
        await host.prompt(ask)
        const outcome = (await host.waitFor(`the outcome of turn ${turn + 1}`, row => row.type === 'outcome' && row.turn === turn + 1, 90_000)) as Record<string, unknown>
        ids.push(String(outcome.turn_id))
      }
      await host.stop(20_000)
      const read = turnsOf(linesOf(recordOf(arena, SID)))
      check('B1 three turns in one runner: three start rows and three end lines, pairwise, in the order of the turns', read.whole && j(read.ids) === j(ids), j({ read, ids }))
    } finally {
      await host.stop().catch(() => null)
      await fixture.close()
    }
  }

  section("C — the other doors that run a turn: the published package's run door, the runner door, ACP")
  {
    const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), handoffTurn(), ...replies('DOORS', 3)])
    const mercury = [nodeBin!, DIST] as const
    const whole = (arena: Arena, turnId: string | undefined): { ok: boolean; detail: string } => {
      const read = recordsOf(arena).sessions.map(file => turnsOf(linesOf(file)))
      return { ok: read.length === 1 && read[0]!.whole && read[0]!.ids.length === 1 && (turnId === undefined || read[0]!.ids[0] === turnId), detail: j(read) }
    }
    try {
      const viaRun = makeArena('door-run', fixture)
      const task = sdk.run({ prompt: 'DOORS through the run door.', mercury, cwd: viaRun.cwd, env: viaRun.env, model: MODEL })
      const outcome = await task.outcome
      await task.exit
      check("C1 the package's run door: one start row, one end line, the outcome's turn", outcome.status === 'completed' && whole(viaRun, outcome.turn_id).ok, whole(viaRun, outcome.turn_id).detail)

      const viaRunner = makeArena('door-runner', fixture)
      const session = await sdk.connect({ mercury, cwd: viaRunner.cwd, env: viaRunner.env, model: MODEL })
      let spoken: { status: string; turn_id: string } | null = null
      try {
        spoken = await session.prompt('DOORS through the runner door.')
      } finally {
        await session.close()
      }
      check("C2 the runner door: one start row, one end line, the outcome's turn", spoken?.status === 'completed' && whole(viaRunner, spoken?.turn_id).ok, whole(viaRunner, spoken?.turn_id).detail)

      const viaAcp = makeArena('door-acp', fixture)
      const server: ChildProcess = spawn(nodeBin!, [DIST, 'acp'], { cwd: viaAcp.cwd, env: viaAcp.env, stdio: ['pipe', 'pipe', 'pipe'] })
      server.stderr!.on('data', () => {})
      let stopReason = ''
      try {
        const conn = acp
          .client({ name: 'turn-start-line' })
          .onNotification('session/update', () => {})
          .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } }))
          .connect(acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>))
        const deadline = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('the ACP server did not answer within 60 s')), 60_000).unref?.())])
        await deadline(conn.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }))
        const created = await deadline(conn.agent.request('session/new', { cwd: viaAcp.cwd, mcpServers: [] }))
        const answered = await deadline(conn.agent.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'DOORS through ACP.' }] }))
        stopReason = String(answered.stopReason)
        conn.close()
      } finally {
        server.kill('SIGTERM')
        await new Promise<void>(resolve => {
          const hard = setTimeout(() => server.kill('SIGKILL'), 10_000)
          server.on('close', () => {
            clearTimeout(hard)
            resolve()
          })
        })
      }
      check('C3 ACP: one start row, one end line', stopReason === 'end_turn' && whole(viaAcp, undefined).ok, whole(viaAcp, undefined).detail)
    } finally {
      await fixture.close()
    }
  }

  section("D — a turn that launches a crewmate: the session's record holds the turn's two lines; the crewmate's own record holds neither")
  {
    const SID = sid()
    const LEAD = 'CREW-LEAD prompt'
    const fixture = await startFixtureApi([
      handoffTurn(),
      { kind: 'tool_use', id: 'toolu_start_line_launch', name: 'Crewmate', input: { description: 'count the harbour', prompt: 'CREW-SEAT-WORK: count the boats and reply once.', crewmate_type: 'mercury-crew' }, whenBody: LEAD },
      { kind: 'text', text: 'CREW-SEAT-COUNTED.', whenBody: 'CREW-SEAT-WORK' },
      { kind: 'text', text: 'CREW-LEAD-DONE.' },
    ])
    const arena = makeArena('crew', fixture)
    try {
      const first = await run(arena, ['run', `${LEAD}: count the harbour with one crewmate.`, '--model', MODEL, '--session-id', SID, '--format', 'rows', '--allowed-tools', 'Crewmate'])
      const read = turnsOf(linesOf(recordOf(arena, SID)))
      const own = recordsOf(arena).sidechains
      const ownLines = own.flatMap(linesOf)
      check('D1 the turn ran the crewmate and ended: one start row and one end line in the session\'s record', first.exit === 0 && first.stdout.includes('CREW-LEAD-DONE.') && read.whole && read.ids.length === 1, j({ exit: first.exit, read, err: first.stderr.slice(-200) }))
      check("D2 the crewmate's own record holds its rows and no start row or end line: the two lines are the session's", own.length === 1 && ownLines.filter(isConversation).length >= 2 && ownLines.filter(line => isStart(line) || isEnd(line)).length === 0, j({ files: own.length, shape: own.map(file => shapeOf(linesOf(file))) }))
    } finally {
      await fixture.close()
    }
  }

  section('E — a turn that folds the conversation (a compact boundary), and the turn after it')
  {
    const SID = sid()
    const long = (n: number): ScriptedTurn => ({ kind: 'text', text: `FOLD-REPLY-${n}.\n${Array.from({ length: 300 }, (_, index) => `Module ${n}-${index}: parser revision ${(index * 7919 + n * 104729).toString(36)} handles quoted commas.`).join('\n')}` })
    const fixture = await startFixtureApi([handoffTurn(), { kind: 'text', text: '<analysis>walk</analysis>\n<summary>\n1. Operator Intent: plain turns for a fold.\n</summary>', whenBody: 'Produce the summary now' }, long(1), long(2), long(3)])
    const arena = makeArena('fold', fixture, { MERCURY_COMPACT_KEEP_TAIL: '1' })
    try {
      const stdout = await oneProcess(arena, SID, ['FOLD prompt 1.', 'FOLD prompt 2.', '/compact', 'FOLD prompt 3.'])
      const lines = linesOf(recordOf(arena, SID))
      const read = turnsOf(lines)
      const boundaryAt = lines.findIndex(line => line.kind === 'boundary')
      const startsBefore = lines.slice(0, boundaryAt).filter(isStart).length
      const endsBefore = lines.slice(0, boundaryAt).filter(isEnd).length
      check('E1 four turns, the third a fold: four start rows and four end lines, pairwise', outcomesOf(stdout).length === 4 && outcomesOf(stdout).every(row => row.status === 'completed') && read.whole && j(read.ids) === j(turnIdsOf(stdout)), j({ outcomes: outcomesOf(stdout).map(row => row.status), read }))
      check("E2 the boundary stands inside the fold's own turn, behind that turn's start row and ahead of its end line", boundaryAt > 0 && startsBefore === 3 && endsBefore === 2, j({ boundaryAt, startsBefore, endsBefore, shape: shapeOf(lines) }))
      const loaded = await loadConversationForResume(SID, recordOf(arena, SID))
      check('E3 the folded record reads as finished', loaded?.turnInterruptionState.kind === 'none', j(loaded?.turnInterruptionState.kind))
    } finally {
      await fixture.close()
    }
  }

  section('F — a turn that records nothing leaves no start row, and a run that keeps nothing leaves no record')
  {
    const SID = sid()
    const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), ...replies('NOTHING', 3)])
    const arena = makeArena('nothing', fixture)
    const kept = makeArena('ephemeral', fixture)
    try {
      const stdout = await oneProcess(arena, SID, ['NOTHING prompt 1.', '/usage', 'NOTHING prompt 2.'])
      const outcomes = outcomesOf(stdout)
      const read = turnsOf(linesOf(recordOf(arena, SID)))
      check('F1 three turns ran, the second a command the runner refuses without writing a row: the record holds two start rows and two end lines, for the first and the third', j(outcomes.map(row => row.status)) === j(['completed', 'refused', 'completed']) && read.whole && j(read.ids) === j([outcomes[0]!.turn_id, outcomes[2]!.turn_id]), j({ outcomes: outcomes.map(row => row.status), read }))
      const ephemeral = await run(kept, ['run', 'NOTHING kept.', '--model', MODEL, '--ephemeral', '--format', 'rows'])
      check('F2 a run that keeps nothing answers and leaves no record at all', ephemeral.exit === 0 && outcomesOf(ephemeral.stdout).at(-1)?.status === 'completed' && recordsOf(kept).sessions.length === 0, j({ exit: ephemeral.exit, files: recordsOf(kept).sessions }))
    } finally {
      await fixture.close()
    }
  }

  section('G — a start row with no end line behind a hidden row: the first turn of a session reads as a later turn does, on a resume, a fork and a rewind')
  {
    const gate = (arena: Arena): void => {
      const spent = join(arena.home, 'gate-spent')
      writeFileSync(join(arena.home, '.mercury', 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.answer': [{ name: 'answer gate', run: `if [ ! -f ${quote(spent)} ]; then touch ${quote(spent)}; echo ${quote(ASKED_AGAIN_WORDS)} >&2; exit 2; fi; exit 0` }] } } }))
    }
    const cut = async (fixture: FixtureApi, arena: Arena, args: string[], file: () => string): Promise<void> => {
      const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
      const asked = (): boolean => fixture.messageRequests().some(request => !isHandoffRequest(request) && j(request.body).includes(ASKED_AGAIN_WORDS))
      const recorded = (): boolean => file() !== '' && readFileSync(file(), 'utf8').includes(ASKED_AGAIN_WORDS)
      const until = Date.now() + 30_000
      while (Date.now() < until && !(asked() && recorded())) await new Promise(tick => setTimeout(tick, 50))
      await new Promise(tick => setTimeout(tick, 300))
      child.kill('SIGKILL')
      await exited
    }
    const lastConversationRow = (file: string): string => {
      const rows = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { recordId?: string; payload?: { kind?: string } })
      return rows.filter(row => row.payload?.kind === 'input' || row.payload?.kind === 'output').at(-1)?.recordId ?? ''
    }
    const told: Record<string, Record<string, number>> = { first: {}, later: {} }
    for (const shape of ['first', 'later'] as const) {
      for (const door of ['resume', 'fork', 'rewind'] as const) {
        const SID = sid()
        const fixture = await startFixtureApi([handoffTurn(), handoffTurn(), handoffTurn(), ...(shape === 'later' ? replies('CUT', 1) : []), { kind: 'text', text: 'CUT-REPLY, which the hook blocks.' }, { kind: 'hang', deltas: [] }, { kind: 'text', text: 'CUT-DOOR-REPLY.' }])
        const arena = makeArena(`cut-${shape}-${door}`, fixture)
        try {
          if (shape === 'later') await run(arena, ['run', 'CUT first prompt.', '--model', MODEL, '--session-id', SID, '--format', 'rows'])
          gate(arena)
          await cut(fixture, arena, ['run', 'CUT prompt.', '--model', MODEL, ...(shape === 'later' ? ['--resume', SID] : ['--session-id', SID]), '--format', 'rows'], () => recordOf(arena, SID))
          const file = recordOf(arena, SID)
          const lines = linesOf(file)
          const through = door === 'resume' ? ['--resume', SID] : door === 'fork' ? ['--resume', SID, '--fork'] : ['--resume', SID, '--replay-to', lastConversationRow(file)]
          const next = await run(arena, ['run', 'CUT door prompt.', '--model', MODEL, ...through, '--format', 'rows'])
          told[shape]![door] = next.exit === 0 && next.stdout.includes('CUT-DOOR-REPLY.') && lines.filter(isStart).length === lines.filter(isEnd).length + 1 ? wireSays(lastRequest(fixture), CONTINUATION) : -1
        } finally {
          await fixture.close()
        }
      }
    }
    check('G1 a resume tells the model once that the previous run ended before its turn finished, whichever turn was cut', told.first!.resume === 1 && told.later!.resume === 1, j(told))
    check('G2 a fork tells it once too, whichever turn was cut', told.first!.fork === 1 && told.later!.fork === 1, j(told))
    check('G3 a rewind to the last recorded row keeps the rows up to it and nothing behind it, the sentence included, whichever turn was cut', told.first!.rewind === 0 && told.later!.rewind === 0, j(told))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ ONE START ROW A TURN (${checks} checks)` : ` ❌ ${failures} of ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
