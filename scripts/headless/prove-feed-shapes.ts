#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const core = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const control = await import('../../src/entrypoints/sdk/controlSchemas.ts')
const coreTypes = await import('../../src/entrypoints/sdk/coreTypes.ts')
const runtime = await import('../../src/entrypoints/sdk/runtimeTypes.ts')
const seatWire = await import('../../src/services/engine-connector/seatWire.ts')
const mappers = await import('../../src/utils/messages/mappers.ts')
const idle = await import('../../src/services/providers/streamIdleBudget.ts')
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

section('F1 — the declared frame types are the ones the product writes; the retired names are gone')
{
  type AnyZod = { options?: AnyZod[]; shape?: Record<string, AnyZod>; value?: unknown; values?: Iterable<unknown>; def?: { options?: AnyZod[]; shape?: Record<string, AnyZod> } }
  const literalOf = (schema: AnyZod | undefined): string | undefined => {
    if (!schema) return undefined
    if (typeof schema.value === 'string') return schema.value
    if (schema.values) return [...schema.values].find((v): v is string => typeof v === 'string')
    return undefined
  }
  const members = (schema: AnyZod): AnyZod[] => schema.options ?? schema.def?.options ?? [schema]
  const shapeOf = (schema: AnyZod): Record<string, AnyZod> => schema.shape ?? schema.def?.shape ?? {}
  const declared = new Set<string>()
  const walk = (schema: AnyZod): void => {
    for (const member of members(schema)) {
      if (member.options || member.def?.options) {
        walk(member)
        continue
      }
      const shape = shapeOf(member)
      const type = literalOf(shape.type)
      const subtype = literalOf(shape.subtype)
      if (type !== undefined) declared.add(subtype !== undefined && type === 'system' ? `system/${subtype}` : type)
    }
  }
  walk(control.StdoutMessageSchema() as unknown as AnyZod)
  const expected = [
    'assistant',
    'user',
    'result',
    'system/init',
    'system/compact_boundary',
    'system/model_transition',
    'system/status',
    'system/turn_started',
    'system/mission_updated',
    'system/api_retry',
    'system/hook_started',
    'system/hook_progress',
    'system/hook_response',
    'system/task_notification',
    'system/task_started',
    'system/session_state_changed',
    'system/task_progress',
    'system/elicitation_complete',
    'stream_event',
    'tool_progress',
    'tool_use_summary',
    'rate_limit_event',
    'prompt_suggestion',
    'control_response',
    'control_request',
    'control_cancel_request',
  ]
  const got = [...declared].sort()
  check('the stdout union declares exactly the frame types the product writes', deepEq(got, [...expected].sort()), j(got))
  const coreSrc = readFileSync(join(ROOT, 'src/entrypoints/sdk/coreSchemas.ts'), 'utf8')
  const controlSrc = readFileSync(join(ROOT, 'src/entrypoints/sdk/controlSchemas.ts'), 'utf8')
  const typesSrc = readFileSync(join(ROOT, 'src/entrypoints/sdk/controlTypes.ts'), 'utf8')
  const generatedSrc = readFileSync(join(ROOT, 'src/entrypoints/sdk/coreTypes.generated.ts'), 'utf8')
  const retired = [
    'auth_status',
    'streamlined_text',
    'streamlined_tool_use_summary',
    'files_persisted',
    'local_command_output',
    'post_turn_summary',
    'keep_alive',
    'update_environment_variables',
    'channel_enable',
    'remote_control',
    'claude_authenticate',
    'claude_oauth_callback',
    'claude_oauth_wait_for_completion',
    'ultraplan',
    'apiKeySource',
    'apiProvider',
  ]
  const all = coreSrc + controlSrc + typesSrc + generatedSrc
  const present = retired.filter(word => all.includes(word))
  check('no retired frame type, control subtype or field survives in the schema modules', present.length === 0, j(present))
  const controlNames = ['provider_sign_in', 'provider_sign_in_callback', 'provider_sign_in_wait', 'host_mcp_servers']
  check('the sign-in verbs and the host MCP list are declared under their names', controlNames.every(word => controlSrc.includes(`'${word}'`) || controlSrc.includes(`${word}:`)), j(controlNames.filter(w => !controlSrc.includes(w))))
  const stateSrc = readFileSync(join(ROOT, 'src/utils/sessionState.ts'), 'utf8')
  const changeSrc = readFileSync(join(ROOT, 'src/state/onChangeAppState.ts'), 'utf8')
  check('no session-metadata push road remains', !/notifySessionMetadataChanged|SessionExternalMetadata/.test(stateSrc + changeSrc) && !changeSrc.includes('externalMetadataToAppState'))
  const mcpTypesSrc = readFileSync(join(ROOT, 'src/services/mcp/types.ts'), 'utf8')
  check("the MCP kind word for a host-served server is 'host' on the wire and inside", mcpTypesSrc.includes("z.literal('host')") && !mcpTypesSrc.includes("'sdk'") && !coreSrc.includes("z.literal('sdk')"))
}

