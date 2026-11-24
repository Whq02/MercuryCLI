;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/engine/message-shapes/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-request-view-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
delete process.env.ANTHROPIC_BASE_URL
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { foldConversation, ERROR_MESSAGE_POST_FOLD_OVER_THRESHOLD } = await import('../../src/engine/compaction/foldConversation.ts')
const { beginFoldStatus, foldStatusExit, foldRowWords, decodeFoldStatus, foldStatusToWire } = await import('../../src/engine/compaction/foldStatus.ts')
const { compactionRow } = await import('../../src/engine/rows/project.ts')
const { CompactionRowSchema } = await import('../../src/engine/rows/vocabulary.ts')
const { bindRequestGauge, requestGaugeFixed } = await import('../../src/engine/run/requestGauge.ts')
const { calibrationKeyFor } = await import('../../src/engine/run/contextCalibration.ts')
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const { planToolPayload, toolsOnTheWire, toolRosterLatchFor, clearToolRosterLatches } = await import('../../src/models/roads/toolEconomy.ts')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

console.log('§1 the fixed material of the gauge is the request\'s own: the tools the wire carries, not the whole catalogue')
const pool = getAllBaseTools()
const permission = async () => getEmptyToolPermissionContext()
const schemasOf = async (tools: readonly { name: string }[], model: string): Promise<unknown[]> =>
  Promise.all(tools.map(tool => toolToAPISchema(tool as never, { getToolPermissionContext: permission, tools: pool, agents: [], allowedAgentTypes: undefined, model } as never).catch(() => ({ name: tool.name }))))
{
  const opening = [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'read every file under tools/' } } as Message]
  const local = await planToolPayload({ model: 'local/qwen3.5:9b', tools: pool, messages: opening, getToolPermissionContext: permission, agents: [], source: 'gauge' })
  const localWire = toolsOnTheWire(local)
  const wholeFixed = requestGaugeFixed({ tools: await schemasOf(pool, 'local/qwen3.5:9b') })
  const localFixed = requestGaugeFixed({ tools: await schemasOf(localWire, 'local/qwen3.5:9b') })
  check(`the local road's wire carries ${localWire.length} of ${pool.length} tools (the never-deferred set; the deferred ride as names)`, local.wireForm === 'text-append' && local.enabled && localWire.length < pool.length / 2 && localWire.length > 0, `${local.wireForm} enabled=${local.enabled} wire=${localWire.length} pool=${pool.length}; change planToolPayload in src/models/roads/toolEconomy.ts so a local model gets the text-append wire with only the never-deferred tools`)
  check(`its fixed material is a fraction of the whole catalogue's (${localFixed.tokens} vs ${wholeFixed.tokens} tokens)`, localFixed.tokens < wholeFixed.tokens / 2, `${localFixed.tokens} vs ${wholeFixed.tokens}; the gauge fixed material must be measured on the tools the wire carries (planToolPayload in src/models/roads/toolEconomy.ts, requestGaugeFixed in src/engine/run/requestGauge.ts), not on the whole catalogue`)
  const anthropic = await planToolPayload({ model: 'claude-opus-4-8', tools: pool, messages: opening, getToolPermissionContext: permission, agents: [], source: 'gauge' })
  check('the first-party block wire carries every tool (deferred ones under the API\'s own deferred loading), so its fixed material is the whole catalogue', anthropic.wireForm === 'block' && toolsOnTheWire(anthropic).length === pool.length - (anthropic.enabled ? 0 : 1), `${anthropic.wireForm} wire=${toolsOnTheWire(anthropic).length} pool=${pool.length} enabled=${anthropic.enabled}; the first-party road must keep the block wire with every tool, see planToolPayload in src/models/roads/toolEconomy.ts`)
  const admitted = [
    ...opening,
    { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_ts_1', name: 'ToolSearch', input: { query: 'select:Retain' } }] } } as Message,
    { type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ts_1', content: [{ type: 'text', text: 'Admitted: Retain' }, { type: 'tool_reference', tool_name: 'Retain' }] }] } } as Message,
  ]
  const afterAdmission = await planToolPayload({ model: 'local/qwen3.5:9b', tools: pool, messages: admitted, getToolPermissionContext: permission, agents: [], source: 'gauge' })
  const admittedWire = toolsOnTheWire(afterAdmission)
  check('an admitted tool\'s definition rides the text-append wire and so joins the fixed material (one more schema, the tools term itself unmoved)', admittedWire.length === localWire.length + 1 && admittedWire.some(tool => tool.name === 'Retain') && afterAdmission.roster.length === local.roster.length, `${admittedWire.length} vs ${localWire.length}; a tool admitted through a ToolSearch tool_reference must join the wire once and leave the roster unchanged, see planToolPayload in src/models/roads/toolEconomy.ts`)
  const t = await import('../core-runtime/turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const { mainOwnerOfSession, rosterOwnerFromToolUseContext } = await import('../../src/engine/run-owner/resolveOwner.ts')
  const LOCAL = 'local/qwen3.5:9b'
  const FIRST_PARTY = 'claude-opus-4-8'
  const gaugedRequest = async (model: string, tools: readonly unknown[]): Promise<{ fixed: number; latched: boolean; key: string; rows: Message[] }> => {
    const planted = await t.plantRun({
      model,
      script: [],
      before: rig => {
        ;(rig.ctx.options as { tools: unknown }).tools = tools
      },
    })
    const key = String(rosterOwnerFromToolUseContext(planted.rig.ctx as never))
    const rows = planted.state.messages as Message[]
    const made = await t.drain(makeRequest(planted.run as never, planted.state as never, 1))
    const latched = toolRosterLatchFor(key, rows, model) !== undefined
    planted.close()
    return { fixed: made.decision.kind === 'go_on' ? (made.decision.iter.requestPlan.gauge?.fixed.tokens ?? Number.NaN) : Number.NaN, latched, key, rows }
  }
  const weightOf = async (tools: readonly { name: string }[], model: string): Promise<number> => requestGaugeFixed({ tools: await schemasOf(tools, model) }).tokens - requestGaugeFixed({ tools: [] }).tokens
  const wireOf = async (model: string, rows: Message[]) => toolsOnTheWire(await planToolPayload({ model, tools: pool, messages: rows, getToolPermissionContext: permission, agents: [], source: 'gauge' }))
  const localRequest = await gaugedRequest(LOCAL, pool)
  const localGrew = localRequest.fixed - (await gaugedRequest(LOCAL, [])).fixed
  const localWireWeighs = await weightOf(await wireOf(LOCAL, localRequest.rows), LOCAL)
  const localCatalogueWeighs = await weightOf(pool, LOCAL)
  const firstPartyRequest = await gaugedRequest(FIRST_PARTY, pool)
  const firstPartyGrew = firstPartyRequest.fixed - (await gaugedRequest(FIRST_PARTY, [])).fixed
  const firstPartyWireWeighs = await weightOf(await wireOf(FIRST_PARTY, firstPartyRequest.rows), FIRST_PARTY)
  await planToolPayload({ model: LOCAL, tools: pool, messages: localRequest.rows, getToolPermissionContext: permission, agents: [], source: 'prove', latchKey: localRequest.key })
  const latchingPlannerLatches = toolRosterLatchFor(localRequest.key, localRequest.rows, LOCAL) !== undefined
  const wholeRunRows = [t.fixtures.ask('hello there rig')] as Message[]
  const wholeRun = await t.runScripted({ seed: wholeRunRows, script: [t.fixtures.yields(t.fixtures.calls('tu_1', 'EchoTool', { text: 'x' })), t.fixtures.yields(t.fixtures.says('after tools.'))] })
  const wholeRunLatched = toolRosterLatchFor(String(mainOwnerOfSession(wholeRun.session)), wholeRunRows, t.MODEL) !== undefined
  clearToolRosterLatches()
}

console.log('§2 a 32k-window local fixture: the fold lands when its real prefix fits, and refuses with the words when the fixed material alone exceeds the ceiling')
let clock = Date.UTC(2026, 9, 16)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', stop_reason: 'tool_use', content } }) as Message
function stretch(rounds: number, label: string): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < rounds; index++) {
    rows.push(user(`${label} ask ${index}: read the next file and summarise it`))
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/tmp/tools/${label}-${index}.ts` } }]))
    rows.push({ ...user([{ type: 'tool_result', tool_use_id: id, content: `export function ${label}${index}() { return ${index} } `.repeat(120) }]), toolUseResult: { code: 0 } } as Message)
    rows.push({ ...assistant([{ type: 'text', text: `${label} reply ${index}: one paragraph.` }]), message: { id: randomUUID(), role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `${label} reply ${index}: one paragraph.` }] } } as Message)
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 4 }, () => ({ kind: 'text' as const, text: 'The nine files were read and summarised one by one; the remaining paragraphs are pending.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-request-view-proof', lane: 'main' })
const MODEL = 'claude-opus-4-8'
const context = () => ({
  owner,
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(20),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: MODEL, thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true },
  onCompactProgress: () => {},
}) as never
const fold = (messages: Message[], ceiling: number) =>
  foldConversation(messages, context(), { systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: context(), forkContextMessages: [] }, true, undefined, true, { autoCompactThreshold: ceiling } as never)
const WINDOW_32K_THRESHOLD = 26_000
const bind = (messages: Message[], fixedTokens: number) =>
  bindRequestGauge(messages, calibrationKeyFor(declaredRouteOf(MODEL) ?? 'unrecognised', MODEL), 1, { digest: `fixture-${fixedTokens}`, tokens: fixedTokens })

let refusal = ''
try {
  const session = stretch(9, 'tools')
  bind(session, 42_506)
  const paid = api.messageRequests().length
  try { await fold(session, WINDOW_32K_THRESHOLD) } catch (error) { refusal = error instanceof Error ? error.message : String(error) }
  check('the whole-catalogue view (42,506 fixed tokens, the drive\'s count) refuses before any summary request', refusal.startsWith(ERROR_MESSAGE_POST_FOLD_OVER_THRESHOLD) && api.messageRequests().length === paid, `${refusal.slice(0, 160)}; compactConversation in src/engine/compaction/foldConversation.ts must refuse with ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD before any summary request when the fixed material alone exceeds the ceiling`)
  check('the refusal says WHY in words: the fixed material, its tokens, the window\'s ceiling, and what to do', refusal.includes("the fixed material (") && /\(\d{5,} tokens:/.test(refusal) && refusal.includes(`exceeds the window's ceiling (${WINDOW_32K_THRESHOLD} tokens`) && refusal.includes('no summary was requested') && refusal.includes('/clear'), `${refusal}; the refusal text is built in src/engine/compaction/fold/foldAttachments.ts and must name the fixed material, its tokens, the ceiling, that no summary was requested, and /clear`)

  const same = stretch(9, 'tools')
  bind(same, 11_835)
  const paidBefore = api.messageRequests().length
  const landed = await fold(same, WINDOW_32K_THRESHOLD)
  check(`the request's own view (11,835 fixed tokens, Ollama's count of the local prefix) lands the fold under the ceiling (${landed.truePostCompactTokenCount} < ${WINDOW_32K_THRESHOLD}), the summary paid once`, landed.truePostCompactTokenCount !== undefined && landed.truePostCompactTokenCount < WINDOW_32K_THRESHOLD && landed.summaryMessages.length === 1 && api.messageRequests().length === paidBefore + 1, `${landed.truePostCompactTokenCount} requests=${api.messageRequests().length - paidBefore}; the fold must use the bound request gauge fixed tokens (bindRequestGauge in src/engine/run/requestGauge.ts) when it measures the post-compact size in compactConversation, src/engine/compaction/foldConversation.ts`)
} finally {
  await api.close()
}

console.log('§3 the failed fold carries its reason to the status row and the rows stream — never a bare failed')
{
  const status = beginFoldStatus({ trigger: 'auto', startedAtMs: 1_000, sessionMemory: false, microcompaction: false })
  const failed = foldStatusExit(status, 'failed', 1_002, refusal)
  check('the exit stamp keeps the refusal as the reason (its first line)', failed.exit === 'failed' && failed.reason === refusal.split('\n')[0], `${String(failed.reason).slice(0, 120)}; foldStatusExit in src/engine/compaction/foldStatus.ts must keep the first line of the failure reason on a failed exit`)
  const words = foldRowWords(failed, 1_002)
  check('the status row reads the exit word and the clause that says why', words.stage !== null && words.stage.startsWith("failed — the fixed material (") && words.stage.includes(`exceeds the window's ceiling (${WINDOW_32K_THRESHOLD} tokens)`) && !words.stage.includes('/clear'), `${words.stage ?? 'null'}; foldRowWords in src/engine/compaction/foldStatus.ts must put the exit word and the reason clause in the stage, without the /clear advice`)
  const row = compactionRow({ session_id: 'fixture' } as never, failed)
  check('the compaction row carries exit failed AND the reason, and the vocabulary admits it', row.state === 'ended' && row.exit === 'failed' && row.reason === failed.reason && CompactionRowSchema().safeParse({ ...row, seq: 1, timestamp: new Date().toISOString() }).success, `${JSON.stringify(row).slice(0, 200)}; compactionRow in src/engine/rows/project.ts must carry exit failed and the reason, and CompactionRowSchema in src/engine/rows/vocabulary.ts must admit them`)
  const back = decodeFoldStatus(JSON.parse(JSON.stringify(failed)))
  check('the record round-trips with its reason through the wire', JSON.stringify(back) === JSON.stringify(failed) && (foldStatusToWire(failed) as { reason?: string }).reason === failed.reason, `${JSON.stringify(back)}; decodeFoldStatus and foldStatusToWire in src/engine/compaction/foldStatus.ts must round-trip the reason`)
  const landedStatus = foldStatusExit(status, 'landed', 1_002, 'ignored')
  const cancelled = foldStatusExit(status, 'cancelled', 1_002, 'Compaction cancelled.')
  check('a landed or cancelled exit carries no reason; a bare failed (no words given) still reads failed', landedStatus.reason === undefined && cancelled.reason === undefined && foldRowWords(foldStatusExit(status, 'failed', 1_002), 1_002).stage === 'failed', 'foldStatusExit in src/engine/compaction/foldStatus.ts must set a reason only on a failed exit, and foldRowWords there must read a bare failed as failed')
}

rmSync(home, { recursive: true, force: true })
console.log(`${failures ? 'FAIL' : 'PASS'} fold request-view obligations (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
