#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startFixtureApi } from '../lib/fixtureApi.ts'
const core = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const control = await import('../../src/entrypoints/sdk/controlSchemas.ts')
const ladderModule = await import('../../src/utils/effortLadder.ts')
const seatWire = await import('../../src/services/engine-connector/seatWire.ts')
const mappers = await import('../../src/utils/messages/mappers.ts')
const rows = await import('../../src/rows/vocabulary.ts')
const project = await import('../../src/rows/project.ts')
const fold = await import('../../src/services/compact/foldStatus.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/

function keyPaths(value: unknown, path = '', opaque: readonly string[] = [], out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach(item => keyPaths(item, `${path}[]`, opaque, out))
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key
      if (opaque.some(o => path === o || path.endsWith(`.${o}`) || path.endsWith(`]${o}`))) continue
      out.push(here)
      keyPaths(inner, here, opaque, out)
    }
  }
  return out
}
const lastSegment = (dotted: string): string => dotted.split('.').pop()!.replace(/\[\]$/, '')

section('F1 — the row vocabulary declares the rows the product writes (a run on the fixture)')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    check('dist/mercury.mjs exists (build first — F1 drives the artifact)', false)
  } else {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'feed-shapes-')))
    const api = await startFixtureApi([
      { kind: 'tool_use', name: 'Bash', input: { command: 'echo feed-shapes' }, preText: 'Running it.', thinking: 'a short think' },
      { kind: 'text', text: 'The feed answered.' },
    ])
    writeFileSync(join(root, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['fixture-key-feed-shapes'.slice(-20)] }, projects: { [root]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
    const env = { HOME: root, PATH: process.env.PATH, MERCURY_CONFIG_DIR: root, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(root, 'daemon'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-feed-shapes', TMPDIR: tmpdir() }
    const child = spawn('node', [dist, 'run', 'run the command', '--format', 'rows', '--partial', '--mode', 'sovereign'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', data => (out += data))
    child.stderr.on('data', data => (err += data))
    child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
    const code = await new Promise<number | null>(resolve => child.on('close', c => { clearTimeout(timeout); resolve(c) }))
    await api.close()
    const lines = out.split('\n').filter(line => line.trim() !== '')
    const parsed: Array<Record<string, unknown>> = []
    let torn = 0
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        torn++
      }
    }
    const declared = new Set<string>([...rows.ROW_TYPES, ...rows.PARTIAL_ROW_TYPES])
    const emitted = [...new Set(parsed.map(row => String(row.type)))]
    const schema = rows.RowSchema()
    const refused = parsed.map(row => ({ row, parsed: schema.safeParse(row) })).filter(entry => !entry.parsed.success)
    check('the run completed with exit 0', code === 0, `exit=${code} stderr=${err.slice(0, 200)}`)
    check('every stdout line is one JSON row', torn === 0 && parsed.length > 0, `${torn} torn of ${lines.length}`)
    check('every emitted row type is declared in the vocabulary', emitted.every(type => declared.has(type)), j(emitted.filter(type => !declared.has(type))))
    check('every emitted row parses through its declared schema', refused.length === 0, j(refused.slice(0, 2).map(entry => ({ type: entry.row.type, issues: entry.parsed.success ? [] : entry.parsed.error.issues.slice(0, 2) }))))
    const coreRows = ['session', 'turn', 'reasoning', 'text', 'tool_call', 'tool_result', 'step', 'outcome', 'block_start', 'text_delta', 'reasoning_delta', 'tool_input_delta']
    check('a tool turn with partial rows writes the core rows', coreRows.every(type => emitted.includes(type)), j({ missing: coreRows.filter(type => !emitted.includes(type)), emitted }))
    const seqs = parsed.map(row => Number(row.seq))
    check('seq is contiguous from 1', seqs.every((seq, i) => seq === i + 1), j(seqs.slice(0, 12)))
    check('the session row comes first and the outcome last', parsed[0]?.type === 'session' && parsed.at(-1)?.type === 'outcome')
    const turnRow = parsed.find(row => row.type === 'turn')
    const outcome = parsed.at(-1)
    check('the outcome closes the turn its turn row opened', turnRow !== undefined && outcome?.turn_id === turnRow.turn_id && outcome?.turn === 1 && outcome?.status === 'completed' && outcome?.answer === 'The feed answered.', j({ turn: turnRow?.turn_id, outcome: outcome?.turn_id, status: outcome?.status }))
    const toolCall = parsed.find(row => row.type === 'tool_call')
    const toolResult = parsed.find(row => row.type === 'tool_result')
    check('exactly one tool_result per tool_call, same call id', toolCall !== undefined && toolResult !== undefined && toolCall.call_id === toolResult.call_id && parsed.filter(row => row.type === 'tool_result').length === parsed.filter(row => row.type === 'tool_call').length, j({ call: toolCall?.call_id, result: toolResult?.call_id }))
    check('the tool result carries what the model saw', String(toolResult?.output ?? '').includes('feed-shapes'), j(toolResult?.output))
    const steps = parsed.filter(row => row.type === 'step')
    check('one step per model call, and the outcome counts them', steps.length === 2 && outcome?.steps === 2, j({ steps: steps.length, counted: outcome?.steps }))
    check('every in-turn row carries turn 1 and the session id; the session row carries no turn', parsed.slice(1).every(row => row.turn === 1 && row.session_id === parsed[0]?.session_id) && parsed[0]?.turn === undefined)
    check('no row carries a uuid or a parent_tool_use_id', parsed.every(row => !('uuid' in row) && !('parent_tool_use_id' in row)))
    const controlSrc = readFileSync(join(ROOT, 'src/entrypoints/sdk/controlSchemas.ts'), 'utf8')
    const controlNames = ['provider_sign_in', 'provider_sign_in_callback', 'provider_sign_in_wait', 'host_mcp_servers']
    check('the sign-in verbs and the host MCP list are declared under their names', controlNames.every(word => controlSrc.includes(`'${word}'`) || controlSrc.includes(`${word}:`)), j(controlNames.filter(w => !controlSrc.includes(w))))
    const mcpTypesSrc = readFileSync(join(ROOT, 'src/services/mcp/types.ts'), 'utf8')
    check("the MCP kind word for a host-served server is 'host'", mcpTypesSrc.includes("z.literal('host')"))
    rmSync(root, { recursive: true, force: true })
  }
}

section('F2 — every declared key is snake_case')
{
  const scan = (src: string): string[] => {
    const keys: string[] = []
    for (const line of src.split('\n')) {
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\??:\s+z\b/.exec(line)
      if (m) keys.push(m[1]!)
    }
    return keys
  }
  const coreKeys = scan(readFileSync(join(ROOT, 'src/entrypoints/sdk/coreSchemas.ts'), 'utf8'))
  const controlKeys = scan(readFileSync(join(ROOT, 'src/entrypoints/sdk/controlSchemas.ts'), 'utf8'))
  check('the message schemas declare snake_case keys only', coreKeys.length > 0 && coreKeys.every(key => SNAKE.test(key)), j(coreKeys.filter(key => !SNAKE.test(key))))
  check('the control schemas declare snake_case keys only', controlKeys.length > 0 && controlKeys.every(key => SNAKE.test(key)), j(controlKeys.filter(key => !SNAKE.test(key))))
}

section('F3 — the seat-wire codecs: snake keys out, deep-equal back')
{
  const facts = {
    model: { effective: 'claude-opus-5', setting: null },
    usage: {
      totalCostUSD: 1.25,
      totalAPIDurationMs: 40,
      totalDurationMs: 90,
      totalLinesAdded: 3,
      totalLinesRemoved: 1,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheReadInputTokens: 5,
      totalCacheCreationInputTokens: 6,
      hasUnknownModelCost: false,
      unpricedTurns: 2,
      limitWarning: { provider: 'anthropic', text: 'near the window' },
      openaiObserved: {
        primary: { usedPct: 40, windowMinutes: 300, resetsAtMs: 10, observedAtMs: 9 },
        secondary: { usedPct: 10, observedAtMs: 8 },
      },
    },
    identity: { firstPartyApi: true, consoleBilling: false, claudeAiBilling: true, accountEmail: 'a@b.test' },
    skills: [{ name: 'debug', description: 'd', state: 'invocable' as const }],
    mcp: [{ name: 'mercury', type: 'connected' as const }, { name: 'ghost', type: 'failed' as const, error: 'gone' }],
    permissionMode: 'default' as never,
    effortSent: 'high',
    workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w' },
    queue: [{ uuid: 'u1', value: 'hi', mode: 'prompt' as never, priority: 'next' as const }],
    work: [
      {
        id: 'w1',
        kind: 'workflow' as const,
        name: 'deploy',
        status: 'running',
        startTime: 1,
        endTime: 2,
        description: 'd',
        model: 'm',
        error: 'e',
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 6,
        contextTokens: 7,
        costUSD: 0.5,
        unpricedTurns: 1,
        toolUses: 3,
        activity: 'act',
        wait: 'waiting for a seat',
        toolUseId: 'tu1',
        workflowRunId: 'r1',
        phases: [{ title: 'p', planned: true, agents: [{ index: 0, label: 'l', state: 's' }] }],
        agentCount: 1,
        pulse: { phaseTitle: 'p', running: 1, settled: 0, maxAttempt: 2, lastEventAt: 5 },
        pendingAsks: 1,
        agentType: 'mercury-crew',
        crew: 't',
        stopReason: 'operator',
        phase: { phase: 'first-byte' as never, sinceMs: 1, budgetMs: 2, reason: 'r', attempt: 1, of: 3 },
      },
    ],
    mission: [{ id: 'm1', subject: 's', activeForm: 'doing', status: 'in_progress' as const, blocks: ['m2'], blockedBy: ['m0'], ledger: 'L' }],
    kit: {
      schema: 1 as const,
      mcp: ['alpha'],
      skills: ['s1'],
      invocable: ['s2'],
      skillsOff: ['s3'],
      extensions: { 'ext-a': 'on' as const, 'ext-b': 'off' as const },
      resolved: false as const,
      deltas: { mcpOff: ['beta'], skillStates: { 's:inv': 'invocable' as const, 's:off': 'off' as const }, extensionsOff: ['quiet'] },
    },
    pendingScheduleEdits: [
      {
        op: 'add' as const,
        schedule: {
          when: { kind: 'at', atMs: 5, spelling: 'in 5 minutes' },
          action: { kind: 'birth', birth: { workspaceDir: '/w', modelKey: 'm', effort: 'high', contract: null, kitPreset: 'p', opening: 'go', presence: 'headless', title: 't' } },
          modelKey: 'm',
          effort: 'high',
          note: 'n',
        },
      },
      { op: 'remove' as const, scheduleId: 'abcdef01' },
    ],
    fileCheckpoints: { capture: true, restorable: ['u1'] },
    streamIdleTimeoutMs: 90_000,
    spawnSwitches: { subagents: { on: true, source: 'default' }, workflows: { on: false, source: 'session' } },
    box: {
      atMs: 5,
      cores: 8,
      loadPerCore: 1.25,
      memory: { availableMb: 2048, totalMb: 8192 },
      lock: { dir: '/tmp/box', holders: [{ slot: 1, pid: 4242, label: 'lane-a', since: '08:00:00', alive: true }], waiters: [{ label: 'lane-b', waitedS: 12 }] },
      lockNote: 'a note',
    },
  }
  const opaque = ['kit.extensions', 'kit.deltas.skill_states', 'spawn_switches']
  const wire = seatWire.sessionFactsToWire(facts as never)
  const paths = keyPaths(wire, '', opaque)
  const camel = paths.filter(p => !SNAKE.test(lastSegment(p)))
  check('the facts answer encodes to snake_case keys at every depth (outside the name-keyed maps)', camel.length === 0, j(camel))
  check('the spawn switch kinds and the name-keyed maps keep their keys', deepEq(Object.keys((wire as { spawn_switches: object }).spawn_switches), ['subagents', 'workflows']) && deepEq(Object.keys(((wire as { kit: { extensions: object } }).kit).extensions), ['ext-a', 'ext-b']), j(wire))
  const back = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(wire)))
  check('the facts answer decodes back deep-equal', deepEq(back, facts), j(back).slice(0, 400))
  const wireBox = (wire as { box: { at_ms: number; load_per_core: number; lock_note: string; memory: { available_mb: number }; lock: { waiters: Array<{ waited_s: number }> } } }).box
  check('the box row rides the wire in snake_case at every depth', wireBox.at_ms === 5 && wireBox.load_per_core === 1.25 && wireBox.lock_note === 'a note' && wireBox.memory.available_mb === 2048 && wireBox.lock.waiters[0]!.waited_s === 12, j(wireBox))
  check('a facts answer missing its required fields decodes null', seatWire.sessionFactsFromWire({ model: { effective: 'x' } }) === null && seatWire.sessionFactsFromWire('no') === null)
  const minimal = { model: { effective: 'x', setting: null }, usage: { total_cost_usd: 0 }, skills: [], mcp: [], permission_mode: 'default', workspace: { cwd: '/w' }, queue: [] }
  const minimalBack = seatWire.sessionFactsFromWire(minimal)
  check('the minimal answer every runner writes decodes', minimalBack !== null && minimalBack.permissionMode === ('default' as never) && (minimalBack.usage as { totalCostUSD: number }).totalCostUSD === 0, j(minimalBack))

  const rewind = { outcome: 'applied' as const, mode: 'both' as const, dryRun: true, code: { filesChanged: ['a'], insertions: 1, deletions: 2 }, conversation: { turnUuid: 'u', removed: 3 } }
  const rewindWire = seatWire.rewindOutcomeToWire(rewind)
  check('the rewind receipt encodes to snake keys', keyPaths(rewindWire).every(p => SNAKE.test(lastSegment(p))), j(rewindWire))
  check('the rewind receipt decodes back deep-equal', deepEq(seatWire.rewindOutcomeFromWire(JSON.parse(JSON.stringify(rewindWire))), rewind))
  check('a refused receipt round-trips and a non-receipt decodes null', deepEq(seatWire.rewindOutcomeFromWire(seatWire.rewindOutcomeToWire({ outcome: 'refused', mode: 'code', refusal: 'drift', detail: 'alpha' })), { outcome: 'refused', mode: 'code', refusal: 'drift', detail: 'alpha' }) && seatWire.rewindOutcomeFromWire({ outcome: 'weird', mode: 'code' }) === null)

  const kitWire = seatWire.sessionKitToWire(facts.kit)
  check('the kit encodes to snake keys outside its name-keyed maps', keyPaths(kitWire, '', ['extensions', 'deltas.skill_states']).every(p => SNAKE.test(lastSegment(p))), j(kitWire))
  check('the kit decodes back deep-equal', deepEq(seatWire.sessionKitFromWire(JSON.parse(JSON.stringify(kitWire))), facts.kit))

  const rows = [{ id: 'abcdef01', when: 'every day', nextFireMs: 5, kind: 'fire' as const, paused: true as const }, { id: 'abcdef02', when: 'at noon', nextFireMs: null, kind: 'birth' as const }]
  const rowsWire = seatWire.scheduleRosterToWire(rows)
  check('the schedule roster rows encode to snake keys and decode back', keyPaths(rowsWire).every(p => SNAKE.test(lastSegment(p))) && deepEq(seatWire.scheduleRosterFromWire(JSON.parse(JSON.stringify(rowsWire))), rows), j(rowsWire))

  const catalogue = { sourceKind: 'api-key', models: [{ id: 'gpt-x', ownedBy: 'openai' }], fetchedAtMs: 7 }
  const catalogueWire = seatWire.openaiCatalogueToWire(catalogue)
  check("the catalogue snapshot encodes its own keys and leaves the provider's rows untouched", deepEq(catalogueWire, { source_kind: 'api-key', models: catalogue.models, fetched_at_ms: 7 }) && deepEq(seatWire.openaiCatalogueFromWire(JSON.parse(JSON.stringify(catalogueWire))), catalogue), j(catalogueWire))
}