section('F2 — every declared key is snake_case outside the riding contracts')
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
  const allowed = new Set([
    'hookSpecificOutput', 'hookEventName', 'additionalContext', 'watchPaths', 'worktreePath', 'updatedMCPToolOutput', 'updatedInput',
    'updatedPermissions', 'systemMessage', 'suppressOutput', 'stopReason', 'permissionDecision',
    'permissionDecisionReason', 'initialUserMessage', 'asyncTimeout',
    'toolName', 'ruleContent',
    'disallowedTools', 'criticalSystemReminder_EXPERIMENTAL', 'initialPrompt', 'maxTurns', 'permissionMode', 'mcpServers',
    'budgetTokens', 'multiSelect',
  ])
  const camel = [...new Set([...coreKeys, ...controlKeys].filter(key => !SNAKE.test(key)))].sort()
  const unexpected = camel.filter(key => !allowed.has(key))
  const missing = [...allowed].filter(key => !camel.includes(key))
  check('the only camelCase keys declared are the riding contracts and the option types (pinned)', unexpected.length === 0, j(unexpected))
  check('…and every pinned exception is still declared (the list stays honest)', missing.length === 0, j(missing))
  check('the control schemas declare snake_case keys only', controlKeys.every(key => SNAKE.test(key)), j(controlKeys.filter(key => !SNAKE.test(key))))
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
    workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: ['/x'] },
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
        agentType: 'general-purpose',
        team: 't',
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
  }
  const opaque = ['kit.extensions', 'kit.deltas.skill_states', 'spawn_switches']
  const wire = seatWire.sessionFactsToWire(facts as never)
  const paths = keyPaths(wire, '', opaque)
  const camel = paths.filter(p => !SNAKE.test(lastSegment(p)))
  check('the facts answer encodes to snake_case keys at every depth (outside the name-keyed maps)', camel.length === 0, j(camel))
  check('the spawn switch kinds and the name-keyed maps keep their keys', deepEq(Object.keys((wire as { spawn_switches: object }).spawn_switches), ['subagents', 'workflows']) && deepEq(Object.keys(((wire as { kit: { extensions: object } }).kit).extensions), ['ext-a', 'ext-b']), j(wire))
  const back = seatWire.sessionFactsFromWire(JSON.parse(JSON.stringify(wire)))
  check('the facts answer decodes back deep-equal', deepEq(back, facts), j(back).slice(0, 400))
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

section('F4 — the effort enums on the wire are the one ladder')
{
  type EnumLike = { options?: unknown[]; def?: { options?: unknown[] }; element?: EnumLike; unwrap?: () => EnumLike }
  const shape = (core.ModelInfoSchema() as unknown as { shape: Record<string, EnumLike> }).shape
  const levels = shape.supported_effort_levels!.unwrap!().element!
  const ladder = [...runtime.EFFORT_LEVELS]
  check('a model row\'s supported effort levels enumerate the ladder', deepEq(levels.options ?? levels.def?.options, ladder), j(levels.options ?? levels.def?.options))
  const agentShape = (core.AgentDefinitionSchema() as unknown as { shape: Record<string, EnumLike> }).shape
  const effortUnion = agentShape.effort!.unwrap!()
  const first = (effortUnion.options ?? effortUnion.def?.options ?? [])[0] as EnumLike
  check('an agent definition\'s effort enumerates the ladder', deepEq(first.options ?? first.def?.options, ladder), j(first.options ?? first.def?.options))
  check('the ladder ends at max', ladder[ladder.length - 1] === 'max', j(ladder))
}

