#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCheckpointsFactSchema, InitializeParamsSchema, InitializeResultSchema, RUNNER_PROTOCOL } from '../../src/runner/wire/methods.ts'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, isOutcome, makeTally, removeWorld, seedHome, type Frame } from '../daemon/dupline-world.ts'
import { HANDOFF_ASK_MARK, renderTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { describeRequest } from '../lib/scriptedTurn.ts'

const PURE_HOME = mkdtempSync(join(tmpdir(), 'checkpoints-without-the-role-pure-'))
process.env.MERCURY_CONFIG_DIR = PURE_HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CONCOURSE_WORKER

const { check, section, finish, failed } = makeTally('prove-checkpoints-without-the-role')
const j = (value: unknown): string => JSON.stringify(value)

const LEAD_ASK = 'checkpoints: overwrite note.txt with ONE and ask a crewmate to say hello'
const SEAT_PROMPT = 'crewmate-seat: say hello and stop'
const SEAT_WORDS = 'crewmate: hello from the seat'
const LEAD_DONE = 'CP-DONE.'

section('§1 the switch is its own fact: the role no longer gates a hosted run, the setting stays the off switch, the defaults hold')
{
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { setIsInteractive, getIsNonInteractiveSession } = await import('../../src/bootstrap/state.ts')
  const fh = await import('../../src/utils/fileHistory.ts')
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  setIsInteractive(false)
  check('the run posture reads non-interactive (the premise)', getIsNonInteractiveSession())
  check('a hosted run that asked for nothing captures nothing: the headless default is unchanged', fh.fileHistoryEnabled() === false && fh.fileCheckpointSource() === 'headless', fh.fileCheckpointSource())
  fh.requestFileCheckpoints(true)
  check('THE SWITCH: the host asks on initialize and the run captures — no worker stamp anywhere', fh.fileHistoryEnabled() === true && fh.fileCheckpointSource() === 'initialize', fh.fileCheckpointSource())
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: false }))
  check("the operator's Settings off-switch still wins over the host's ask, and the fact says so", fh.fileHistoryEnabled() === false && fh.fileCheckpointSource() === 'setting', fh.fileCheckpointSource())
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  fh.requestFileCheckpoints(false)
  check('withdrawing the ask returns the run to the headless default', fh.fileHistoryEnabled() === false && fh.fileCheckpointSource() === 'headless')
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  check("the daemon's seat runner captures as before, and the fact names the seat", fh.fileHistoryEnabled() === true && fh.fileCheckpointSource() === 'seat', fh.fileCheckpointSource())
  delete process.env.MERCURY_CONCOURSE_WORKER
  setIsInteractive(true)
  check('an interactive session captures as before, and the fact names it', fh.fileHistoryEnabled() === true && fh.fileCheckpointSource() === 'interactive', fh.fileCheckpointSource())
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: false }))
  check('…and its off-switch still holds', fh.fileHistoryEnabled() === false && fh.fileCheckpointSource() === 'setting')
  saveGlobalConfig(c => ({ ...c, fileCheckpointingEnabled: true }))
  setIsInteractive(false)
  const wireSources = FileCheckpointsFactSchema().shape.source.options
  check('the wire spells the same sources as the switch', j([...wireSources]) === j([...fh.FILE_CHECKPOINT_SOURCES]), j({ wire: wireSources, switch: fh.FILE_CHECKPOINT_SOURCES }))
  const base = { protocol: RUNNER_PROTOCOL, host: { name: 'proof', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  check('initialize accepts file_checkpoints as a boolean and refuses any other spelling', InitializeParamsSchema().safeParse({ ...base, file_checkpoints: true }).success && InitializeParamsSchema().safeParse(base).success && !InitializeParamsSchema().safeParse({ ...base, file_checkpoints: 'on' }).success)
  const result = { protocol: RUNNER_PROTOCOL, runner: { version: '1', pid: 1 }, session_id: null }
  check("the initialize result carries file_checkpoints { capture, source }, and an older runner's answer without it still parses", InitializeResultSchema().safeParse({ ...result, file_checkpoints: { capture: true, source: 'initialize' } }).success && InitializeResultSchema().safeParse(result).success && !InitializeResultSchema().safeParse({ ...result, file_checkpoints: { capture: true, source: 'worker' } }).success)
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first (bun run build.ts)`)
  process.exit(1)
}

type Seen = { n: number; ask: string; step: number; toolNames: string[] }
type Fixture = { port: number; seen: Seen[]; close: () => Promise<void> }

async function startFixture(script: (seen: Seen, target: string) => ScriptedTurn, target: string): Promise<Fixture> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (url.includes('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(j({ input_tokens: 12 }))
        return
      }
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const described = describeRequest(body, seen.length + 1)
      const entry: Seen = { n: described.n, ask: described.ask, step: described.step, toolNames: described.toolNames }
      seen.push(entry)
      const turn = JSON.stringify(body ?? null).includes(HANDOFF_ASK_MARK) ? ({ kind: 'text', text: 'The note for the next session.' } as ScriptedTurn) : script(entry, target)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(renderTurn(turn, entry.n))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

const script = (seen: Seen, target: string): ScriptedTurn => {
  if (seen.ask.includes(SEAT_PROMPT)) return { kind: 'text', text: SEAT_WORDS }
  if (!seen.ask.includes(LEAD_ASK)) return { kind: 'text', text: 'ok' }
  if (seen.step === 0) return { kind: 'tool_use', name: 'Read', input: { file_path: target } }
  if (seen.step === 1) return { kind: 'tool_use', name: 'Write', input: { file_path: target, content: 'ONE\n' } }
  if (seen.step === 2) return { kind: 'tool_use', name: 'Crewmate', input: { description: 'hello seat', prompt: SEAT_PROMPT, crewmate_type: 'mercury-crew' } }
  return { kind: 'text', text: LEAD_DONE }
}

function findTranscript(root: string, sessionId: string): string | null {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const path = join(dir, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) stack.push(path)
      else if (name === `${sessionId}.jsonl`) return path
    }
  }
  return null
}

type Facts = { file_checkpoints?: { capture?: boolean; source?: string; restorable?: string[] } }

async function drive(label: string, asked: boolean): Promise<void> {
  const home = join(SCRATCH_ROOT, `mercury-checkpoints-${label}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const target = join(cwd, 'note.txt')
  writeFileSync(target, 'ZERO\n')
  const fixture = await startFixture(script, target)
  const env = childEnv(home, fixture.port)
  delete env.MERCURY_CONCOURSE_WORKER
  const host = hostRunner({ node: NODE, dist: DIST, argv: ['--model', MODEL, '--mode', 'sovereign'], cwd, env: env as Record<string, string | undefined>, home })
  host.onAsk(() => ({ outcome: 'allow' }))
  const init = await host.peer
    .request('initialize', { protocol: RUNNER_PROTOCOL, host: { name: 'prove-checkpoints-without-the-role', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false }, ...(asked ? { file_checkpoints: true } : {}) }, { deadlineMs: bound(90_000) })
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  const initFact = typeof init === 'object' ? init.file_checkpoints : undefined
  check(`${label}: initialize answered with the session id`, typeof init === 'object' && typeof init.session_id === 'string', j(init).slice(0, 300))
  if (asked) check(`${label}: the initialize result says checkpoints are ON because the host asked (capture true, source initialize)`, initFact?.capture === true && initFact?.source === 'initialize', j(initFact))
  else check(`${label}: the initialize result says checkpoints are OFF by the headless default (capture false, source headless)`, initFact?.capture === false && initFact?.source === 'headless', j(initFact))

  const promptId = randomUUID()
  const accepted = await host.prompt(LEAD_ASK, { id: promptId }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  check(`${label}: the prompt row was accepted`, typeof accepted === 'object' && accepted.accepted === true, j(accepted))
  const outcome = await host.waitFor(`${label}: outcome`, isOutcome, bound(180_000)).catch((error: unknown) => {
    check(`${label}: the turn settled`, false, error instanceof Error ? error.message : String(error))
    return null as Frame | null
  })
  const sessionId = typeof init === 'object' && typeof init.session_id === 'string' ? init.session_id : ''
  check(`${label}: the turn completed with the lead's closing words`, outcome?.status === 'completed' && String(outcome.answer ?? '').includes(LEAD_DONE), j({ status: outcome?.status, answer: outcome?.answer, error: outcome?.error, stderr: host.stderr().slice(-400) }))
  check(`${label}: the Write landed (the tool ran in THIS process)`, existsSync(target) && readFileSync(target, 'utf8') === 'ONE\n', existsSync(target) ? readFileSync(target, 'utf8') : 'absent')
  const crewmateCalls = host.rows.filter(row => row.type === 'tool_call' && row.tool === 'Crewmate' && row.parent_call_id === undefined)
  const crewmateCallIds = new Set(crewmateCalls.map(row => row.call_id))
  const crewmateResults = host.rows.filter(row => row.type === 'tool_result' && crewmateCallIds.has(row.call_id))
  const crewmateRows = host.rows.filter(row => row.parent_call_id !== undefined)
  check(`${label}: a crewmate ran in the same session — the Crewmate call settled ok and the crewmate's own rows streamed under it`, crewmateCalls.length === 1 && crewmateResults.some(row => row.status === 'ok') && crewmateRows.length > 0 && fixture.seen.some(s => s.ask.includes(SEAT_PROMPT)), j({ calls: crewmateCalls.length, results: crewmateResults.map(r => r.status), childRows: crewmateRows.length, seatAsks: fixture.seen.filter(s => s.ask.includes(SEAT_PROMPT)).length }))

  const facts = (await host.request('session/facts', {}, bound(30_000)).catch(() => ({}))) as Facts
  const fc = facts.file_checkpoints
  const rewind = await host.request('session/rewind', { user_message_id: promptId, mode: 'code', dry_run: true }, bound(30_000)).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })) as Record<string, unknown>
  const blobDir = join(home, 'file-history', sessionId)
  const blobs = existsSync(blobDir) ? readdirSync(blobDir) : []
  const transcript = sessionId === '' ? null : findTranscript(home, sessionId)
  const records = transcript === null ? [] : readFileSync(transcript, 'utf8').split('\n').filter(line => line.trim() !== '')
  const snapshotRows = records.filter(line => line.includes('"file-history-snapshot"'))
  if (asked) {
    check(`${label}: session/facts says capture ON with source initialize, and the turn's prompt is restorable`, fc?.capture === true && fc?.source === 'initialize' && (fc.restorable ?? []).includes(promptId), j(fc))
    check(`${label}: a backup blob holds the PRE-EDIT bytes (ZERO) under <home>/file-history/<sid>/`, blobs.length >= 1 && blobs.some(name => readFileSync(join(blobDir, name), 'utf8') === 'ZERO\n'), j({ blobDir, blobs }))
    check(`${label}: the transcript carries a file-history-snapshot row keyed by the prompt and tracking note.txt`, snapshotRows.some(line => line.includes(promptId) && line.includes('note.txt')), j({ transcript, rows: snapshotRows.map(r => r.slice(0, 160)) }))
    const code = rewind.code as { files_changed?: string[] } | undefined
    check(`${label}: a dry-run code rewind to the prompt reports note.txt as the file it would restore`, rewind.outcome === 'applied' && rewind.mode === 'code' && (code?.files_changed ?? []).some(name => name.endsWith('note.txt')), j(rewind))
  } else {
    check(`${label}: session/facts says capture OFF with source headless and nothing restorable`, fc?.capture === false && fc?.source === 'headless' && (fc.restorable ?? []).length === 0, j(fc))
    check(`${label}: CONTROL — no blob and no snapshot row (the headless default keeps its hands off)`, blobs.length === 0 && snapshotRows.length === 0, j({ blobs, rows: snapshotRows.length }))
    check(`${label}: a code rewind refuses capture-off and names the initialize option as the road, not the Settings row`, rewind.outcome === 'refused' && rewind.refusal === 'capture-off' && String(rewind.detail ?? '').includes('file_checkpoints on initialize'), j(rewind))
  }
  const exit = await host.stop(bound(10_000))
  check(`${label}: the runner exited clean`, exit === 0, `exit=${exit} stderr=${host.stderr().slice(-300)}`)
  await fixture.close()
  if (failed() === 0) await removeWorld(home)
  else console.log(`  [forensics] the ${label} world stays at ${home}\n${host.stderr().split('\n').slice(-12).join('\n')}`)
}

section('§2 a hosted run that asked on initialize: checkpoints on, a crewmate running in the same session, no worker stamp')
await drive('asked', true)

section('§3 the control: the same run without the option keeps the headless default off, and says so')
await drive('plain', false)

finish()