section('F4 — the effort enum on the wire is the one ladder')
{
  type EnumLike = { options?: unknown[]; def?: { options?: unknown[] }; element?: EnumLike; unwrap?: () => EnumLike }
  const shape = (core.ModelInfoSchema() as unknown as { shape: Record<string, EnumLike> }).shape
  const levels = shape.supported_effort_levels!.unwrap!().element!
  const ladder = [...ladderModule.EFFORT_LEVELS]
  check('a model row\'s supported effort levels enumerate the ladder', deepEq(levels.options ?? levels.def?.options, ladder), j(levels.options ?? levels.def?.options))
  check('the ladder ends at max', ladder[ladder.length - 1] === 'max', j(ladder))
}

section('F5 — the wait, fold, usage and context projections spell snake_case')
{
  const scope = { session_id: 's', turn: 1 }
  const wait = { kind: 'first-byte' as const, cold: true, promptTokens: 58_000, model: 'Opus 5', budgetMs: 160_000, sinceMs: 5, attempt: 1 }
  const waitRow = project.waitRow(scope, wait)
  check('the request wait projects to a wait row with snake keys', waitRow.type === 'wait' && waitRow.state === 'first_byte' && keyPaths(waitRow).every(p => SNAKE.test(lastSegment(p))) && waitRow.prompt_tokens === 58_000, j(waitRow))
  check('a wait of null projects to the done state', deepEq(project.waitRow(scope, null), { type: 'wait', state: 'done', session_id: 's', turn: 1 }))
  const retry = project.retryWaitRow(scope, { attempt: 2, of: 3, reason: 'a 529', delayMs: 800, httpStatus: 529, sinceMs: 9 })
  check('the retry wait names its attempt, place, reason and delay', retry.state === 'retry' && retry.attempt === 2 && retry.of === 3 && retry.reason === 'a 529' && retry.delay_ms === 800 && retry.http_status === 529, j(retry))
  const foldRecord = { schema: 1 as const, trigger: 'auto' as const, startedAtMs: 1, stages: ['summarising' as const, 'restoring' as const], stage: 'summarising' as const, fill: 0.5, summaryTokens: 10, summaryCapTokens: 20, attempt: 1 }
  const foldRow = project.compactionRow(scope, foldRecord)
  check('the fold record projects to a compaction row in progress with snake keys', foldRow.type === 'compaction' && foldRow.state === 'progress' && foldRow.stage === 'summarising' && foldRow.fill === 0.5 && foldRow.summary_cap_tokens === 20 && keyPaths(foldRow).every(p => SNAKE.test(lastSegment(p))), j(foldRow))
  check('a fold with an exit projects to the ended state', project.compactionRow(scope, { ...foldRecord, exit: 'landed' as const, endedAtMs: 9 }).state === 'ended')
  check('the bare word projects to the started state', project.compactionRow(scope, null).state === 'started')
  check('the fold decoder still reads its own record', deepEq(fold.decodeFoldStatus({ ...foldRecord }), foldRecord))
  const usage = project.modelUsageRows({ 'claude-opus-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, webSearchRequests: 0, costUSD: 0.1, contextWindow: 200_000, maxOutputTokens: 64_000 } })
  check('the per-model usage keeps the model id as its key, counts the whole prompt as input and spells the fields snake_case', deepEq(usage, { 'claude-opus-5': { input_tokens: 8, cached_input_tokens: 3, cache_write_input_tokens: 4, output_tokens: 2, cost_usd: 0.1, web_searches: 0 } }), j(usage))
  check('an unpriced model carries no cost', !('cost_usd' in (project.modelUsageRows({ m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } }, () => true).m ?? {})))
  const context = mappers.toSDKContextUsage({ totalTokens: 1, maxTokens: 2, rawMaxTokens: 2, percentage: 0, gridRows: [[{ color: 'c', isFilled: true, categoryName: 'n', tokens: 1, percentage: 0, squareFullness: 1 }]], model: 'm', categories: [], memoryFiles: [], mcpTools: [{ name: 'x', serverName: 's', tokens: 1, isLoaded: true }], agents: [], isAutoCompactEnabled: true, countsAvailable: true, apiUsage: null } as never)
  check('the context usage answer spells every key snake_case at every depth', keyPaths(context).every(p => SNAKE.test(lastSegment(p))) && (context as { grid_rows: unknown[][] }).grid_rows[0]![0] !== undefined, j(keyPaths(context).filter(p => !SNAKE.test(lastSegment(p)))))
}

section('F6 — the rows carry their schema word')
check('the rows schema is 1', rows.ROWS_SCHEMA === 1, String(rows.ROWS_SCHEMA))
check('the session row and the outcome declare it', rows.SessionRowSchema().shape.schema.value === 1 && rows.OutcomeRowSchema().shape.schema.value === 1)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ feed shapes: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ feed shapes: all legs green')
process.exit(0)