section('F5 — the status, wait, fold, usage and context projections spell snake_case')
{
  check('the agent wait count', deepEq(mappers.toSDKStatusPayload({ waitingOnAgents: 2 }), { waiting_on_agents: 2 }))
  check('null and a bare word pass through', mappers.toSDKStatusPayload(null) === null && mappers.toSDKStatusPayload('compacting') === 'compacting')
  const wait = { kind: 'first-byte' as const, cold: true, promptTokens: 58_000, model: 'Opus 5', budgetMs: 160_000, sinceMs: 5, attempt: 1 }
  const waitWire = idle.requestWaitToWire(wait)
  check('the request wait encodes to snake keys', keyPaths(waitWire).every(p => SNAKE.test(lastSegment(p))) && (waitWire as { prompt_tokens: number }).prompt_tokens === 58_000, j(waitWire))
  check('…and decodes back through the wait decoder', deepEq(idle.decodeRequestWait(idle.requestWaitFromWire(JSON.parse(JSON.stringify(waitWire)))), wait))
  const retry = { kind: 'retry' as const, attempt: 2, of: 3, reason: 'a 529', delayMs: 800, sinceMs: 9 }
  check('the retry wait round-trips', deepEq(idle.decodeRequestWait(idle.requestWaitFromWire(idle.requestWaitToWire(retry))), retry))
  const statusWait = mappers.toSDKStatusPayload({ wait }) as { wait: Record<string, unknown> }
  check('the status payload carries the wait in the feed\'s spelling', deepEq(statusWait, { wait: waitWire }) && deepEq(mappers.toSDKStatusPayload({ wait: null }), { wait: null }))
  const foldRecord = { schema: 1 as const, trigger: 'auto' as const, startedAtMs: 1, stages: ['summarising' as const, 'restoring' as const], stage: 'summarising' as const, fill: 0.5, summaryTokens: 10, summaryCapTokens: 20, attempt: 1, exit: 'landed' as const, endedAtMs: 9 }
  const foldWire = fold.foldStatusToWire(foldRecord)
  check('the fold record encodes to snake keys', keyPaths(foldWire).every(p => SNAKE.test(lastSegment(p))) && (foldWire as { started_at_ms: number }).started_at_ms === 1, j(foldWire))
  check('…and decodes back through the fold decoder', deepEq(fold.decodeFoldStatus(fold.foldStatusFromWire(JSON.parse(JSON.stringify(foldWire)))), foldRecord))
  check('the status payload carries the fold in the feed\'s spelling', deepEq(mappers.toSDKStatusPayload({ compacting: foldRecord }), { compacting: foldWire }))
  const usage = mappers.toSDKModelUsage({ 'claude-opus-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, webSearchRequests: 0, costUSD: 0.1, contextWindow: 200_000, maxOutputTokens: 64_000 } })
  check('the per-model usage keeps the model id as its key and spells the fields snake_case', deepEq(usage, { 'claude-opus-5': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, web_search_requests: 0, cost_usd: 0.1, context_window: 200_000, max_output_tokens: 64_000 } }), j(usage))
  const context = mappers.toSDKContextUsage({ totalTokens: 1, maxTokens: 2, rawMaxTokens: 2, percentage: 0, gridRows: [[{ color: 'c', isFilled: true, categoryName: 'n', tokens: 1, percentage: 0, squareFullness: 1 }]], model: 'm', categories: [], memoryFiles: [], mcpTools: [{ name: 'x', serverName: 's', tokens: 1, isLoaded: true }], agents: [], isAutoCompactEnabled: true, countsAvailable: true, apiUsage: null } as never)
  check('the context usage answer spells every key snake_case at every depth', keyPaths(context).every(p => SNAKE.test(lastSegment(p))) && (context as { grid_rows: unknown[][] }).grid_rows[0]![0] !== undefined, j(keyPaths(context).filter(p => !SNAKE.test(lastSegment(p)))))
}

section('F6 — the contract version')
check('the machine feed contract is version 3', coreTypes.MERCURY_SDK_CONTRACT_VERSION === 3, String(coreTypes.MERCURY_SDK_CONTRACT_VERSION))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ feed shapes: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ feed shapes: all legs green')
process.exit(0)
