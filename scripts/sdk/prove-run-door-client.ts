#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'sdk-door-home-'))
const sdk = await import('../../sdk/src/index.ts')
const project = await import('../../src/rows/project.ts')
const dist = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}
type Door = { home: string; api: Awaited<ReturnType<typeof startFixtureApi>>; env: Record<string, string | undefined>; close: () => Promise<void> }
async function openDoor(turns: ScriptedTurn[]): Promise<Door> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-door-')))
  seedFirstRun(home, [home])
  const api = await startFixtureApi(turns)
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
  return { home, api, env, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}
const mercury = ['node', dist] as const
const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms).unref?.())])

section('C1 a tool turn with partial rows through the package: every row parses, the core rows arrive in order, the outcome resolves')
{
  const door = await openDoor([
    { kind: 'tool_use', name: 'Bash', input: { command: 'echo sdk-door' }, preText: 'Running it.', thinking: 'a short think' },
    { kind: 'text', text: 'The door answered.' },
  ])
  try {
    const run = sdk.run({ prompt: 'run the command', mercury, cwd: door.home, env: door.env, mode: 'sovereign', partial: true })
    const events: string[] = []
    const texts: string[] = []
    run.on('row', row => events.push(row.type))
    run.on('text', row => texts.push(row.text))
    let endSeen = false
    run.on('end', () => { endSeen = true })
    const iterated: string[] = []
    let iterationError: unknown
    try {
      for await (const row of run) iterated.push(row.type)
    } catch (error) {
      iterationError = error
    }
    const outcome = await withTimeout(run.outcome, 60_000, 'the outcome')
    const exit = await run.exit
    check('the run completed with exit 0 and the outcome row says completed', exit.code === 0 && outcome.status === 'completed' && sdk.OUTCOME_EXIT_CODES[outcome.status] === exit.code, j({ exit, status: outcome.status }))
    check('the iterator yielded every row the listeners saw, in the same order, and threw nothing', iterationError === undefined && iterated.join(',') === events.join(','), j({ iterationError: String(iterationError), iterated, events }))
    check('every row the door emitted parsed through the package (no wire error)', run.error === null && run.rows.length === events.length, String(run.error))
    const declared = new Set<string>([...sdk.ROW_TYPES, ...sdk.PARTIAL_ROW_TYPES])
    check('every emitted row type is declared in the generated vocabulary', events.every(type => declared.has(type)), j(events.filter(type => !declared.has(type))))
    const core = ['session', 'turn', 'reasoning', 'text', 'tool_call', 'tool_result', 'step', 'outcome', 'block_start', 'text_delta', 'reasoning_delta', 'tool_input_delta']
    check('the core rows of a tool turn with partial rows all arrived', core.every(type => events.includes(type)), j({ missing: core.filter(type => !events.includes(type)), events }))
    check('the session row came first, the outcome last, seq contiguous from 1', run.rows[0]?.type === 'session' && run.rows.at(-1)?.type === 'outcome' && run.rows.every((row, i) => row.seq === i + 1))
    check('the resolved outcome is the last row of the stream (the same object)', run.rows.at(-1) === outcome)
    const session = await run.session
    check('the session promise resolved with the session row (schema 1, the sovereign mode, the Bash tool)', session.type === 'session' && session.schema === 1 && session.mode === 'sovereign' && session.tools.includes('Bash'), j({ schema: session.schema, mode: session.mode }))
    check('the text events carried the two text rows', texts.join('|') === 'Running it.|The door answered.', j(texts))
    const turn = run.rows.find(row => row.type === 'turn')
    check('the outcome closes the turn its turn row opened, with the answer', turn?.type === 'turn' && outcome.turn_id === turn.turn_id && outcome.turn === 1 && outcome.answer === 'The door answered.', j({ turn: turn?.type === 'turn' ? turn.turn_id : undefined, outcome: outcome.turn_id }))
    const steps = run.rows.filter(row => row.type === 'step' && sdk.isMainThread(row))
    const sum = (key: 'input_tokens' | 'output_tokens'): number => steps.reduce((total, row) => total + (row.type === 'step' ? row.usage[key] : 0), 0)
    check('the outcome usage is the fold of the main-thread step rows the door wrote (input and output tokens)', steps.length === 2 && outcome.usage.input_tokens === sum('input_tokens') && outcome.usage.output_tokens === sum('output_tokens'), j({ steps: steps.length, usage: outcome.usage }))
    check('the outcome carries the per-model usage, a cost and no denials', Object.keys(outcome.models).length >= 1 && typeof outcome.cost_usd === 'number' && outcome.denials.length === 0, j({ models: Object.keys(outcome.models), cost: outcome.cost_usd }))
    const toolCall = run.rows.find(row => row.type === 'tool_call')
    const toolResult = run.rows.find(row => row.type === 'tool_result')
    check('the typed tool rows: one tool_result per tool_call on the same call id, the output the model saw', toolCall?.type === 'tool_call' && toolResult?.type === 'tool_result' && toolCall.call_id === toolResult.call_id && toolResult.output.includes('sdk-door') && toolCall.tool === 'Bash', j({ toolCall, toolResult }))
    check('the end event fired once the door closed and stderr stayed empty', endSeen && exit.stderr === '', j(exit))
    check('the argv the package spelled is the run door\'s', run.args.join(' ') === `${dist} run --format rows --mode sovereign --partial -- run the command`, run.args.join(' '))
  } finally {
    await door.close()
  }
}

