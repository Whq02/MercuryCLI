#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { canBatchWith } from '../../src/cli/headless/turnDriver.ts'
import { inputRefusal, promptSchemaRefusal } from '../../src/cli/structuredIO.ts'
import { PromptRowSchema } from '../../src/rows/vocabulary.ts'
import { RUNNER_PROTOCOL } from '../../src/runner/wire/methods.ts'
import { RPC_INVALID_PARAMS } from '../../src/runner/wire/errors.ts'
import { compileJsonSchema } from '../../src/services/schema/jsonSchemaEngine.ts'
import type { QueuedCommand } from '../../src/types/textInputTypes.ts'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, isOutcome, isSession, makeTally, removeWorld, seedHome, type Frame } from '../daemon/dupline-world.ts'
import { HANDOFF_ASK_MARK, renderTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { inputLine, parseFrame, promptRow } from '../lib/rows.ts'
import { describeRequest } from '../lib/scriptedTurn.ts'

const { check, section, finish, failed } = makeTally('prove-per-turn-schema')
const j = (value: unknown): string => JSON.stringify(value)

const SCHEMA_A = { title: 'A', type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }
const SCHEMA_B = { title: 'B', type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }
const SCHEMA_C = { title: 'C', type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const MALFORMED = { type: 'nonsense' }
const ANSWER_BY_TITLE: Record<string, Record<string, unknown>> = { A: { city: 'Paris' }, B: { count: 3 }, C: { ok: true } }
const NUDGE = 'must be called to complete this request'
const FORGOT = 'answering in prose instead of the tool'

const validUnder = (schema: object, value: unknown): boolean => {
  const compiled = compileJsonSchema(schema)
  return compiled.ok && compiled.check(value).length === 0
}
const carries = (schema: Record<string, unknown> | undefined, title: string, property: string): boolean =>
  schema?.title === title && typeof schema.properties === 'object' && schema.properties !== null && property in (schema.properties as object)

type Seen = { n: number; ask: string; step: number; toolNames: string[]; answerSchema: Record<string, unknown> | undefined }
type Fixture = { port: number; seen: Seen[]; close: () => Promise<void> }

function answerSchemaOf(body: unknown): Record<string, unknown> | undefined {
  const tools = (body as { tools?: unknown })?.tools
  if (!Array.isArray(tools)) return undefined
  const tool = tools.find(entry => (entry as { name?: unknown })?.name === 'StructuredOutput') as { input_schema?: Record<string, unknown> } | undefined
  return tool?.input_schema
}

async function startFixture(script: (seen: Seen) => ScriptedTurn): Promise<Fixture> {
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
      const entry: Seen = { n: described.n, ask: described.ask, step: described.step, toolNames: described.toolNames, answerSchema: answerSchemaOf(body) }
      seen.push(entry)
      const turn = JSON.stringify(body ?? null).includes(HANDOFF_ASK_MARK) ? ({ kind: 'text', text: 'The note for the next session.' } as ScriptedTurn) : script(entry)
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

let forgotOnce = false
const script = (seen: Seen): ScriptedTurn => {
  const title = typeof seen.answerSchema?.title === 'string' ? seen.answerSchema.title : undefined
  const answer = title === undefined ? undefined : ANSWER_BY_TITLE[title]
  if (seen.step === 0 && answer !== undefined) {
    if (title === 'B' && !forgotOnce && !seen.ask.includes(NUDGE)) {
      forgotOnce = true
      return { kind: 'text', text: FORGOT }
    }
    return { kind: 'tool_use', name: 'StructuredOutput', input: answer }
  }
  return { kind: 'text', text: `done ${title ?? 'plain'}` }
}

section('§1 the vocabulary: a prompt row carries an optional schema, a malformed one is refused on that row, and a schema-bearing prompt is its own turn')
{
  const good = PromptRowSchema().safeParse({ type: 'prompt', content: 'ask', schema: SCHEMA_A })
  check('PromptRow accepts a JSON-schema object under `schema`', good.success && j((good.data as { schema?: unknown }).schema) === j(SCHEMA_A), j(good))
  const plain = PromptRowSchema().safeParse({ type: 'prompt', content: 'ask' })
  check('a prompt row without a schema parses as before', plain.success && !('schema' in (plain.data as object)))
  const notAnObject = PromptRowSchema().safeParse({ type: 'prompt', content: 'ask', schema: 'string' })
  check('a schema that is not an object is refused at the shape', !notAnObject.success)
  const refusal = inputRefusal({ type: 'prompt', content: 'ask', id: 'p-1', schema: MALFORMED })
  check('the rows door refuses a prompt row whose schema the engine refuses, naming the row and the fault', refusal !== null && refusal.startsWith('input refused: the prompt row p-1 carries a schema that is not a JSON schema — ') && refusal.includes('data/type must be equal to one of the allowed values'), refusal ?? 'null')
  check('a prompt row whose schema compiles is not refused', inputRefusal({ type: 'prompt', content: 'ask', schema: SCHEMA_A }) === null && promptSchemaRefusal({ type: 'prompt', content: 'ask', schema: SCHEMA_B }) === null)
  check('a shell row and a note row carry no schema check', promptSchemaRefusal({ type: 'shell', command: 'ls' }) === null && promptSchemaRefusal({ type: 'note', to: 'a1', content: 'hi' }) === null)
  const head: QueuedCommand = { value: 'one', mode: 'prompt' }
  const withSchema: QueuedCommand = { value: 'two', mode: 'prompt', schema: SCHEMA_A }
  check('two plain prompts still batch into one turn', canBatchWith(head, { value: 'two', mode: 'prompt' }))
  check('a prompt carrying a schema never joins another turn, as head or as next', !canBatchWith(head, withSchema) && !canBatchWith(withSchema, head) && !canBatchWith(withSchema, { value: 'three', mode: 'prompt', schema: SCHEMA_A }))
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first (bun run build.ts)`)
  process.exit(1)
}

const home = join(SCRATCH_ROOT, `mercury-per-turn-schema-${process.pid}`)
const cwd = join(home, 'repo')
seedHome(home, cwd)
const fixture = await startFixture(script)
const env = childEnv(home, fixture.port)
delete env.MERCURY_CONCOURSE_WORKER

section('§2 one runner session: schema A, then B, then none under the initialize-level C — each outcome validates against its own schema')
const host = hostRunner({ node: NODE, dist: DIST, argv: ['--model', MODEL, '--mode', 'sovereign'], cwd, env: env as Record<string, string | undefined>, home })
host.onAsk(() => ({ outcome: 'allow' }))
const init = await host.peer
  .request('initialize', { protocol: RUNNER_PROTOCOL, host: { name: 'prove-per-turn-schema', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false }, schema: SCHEMA_C }, { deadlineMs: bound(90_000) })
  .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
check('initialize accepts a session-level schema and answers with the session id', typeof init === 'object' && typeof init.session_id === 'string', j(init).slice(0, 300))

const outcomesSeen = (): number => host.rows.filter(isOutcome).length
async function turn(label: string, content: string, extra: Record<string, unknown>): Promise<Frame | null> {
  const earlier = new Set(host.rows.filter(isOutcome))
  const accepted = await host.prompt(content, { id: randomUUID(), ...extra }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  check(`${label}: the prompt row was accepted`, typeof accepted === 'object' && accepted.accepted === true, j(accepted))
  if (typeof accepted !== 'object') return null
  return host.waitFor(`${label}: outcome`, row => isOutcome(row) && !earlier.has(row), bound(120_000)).catch((error: unknown) => {
    check(`${label}: the turn settled`, false, error instanceof Error ? error.message : String(error))
    return null
  })
}

const firstRequest = (): number => fixture.seen.length
const requestsSince = (from: number): Seen[] => fixture.seen.slice(from)

const sessionRow = host.waitFor('session row', isSession, bound(90_000)).catch(() => null)
const a0 = firstRequest()
const outcomeA = await turn('turn A', 'ask A', { schema: SCHEMA_A })
check('the session row opened the stream', (await sessionRow) !== null)
check('turn A completed', outcomeA?.status === 'completed', j({ status: outcomeA?.status, error: outcomeA?.error, stderr: host.stderr().slice(-400) }))
check('turn A: the outcome carries structured output that validates against A', outcomeA !== null && validUnder(SCHEMA_A, outcomeA.structured), j(outcomeA?.structured))
check('turn A: …and against neither B nor C (the schemas are mutually exclusive)', outcomeA !== null && !validUnder(SCHEMA_B, outcomeA.structured) && !validUnder(SCHEMA_C, outcomeA.structured))
const wireA = requestsSince(a0)
check('turn A: the wire carried the StructuredOutput tool bound to A on the turn\'s first request', wireA[0] !== undefined && carries(wireA[0].answerSchema, 'A', 'city'), j(wireA.map(s => ({ ask: s.ask.slice(0, 40), step: s.step, schema: s.answerSchema?.title ?? null }))))

const b0 = firstRequest()
const outcomeB = await turn('turn B', 'ask B', { schema: SCHEMA_B })
check('turn B completed', outcomeB?.status === 'completed', j({ status: outcomeB?.status, error: outcomeB?.error, stderr: host.stderr().slice(-400) }))
check('turn B: the outcome carries structured output that validates against B', outcomeB !== null && validUnder(SCHEMA_B, outcomeB.structured), j(outcomeB?.structured))
check('turn B: …and not against A', outcomeB !== null && !validUnder(SCHEMA_A, outcomeB.structured))
const wireB = requestsSince(b0)
check('turn B: the wire carried the StructuredOutput tool bound to B — a different schema than turn A under the same tool name', wireB[0] !== undefined && carries(wireB[0].answerSchema, 'B', 'count'), j(wireB.map(s => ({ ask: s.ask.slice(0, 40), step: s.step, schema: s.answerSchema?.title ?? null }))))
check('turn B: a reply that forgot the tool was held and nudged for THIS turn (turn A\'s earlier call does not satisfy B)', wireB.some(s => s.ask.includes(NUDGE) && s.answerSchema?.title === 'B'), j(wireB.map(s => s.ask.slice(0, 60))))

const c0 = firstRequest()
const outcomeC = await turn('turn C', 'ask C', {})
check('turn C (no per-turn schema) completed', outcomeC?.status === 'completed', j({ status: outcomeC?.status, error: outcomeC?.error, stderr: host.stderr().slice(-400) }))
check('turn C: the outcome validates against the initialize-level schema C', outcomeC !== null && validUnder(SCHEMA_C, outcomeC.structured), j(outcomeC?.structured))
check('turn C: …and against neither A nor B', outcomeC !== null && !validUnder(SCHEMA_A, outcomeC.structured) && !validUnder(SCHEMA_B, outcomeC.structured))
const wireC = requestsSince(c0)
check('turn C: the wire carried the StructuredOutput tool bound to C', wireC[0] !== undefined && carries(wireC[0].answerSchema, 'C', 'ok'), j(wireC.map(s => ({ ask: s.ask.slice(0, 40), step: s.step, schema: s.answerSchema?.title ?? null }))))

section('§3 a malformed per-turn schema is a typed refusal on that prompt row — the session lives')
{
  const before = outcomesSeen()
  const refusedId = randomUUID()
  const refused = await host.prompt('ask with a broken schema', { id: refusedId, schema: MALFORMED }).then(
    result => ({ kind: 'result' as const, result }),
    (error: unknown) => ({ kind: 'error' as const, error: error as { code?: number; message?: string; data?: unknown } }),
  )
  check('queue/add answers an error, not an acceptance', refused.kind === 'error', j(refused).slice(0, 300))
  const error = refused.kind === 'error' ? refused.error : undefined
  const issues = (error?.data as { issues?: Array<{ path?: unknown; message?: string }> } | undefined)?.issues ?? []
  check('the error is invalid params (-32602) for queue/add', error?.code === RPC_INVALID_PARAMS && String(error?.message ?? '').includes('queue/add'), j({ code: error?.code, message: error?.message }))
  check('the issue names the schema field, the row and the engine\'s refusal', issues.some(issue => j(issue.path) === j(['schema']) && String(issue.message ?? '').includes(`the prompt row ${refusedId} carries a schema that is not a JSON schema — `) && String(issue.message ?? '').includes('data/type must be equal to one of the allowed values')), j(issues))
  await new Promise(resolve => setTimeout(resolve, 500))
  check('no turn ran for the refused row', outcomesSeen() === before, String(outcomesSeen() - before))
  const facts = await host.request('session/facts', {}, bound(30_000)).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
  check('the session still answers session/facts after the refusal', typeof facts === 'object' && facts !== null && 'model' in (facts as object), j(facts).slice(0, 200))
  const d0 = firstRequest()
  const outcomeD = await turn('turn D', 'ask D after the refusal', { schema: SCHEMA_A })
  check('a later prompt with a good schema runs: the refusal cost the session nothing', outcomeD?.status === 'completed' && validUnder(SCHEMA_A, outcomeD.structured), j({ status: outcomeD?.status, structured: outcomeD?.structured, stderr: host.stderr().slice(-300) }))
  check('turn D: the wire carried A again (the roster moved back from C to A)', requestsSince(d0)[0]?.answerSchema?.title === 'A', j(requestsSince(d0).map(s => s.answerSchema?.title ?? null)))
}

const exit = await host.stop(bound(10_000))
check('the runner exited clean once stdin closed', exit === 0, `exit=${exit} stderr=${host.stderr().slice(-300)}`)

section('§4 the rows door shares the road: a malformed schema is one input_refused notice, the next prompt\'s schema is honoured')
{
  const rowsHome = join(home, 'rows-home')
  const rowsCwd = join(rowsHome, 'repo')
  seedHome(rowsHome, rowsCwd)
  const rowsEnv = { ...childEnv(rowsHome, fixture.port) }
  delete rowsEnv.MERCURY_CONCOURSE_WORKER
  const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--mode', 'sovereign'], { cwd: rowsCwd, env: rowsEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Frame[] = []
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      const frame = parseFrame(line)
      if (frame !== null) frames.push(frame)
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const until = (label: string, test: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | null> =>
    new Promise(resolve => {
      const started = Date.now()
      const tick = (): void => {
        const hit = frames.find(test)
        if (hit !== undefined) return resolve(hit)
        if (Date.now() - started > timeoutMs) {
          console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms; frames=${j(frames.map(f => `${String(f.type)}:${String(f.code ?? f.status ?? '')}`))} stderr=${stderr.slice(-300)}`)
          return resolve(null)
        }
        setTimeout(tick, 100)
      }
      tick()
    })
  child.stdin!.write(inputLine({ ...promptRow('rows: broken schema', { id: 'rows-bad' }), schema: MALFORMED }))
  child.stdin!.write(inputLine({ ...promptRow('rows: ask A', { id: 'rows-good' }), schema: SCHEMA_A }))
  const notice = await until('input_refused notice', f => f.type === 'notice' && f.code === 'input_refused', bound(90_000))
  check('the malformed row is refused with one notice row (code input_refused) naming the row and the fault', notice !== null && String(notice.text ?? '').includes('the prompt row rows-bad carries a schema that is not a JSON schema — '), j(notice))
  const outcome = await until('rows outcome', isOutcome, bound(120_000))
  check('the next prompt row ran under its own schema A', outcome?.status === 'completed' && validUnder(SCHEMA_A, outcome.structured), j({ status: outcome?.status, structured: outcome?.structured, stderr: stderr.slice(-300) }))
  child.stdin!.end()
  const code = await Promise.race([exited, new Promise<number | null>(resolve => setTimeout(() => resolve(-1), bound(30_000)))])
  if (code === -1) child.kill('SIGKILL')
  check('the rows run exits 0 (the refused line never became a failed turn)', code === 0, `exit=${code} stderr=${stderr.slice(-300)}`)
}

await fixture.close()
if (failed() === 0) await removeWorld(home)
else console.log(`  [forensics] the world stays at ${home}\n${host.stderr().split('\n').slice(-12).join('\n')}`)
finish()