section('C2 every declared row type has a parser: the product\'s own writers produce rows the package accepts, and each one lands on its own type')
{
  const scope = { session_id: 'sess-1', turn: 2 }
  const stamper = project.createRowStamper(() => '2026-10-04T00:00:00.000Z')
  const usage = { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } }
  const projected: Record<string, unknown[]> = {
    session: [project.sessionRow(scope, { version: '1.0.0', cwd: '/w', model: 'm', mode: 'default', tools: ['Bash'], mcpServers: [{ name: 's', status: 'connected' }], commands: ['/help'], agents: ['a'], skills: ['k'], extensions: [{ name: 'e', path: '/e', id: 'e1' }] })],
    turn: [project.turnStartedRow(scope, { turnId: 't-1', messageIds: ['m-1'], model: 'm' }), project.turnWaitingRow(scope, { turnId: 't-1', agents: 2 })],
    text: project.itemRowsOf(scope, 'm-1', [{ type: 'text', text: 'hello', phase: 'final_answer' }]),
    reasoning: project.itemRowsOf(scope, 'm-1', [{ type: 'thinking', thinking: 'hm' }, { type: 'redacted_thinking' }]),
    tool_call: project.itemRowsOf(scope, 'm-1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
    tool_result: project.toolResultRowsOf(scope, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }]),
    tool_update: [project.toolUpdateRow(scope, { callId: 'toolu_1', tick: 1, source: 'shell', line: 'x', elapsedS: 1.5 })],
    step: [project.stepRow(scope, { messageId: 'm-1', model: 'm', stopReason: 'end_turn', usage })],
    outcome: [project.outcomeRow(scope, { turnId: 't-1', status: 'completed', stopReason: 'end_turn', answer: 'done', steps: 1, wallMs: 10, apiMs: 5, costUsd: 0.01, usage, models: project.modelUsageRows({ m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01 } }), denials: [] })],
    wait: [project.waitRow(scope, null), project.retryWaitRow(scope, { attempt: 1, of: 3, reason: 'overloaded', delayMs: 100, httpStatus: 529, sinceMs: 0 })],
    heartbeat: [project.heartbeatRow(scope)],
    compaction: [project.compactionRow(scope, null, 'manual'), project.compactionEndedRow(scope, { trigger: 'auto', tokensBefore: 1000 }), project.compactionClearedRow(scope, 'auto')],
    mode: [project.modeRow(scope, 'default')],
    rate_limit: [project.rateLimitRow(scope, { status: 'allowed_warning', isUsingOverage: false, utilization: 0.9 })],
    task: [project.taskRow(scope, { state: 'started', taskId: 'task-1', description: 'd' })],
    notice: [project.noticeRow(scope, 'warning', 'careful', 'w1')],
    command_output: [project.commandOutputRow(scope, 'out', '/status')],
    mission_updated: [project.missionUpdatedRow(scope)],
    samples_updated: [project.samplesUpdatedRow(scope)],
    block_start: project.partialRowsOf(scope, 'm-1', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    text_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }),
    reasoning_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'h' } }),
    tool_input_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c' } }),
    retracted: [project.retractedRow(scope, 'm-1')],
  }
  const everyType = [...sdk.ROW_TYPES, ...sdk.PARTIAL_ROW_TYPES]
  check(`${everyType.length} declared row types, each with a schema in ROW_SCHEMAS and a projector arm here`, everyType.every(type => sdk.ROW_SCHEMAS[type] !== undefined && (projected[type]?.length ?? 0) > 0), everyType.filter(type => sdk.ROW_SCHEMAS[type] === undefined || (projected[type]?.length ?? 0) === 0).join(','))
  check('no projector arm names a type outside the generated vocabulary', Object.keys(projected).every(type => (everyType as readonly string[]).includes(type)))
  for (const type of everyType) {
    for (const draft of projected[type] ?? []) {
      const stamped = stamper.stamp(draft as never) as Record<string, unknown>
      const read = sdk.rowOf(stamped)
      check(`${type} row written by the product parses through the package's ${type} schema`, read.ok && read.row.type === type, read.ok ? '' : j({ reason: read.reason, issues: read.issues.slice(0, 3) }))
      const line = sdk.parseRow(JSON.stringify(stamped))
      check(`${type} row round-trips through parseRow`, line.ok && JSON.stringify(line.row) === JSON.stringify(stamped))
    }
  }
  const session = stamper.stamp(projected.session![0] as never) as Record<string, unknown>
  const mismatch = sdk.rowOf({ ...session, schema: 2 })
  check('a session row of another schema number is refused as schema_mismatch (never mis-read)', !mismatch.ok && mismatch.reason === 'schema_mismatch' && mismatch.schema === 2)
  const extra = sdk.rowOf({ ...stamper.stamp(project.heartbeatRow(scope)), extra: 'later' })
  check('a row with a key the vocabulary does not declare still parses (the product accepts and strips unknown keys; the package accepts them too)', extra.ok)
  const broken = sdk.rowOf({ ...stamper.stamp(project.noticeRow(scope, 'warning', 'x')), level: 'loud' })
  check('a row whose field breaks its schema is refused with the path and the message', !broken.ok && broken.reason === 'invalid' && broken.issues.some(issue => issue.path === 'level' && issue.message.includes('expected one of')), j(broken))
  check('a frame of another kind reads unknown_type; a non-object reads not_an_object; a torn line reads not_json', (() => { const a = sdk.rowOf({ type: 'assistant' }); const b = sdk.rowOf('text'); const c = sdk.parseRow(JSON.stringify(session).slice(0, 20)); return !a.ok && a.reason === 'unknown_type' && !b.ok && b.reason === 'not_an_object' && !c.ok && c.reason === 'not_json' })())
  const prompt = sdk.inputRowOf({ type: 'prompt', content: [{ type: 'text', text: 'hi' }, { type: 'image', media_type: 'image/png', data: 'AA==' }], priority: 'next' })
  const badPriority = sdk.inputRowOf({ type: 'prompt', content: 'hi', priority: 'soon' })
  check('the input rows parse through the generated input schemas and an unknown priority is refused', prompt.ok && !badPriority.ok && badPriority.reason === 'invalid')
}

section('C3 the door\'s refusals and exits surface as typed errors')
{
  const door = await openDoor([{ kind: 'text', text: 'never reached' }])
  try {
    const before = door.api.messageRequests().length
    const unknown = sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env, extraArgs: ['--frobnicate'] })
    const unknownError = await errorOf(withTimeout(unknown.outcome, 60_000, 'the unknown-option run'))
    const unknownExit = await unknown.exit
    check('an unknown option is a MercuryUsageError: exit 2, the parser\'s stderr line, no row on stdout', unknownError instanceof sdk.MercuryUsageError && unknownExit.code === 2 && unknownError.message.startsWith("error: unknown option '--frobnicate'") && unknown.rows.length === 0, j({ name: (unknownError as Error)?.name, message: (unknownError as Error)?.message, exit: unknownExit }))
    const iteratorError = await errorOf((async () => { for await (const row of sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env, extraArgs: ['--frobnicate'] })) void row })())
    check('the async iterator throws the same typed error after the stream ends', iteratorError instanceof sdk.MercuryUsageError)
    const conflict = sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env, sovereign: true, mode: 'flow' })
    const conflictError = await errorOf(withTimeout(conflict.outcome, 60_000, 'the conflicting-posture run'))
    const conflictExit = await conflict.exit
    check('--sovereign beside --mode is a MercuryRefusal carrying the refused outcome row: class option, exit 2, the door\'s sentence', conflictError instanceof sdk.MercuryRefusal && conflictError.errorClass === 'option' && conflictError.outcome.status === 'refused' && conflictError.outcome.schema === 1 && conflictExit.code === 2 && conflictError.message.includes('--sovereign') && conflictError.message.includes('--mode'), j({ name: (conflictError as Error)?.name, message: (conflictError as Error)?.message, exit: conflictExit }))
    check('the refused outcome row is also the one row of the stream, typed', conflict.rows.length === 1 && conflict.rows[0]?.type === 'outcome' && conflict.rows[0] === (conflictError as InstanceType<typeof sdk.MercuryRefusal>).outcome)
    const sessionError = await errorOf(conflict.session)
    check('the session promise rejects with the same refusal when no session row was written', sessionError === conflictError)
    const empty = sdk.run({ prompt: '', mercury, cwd: door.home, env: door.env })
    const emptyError = await errorOf(withTimeout(empty.outcome, 60_000, 'the empty-prompt run'))
    check('an empty prompt is a MercuryRefusal (exit 2) that names mercury run', emptyError instanceof sdk.MercuryRefusal && (await empty.exit).code === 2 && /mercury run/.test(emptyError.message), j({ name: (emptyError as Error)?.name, message: (emptyError as Error)?.message }))
    const apollo = sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env, mode: 'apollo' })
    const apolloError = await errorOf(withTimeout(apollo.outcome, 60_000, 'the apollo run'))
    check('apollo on a hostless run is a MercuryRefusal with its reason', apolloError instanceof sdk.MercuryRefusal && /apollo needs a host/.test(apolloError.message) && (await apollo.exit).code === 2, j({ message: (apolloError as Error)?.message }))
    const turns = sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env, maxTurns: 0 })
    const turnsError = await errorOf(withTimeout(turns.outcome, 60_000, 'the max-turns run'))
    check('--max-turns 0 is a MercuryRefusal (the option table refuses it through the envelope)', turnsError instanceof sdk.MercuryRefusal && /--max-turns/.test(turnsError.message) && (await turns.exit).code === 2, j({ message: (turnsError as Error)?.message }))
    check('no refusal reached the model', door.api.messageRequests().length === before)
    const absent = sdk.run({ prompt: 'hello', mercury: join(door.home, 'no-such-mercury'), cwd: door.home, env: door.env })
    const absentError = await errorOf(withTimeout(absent.outcome, 60_000, 'the absent-executable run'))
    check('an executable that cannot start is a MercurySpawnError naming the command', absentError instanceof sdk.MercurySpawnError && absentError.command === join(door.home, 'no-such-mercury'), j({ name: (absentError as Error)?.name, message: (absentError as Error)?.message }))
  } finally {
    await door.close()
  }
}

section('C4 a turn the model fails and a turn the caller interrupts resolve as outcomes with the door\'s status and exit code')
{
  const door = await openDoor([{ kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'The fixture refuses this request.' }])
  try {
    const run = sdk.run({ prompt: 'hello', mercury, cwd: door.home, env: door.env })
    const outcome = await withTimeout(run.outcome, 90_000, 'the failed turn')
    const exit = await run.exit
    check('a model error is not a thrown error: the outcome resolves with status failed, an error class, and exit 1', outcome.status === 'failed' && outcome.error !== undefined && sdk.ERROR_CLASSES.includes(outcome.error.class) && exit.code === 1 && sdk.OUTCOME_EXIT_CODES.failed === 1, j({ status: outcome.status, error: outcome.error, exit }))
    check('outcomeFailed and outcomeErrorText read the row', sdk.outcomeFailed(outcome) && sdk.outcomeErrorText(outcome) === outcome.error?.message)
  } finally {
    await door.close()
  }
  const hang = await openDoor([{ kind: 'hang', deltas: ['The turn is open.'] }])
  try {
    const run = sdk.run({ prompt: 'hello', mercury, cwd: hang.home, env: hang.env })
    void hang.api.messageRequestStarted(1).then(() => run.interrupt())
    const outcome = await withTimeout(run.outcome, 90_000, 'the interrupted turn')
    const exit = await run.exit
    check('interrupt() sends SIGINT: the door flushes an interrupted outcome and exits 130', outcome.status === 'interrupted' && exit.code === 130, j({ status: outcome.status, exit }))
    check('the interrupted outcome is the last row and the iterator would have ended cleanly', run.rows.at(-1) === outcome && run.error === null)
  } finally {
    await hang.close()
  }
  const aborted = await openDoor([{ kind: 'hang', deltas: ['The turn is open.'] }])
  try {
    const controller = new AbortController()
    const run = sdk.run({ prompt: 'hello', mercury, cwd: aborted.home, env: aborted.env, signal: controller.signal })
    void aborted.api.messageRequestStarted(1).then(() => controller.abort())
    const outcome = await withTimeout(run.outcome, 90_000, 'the aborted turn')
    check('an AbortSignal interrupts the same way', outcome.status === 'interrupted' && (await run.exit).code === 130, j({ status: outcome.status }))
  } finally {
    await aborted.close()
  }
}

section('C5 the argv builder spells only options the door declares, with the value shape the door reads')
{
  const everything = sdk.argvOf({
    prompt: 'the prompt',
    project: '/p',
    model: 'm',
    effort: 'max',
    backupModel: 'b',
    agent: 'a',
    mode: 'implement',
    allowSovereign: true,
    allowedTools: ['Read', 'Bash(git *)'],
    blockTools: ['Edit'],
    toolset: ['core'],
    mcp: ['{"x":1}'],
    onlyMcp: true,
    brief: 'brief',
    briefAdd: 'more',
    schema: { type: 'object' },
    maxTurns: 3,
    budgetUsd: 2.5,
    partial: true,
    config: { engine: { model: 'm' } },
    configLayers: ['user', 'project'],
    extensions: ['/e1', '/e2'],
    sessionId: '00000000-0000-4000-8000-000000000000',
    title: 't',
    resume: 'id',
    continue: true,
    fork: true,
    ephemeral: true,
    lean: true,
    advise: true,
    noCommands: true,
    providerPreview: ['beta-1'],
    logFile: '/log',
    extraArgs: ['--reasoning-mode', 'adaptive'],
  })
  const options = new Map(sdk.RUN_OPTIONS.map(option => [option.flag, option]))
  const args = everything.args
  check('the command is the installed launcher by default and --project comes before run', everything.command === 'mercury' && args[0] === '--project' && args[1] === '/p' && args[2] === 'run' && args[3] === '--format' && args[4] === 'rows', args.join(' '))
  const boundary = args.indexOf('--')
  check('the prompt rides after the -- boundary, last', boundary > 0 && args.length === boundary + 2 && args[boundary + 1] === 'the prompt')
  const unknownFlags: string[] = []
  const badValues: string[] = []
  const used: string[] = []
  for (let i = 3; i < boundary; i++) {
    const token = args[i]!
    if (!token.startsWith('-')) {
      badValues.push(`a value with no flag: ${token}`)
      continue
    }
    const option = options.get(token)
    if (option === undefined) {
      unknownFlags.push(token)
      continue
    }
    used.push(token)
    if (option.value === 'none') continue
    if (option.value === 'required' || option.value === 'optional') {
      const next = args[i + 1]
      if (next === undefined || next.startsWith('-')) badValues.push(`${token} has no value`)
      else if (option.choices !== undefined && !(option.choices as readonly string[]).includes(next)) badValues.push(`${token} ${next} is not a choice`)
      i++
      continue
    }
    while (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
  }
  check('every flag the builder emits is a run-door option read from the tree', unknownFlags.length === 0, unknownFlags.join(','))
  check('every valued flag carries a value, every choice flag a declared choice, every switch no value', badValues.length === 0, badValues.join('; '))
  check(`the builder reaches ${used.length} of the door's ${sdk.RUN_OPTIONS.length} options (the rest are hidden, resume-only, or the caller's extraArgs)`, used.length >= 30, j(used))
  check('the run door exposes no interactive boot switch', ['--chat', '--concourse-off', '--concourse-on', '--multiplex', '--pr'].every(flag => !options.has(flag)))
  check('the generated option table knows --format rows, --input rows, --partial and the effort ladder', options.get('--format')?.choices?.includes('rows') === true && options.get('--input')?.choices?.includes('rows') === true && options.get('--partial')?.value === 'none' && j(options.get('--effort')?.choices) === j(sdk.EFFORT_LEVELS) && j(options.get('--mode')?.choices) === j(sdk.PERMISSION_MODES))
  const bare = sdk.argvOf({ prompt: '-', mercury: '/x/mercury' })
  check('a bare run spells run --format rows -- <prompt>, the stdin marker included', bare.command === '/x/mercury' && bare.args.join(' ') === 'run --format rows -- -')
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-run-door-client: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-run-door-client: the package drives the real run door, reads every row and surfaces every refusal as a typed error')
