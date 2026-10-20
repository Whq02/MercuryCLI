#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'mcp-tools-door-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(scratch, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, cond: unknown, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function plainData(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(plainData)
  if (typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && Object.values(value as Record<string, unknown>).every(plainData)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the mcp tools door proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type AnswerModule = typeof import('../../src/services/mcp/toolsAnswer.ts')
const answers = (await import('../../src/services/mcp/toolsAnswer.ts').catch(() => null)) as AnswerModule | null
const { checkResult } = await import('../../src/runner/wire/methods.ts')
const seat = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { NoSessionConnector, NO_CHAT_OPEN } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { olderDaemonRefusalLine } = await import('../../src/daemon/controlSocket.ts')
const { verbBornAt } = await import('../../src/daemon/protocol.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { RPC_METHOD_NOT_FOUND } = await import('../../src/runner/wire/errors.ts')

type Facts = { name: string; registeredAs: string; description: string; inputSchema: Record<string, unknown>; loading: 'deferred' | 'listed' | 'held' }
const schemaOf = (fields: number, pad: number): Record<string, unknown> => ({
  type: 'object',
  properties: Object.fromEntries(Array.from({ length: fields }, (_, i) => [`field${i}`, { type: 'string', description: 'x'.repeat(pad) }])),
})
const factOf = (i: number, inputSchema: Record<string, unknown>, description = `Tool number ${i}.`): Facts => ({
  name: `tool_${i}`,
  registeredAs: `mcp__bulk__tool_${i}`,
  description,
  inputSchema,
  loading: 'deferred',
})

section('§1 the answer is plain data inside one bound — every cut is marked, nothing is dropped unsaid')
const fixtureFacts: Facts[] = [
  { name: 'inspect_cluster', registeredAs: 'mcp__runpod__inspect_cluster', description: 'Inspect cluster nodes.', inputSchema: { type: 'object', properties: { clusterId: { type: 'string' } }, required: ['clusterId'] }, loading: 'deferred' },
  { name: 'purge_queue', registeredAs: 'mcp__runpod__purge_queue', description: 'Remove pending jobs.', inputSchema: { type: 'object', properties: { endpointId: { type: 'string' } } }, loading: 'listed' },
]
if (answers === null) {
  check('src/services/mcp/toolsAnswer.ts builds the answer (the bound and its marks)', false, 'absent — the runner arm hands the whole list to the wire whatever its size, and an unlisted server answers an empty list')
} else {
  const { mcpToolsAnswerOf, mcpToolsUnlistedAnswer, mcpToolsFromWire, mcpToolsOfReply, MCP_TOOLS_ANSWER_BYTES, MCP_TOOL_DESCRIPTION_CHARS } = answers
  const small = mcpToolsAnswerOf('runpod', fixtureFacts)
  check('a small server crosses whole: every schema carried, no mark, nothing omitted', small.state === 'connected' && small.omitted === 0 && small.tools.length === 2 && small.tools.every(t => t.schema_withheld_bytes === undefined && t.description_cut === undefined) && j(small.tools[0]!.input_schema) === j(fixtureFacts[0]!.inputSchema), j(small))
  check("the answer is the method table's shape (the runner wire validates it)", checkResult('mcp/tools', small).ok)
  const big = schemaOf(400, 480)
  const bulk = [factOf(0, big), ...Array.from({ length: 299 }, (_, i) => factOf(i + 1, schemaOf(8, 480)))]
  const started = Date.now()
  const bulkAnswer = mcpToolsAnswerOf('bulk', bulk)
  const tookMs = Date.now() - started
  const bulkBytes = bytesOf(bulkAnswer)
  check('300 tools and a 200 KB schema stay inside the answer bound', bytesOf(big) > 190_000 && bulkBytes <= MCP_TOOLS_ANSWER_BYTES, `${bulkBytes} bytes, bound ${MCP_TOOLS_ANSWER_BYTES}`)
  check('the bound is quick to apply (no stall in the runner)', tookMs < 2_000, `${tookMs} ms`)
  check('all 300 tools are listed by name — only schemas are withheld', bulkAnswer.tools.length === 300 && bulkAnswer.omitted === 0, `${bulkAnswer.tools.length} listed, ${bulkAnswer.omitted} omitted`)
  const withheld = bulkAnswer.tools.filter(t => t.schema_withheld_bytes !== undefined)
  check('a withheld schema carries its real size and no partial schema', withheld.length > 0 && withheld.every(t => t.schema_withheld_bytes === bytesOf(bulk.find(f => f.name === t.name)!.inputSchema) && j(t.input_schema) === '{}'), `${withheld.length} withheld`)
  check('the 200 KB schema is withheld before any small one (smallest schemas are carried first)', bulkAnswer.tools[0]!.schema_withheld_bytes === bytesOf(big) && bulkAnswer.tools.some(t => t.schema_withheld_bytes === undefined))
  check('every carried schema crosses byte for byte', bulkAnswer.tools.filter(t => t.schema_withheld_bytes === undefined).every(t => j(t.input_schema) === j(bulk.find(f => f.name === t.name)!.inputSchema)))
  check("the bounded answer is still the method table's shape", checkResult('mcp/tools', bulkAnswer).ok)
  const alone = mcpToolsAnswerOf('one', [factOf(0, big)])
  check('a single 200 KB schema inside the bound is carried whole (the bound withholds only what does not fit)', alone.tools[0]!.schema_withheld_bytes === undefined && j(alone.tools[0]!.input_schema) === j(big))
  const wordy = Array.from({ length: 1500 }, (_, i) => factOf(i, { type: 'object' }, `${'word '.repeat(2000)}${i}`))
  const wordyAnswer = mcpToolsAnswerOf('wordy', wordy)
  check('a list too long to carry is cut with its count: listed + omitted = total, inside the bound', wordyAnswer.omitted > 0 && wordyAnswer.tools.length + wordyAnswer.omitted === 1500 && bytesOf(wordyAnswer) <= MCP_TOOLS_ANSWER_BYTES, `${wordyAnswer.tools.length} + ${wordyAnswer.omitted}; ${bytesOf(wordyAnswer)} bytes`)
  check('the cut keeps the session order (the first tools are the ones listed)', wordyAnswer.tools.every((t, i) => t.name === `tool_${i}`))
  check('a description past its bound is cut and marked', wordyAnswer.tools[0]!.description_cut === true && Array.from(wordyAnswer.tools[0]!.description).length === MCP_TOOL_DESCRIPTION_CHARS + 1 && wordyAnswer.tools[0]!.description.endsWith('…'))

  section('§2 a server the session cannot list answers its state and why — never an empty list')
  const unlisted: Array<[string, { type: string; error?: string } | undefined, RegExp]> = [
    ['needs-auth', { type: 'needs-auth' }, /needs sign-in/],
    ['failed', { type: 'failed', error: 'MCP error -32000: Connection closed' }, /failed: MCP error -32000: Connection closed/],
    ['disabled', { type: 'disabled' }, /off for this session/],
    ['pending', { type: 'pending' }, /still connecting/],
    ['absent', undefined, /no MCP server named srv/],
  ]
  for (const [state, client, words] of unlisted) {
    const answer = mcpToolsUnlistedAnswer('srv', client)
    check(`${state}: typed state, no tools, the reason in words`, answer.state === state && answer.tools.length === 0 && words.test(answer.detail ?? '') && checkResult('mcp/tools', answer).ok, j(answer))
  }

  section('§3 the V1 the connector reads is the wire answer re-spelled, plain data only')
  const v1 = mcpToolsFromWire(bulkAnswer)
  check('the relayed answer is plain data (no live client, no function, no class instance)', plainData(v1) && j(JSON.parse(j(v1))) === j(v1))
  check('the camel spelling carries every mark', v1.tools.length === 300 && v1.tools[0]!.schemaWithheldBytes === bytesOf(big) && v1.tools[0]!.registeredAs === 'mcp__bulk__tool_0' && v1.tools[0]!.loading === 'deferred')
  check("the connector's reader takes the daemon's reply back whole", j(mcpToolsOfReply(JSON.parse(j(v1)))) === j(v1))
  check('a payload of another shape reads as unreadable, never as a list', mcpToolsOfReply({ server: 'runpod', tools: [{ name: 'x', description: '', inputSchema: {}, deferred: true }] }) === null && mcpToolsOfReply('nope') === null)
}

section("§4 the seat relays the RUNNER's own answer and names every way it does not come")
const RUNNER = 'concourse-mt1'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-mcptools0001'
const MODEL = 'claude-opus-4-8'
updateConcourseWorkers(workers => {
  workers[RUNNER] = {
    schema: 1,
    runnerId: RUNNER,
    sessionId: SESSION,
    workspaceId: ROOT,
    isolation: 'exclusive',
    modelKey: MODEL,
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    workspaceKind: 'plain-folder',
  } as never
}, daemonDir)
const runnerAnswer = answers !== null ? answers.mcpToolsAnswerOf('runpod', fixtureFacts) : { server: 'runpod', tools: [] }
let mode: 'answer' | 'older' | 'silent' | 'misshapen' = 'answer'
let toolsAsked = 0
const stand = standInRunner({ autoAnswer: null })
void (async () => {
  for (;;) {
    const request = await stand.nextRequest(undefined, 600_000).catch(() => null)
    if (request === null) return
    queueMicrotask(() => {
      if (request.method !== 'mcp/tools') {
        request.answer({})
        return
      }
      toolsAsked++
      if (mode === 'answer') request.answer(runnerAnswer)
      else if (mode === 'older') request.refuse(RPC_METHOD_NOT_FOUND, 'unknown method mcp/tools', { method: 'mcp/tools' })
      else if (mode === 'misshapen') request.answer({ server: 'runpod', tools: [{ name: 'x', description: '', input_schema: {}, deferred: true }] })
    })
  }
})()
let channelOpen = true
const roster = stand.roster({ door: () => (channelOpen ? stand.connection : undefined) })
type Relay = (sessionId: string, name: string, roster: unknown, dir?: string, opts?: { deadlineMs?: number }) => Promise<{ outcome: string; detail?: string; mcpTools?: unknown }>
const relayOf = seat.listSessionMcpTools as unknown as Relay
const relay = (opts?: { deadlineMs?: number }) => relayOf(SESSION, 'runpod', roster, daemonDir, opts)
const applied = await relay()
check("applied: the runner's list crosses as the connector's plain V1", applied.outcome === 'applied' && plainData(applied.mcpTools) && answers !== null && j(applied.mcpTools) === j(answers.mcpToolsFromWire(runnerAnswer as never)), j(applied))
check('one mcp/tools request crossed the door to the runner', toolsAsked === 1, String(toolsAsked))
mode = 'older'
const older = await relay()
check("an older runner's unknown method names the gap and the restart", older.outcome === 'refused' && /predates the MCP tools list/.test(older.detail ?? '') && /\/daemon restart/.test(older.detail ?? '') && older.mcpTools === undefined, j(older))
mode = 'silent'
const silent = await Promise.race([relay({ deadlineMs: 80 }), settle(3_000).then(() => null)])
check('a runner silent past the deadline is refused with the wait named — never a hung popup', silent !== null && silent.outcome === 'refused' && /did not answer the MCP tools list/.test(silent.detail ?? ''), j(silent))
mode = 'misshapen'
const misshapen = await relay()
check("an answer that is not the method table's shape is refused, never relayed", misshapen.outcome === 'refused' && /not the shape the table declares/.test(misshapen.detail ?? ''), j(misshapen))
mode = 'answer'
channelOpen = false
const doorless = await relay()
check('a session with no live runner door is refused typed', doorless.outcome === 'refused' && /no live runner door/.test(doorless.detail ?? ''), j(doorless))
channelOpen = true
const stranger = await relayOf('no-such-session', 'runpod', roster, daemonDir)
check('an unknown session is refused typed', stranger.outcome === 'refused' && /unknown-session/.test(stranger.detail ?? ''), j(stranger))

section('§5 the connector paints every refusal in words — the popup never shows an empty list for a list it could not read')
const restingConnector = new NoSessionConnector()
const resting = (await restingConnector.mcpTools('runpod')) as { state?: string; detail?: string; tools: readonly unknown[] }
check('no chat open: the resting slot answers unavailable with the one sentence', resting.state === 'unavailable' && resting.detail === NO_CHAT_OPEN && resting.tools.length === 0, j(resting))
const connector = new DaemonSessionConnector({
  sessionId: SESSION,
  runnerId: RUNNER,
  title: 'mcp tools door',
  projectLabel: 'proof',
  workspaceId: ROOT,
  home: scratch,
  modelKey: MODEL,
} as never)
const guts = connector as unknown as { rpc: (req: Record<string, unknown>) => Promise<Record<string, unknown>> }
let reply: (req: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({ ok: false, code: 'EUNKNOWN', error: 'unset' })
guts.rpc = req => reply(req)
const needs = verbBornAt('sessionControl', 'mcp-tools')
check('the verb is registered at its own protocol (the client can name an older daemon)', needs === 16, String(needs))
const olderLine = olderDaemonRefusalLine('sessionControl mcp-tools', needs, { proto: needs - 1, version: '1.0.0-beta.39' })
reply = async () => ({ ok: false, code: 'EUNKNOWN', error: olderLine, refusal: 'daemon-older' })
const olderDaemon = (await connector.mcpTools('runpod')) as { state?: string; detail?: string }
check("an older daemon's refusal reaches the popup whole: the protocol gap and the restart", olderDaemon.state === 'unavailable' && olderDaemon.detail === olderLine && /restart the daemon/.test(olderLine), j(olderDaemon))
reply = async () => ({ ok: false, code: 'ENOCONN', error: 'daemon unreachable (ECONNREFUSED)' })
const unreachable = (await connector.mcpTools('runpod')) as { state?: string; detail?: string }
check('an unreachable daemon says so', unreachable.state === 'unavailable' && unreachable.detail === 'daemon unreachable (ECONNREFUSED)', j(unreachable))
reply = async req => {
  const out = await relayOf(String(req.sessionId), String(req.mcpServer), roster, daemonDir)
  return { ok: true, op: 'sessionControl', outcome: out.outcome, ...(out.detail !== undefined ? { detail: out.detail } : {}), ...(out.mcpTools !== undefined ? { mcpTools: out.mcpTools } : {}) }
}
mode = 'answer'
const relayed = await connector.mcpTools('runpod')
check("the whole road: the connector answers the runner's list as the seat relayed it", answers !== null && j(relayed) === j(answers.mcpToolsFromWire(runnerAnswer as never)), j(relayed))
mode = 'older'
const olderRunner = (await connector.mcpTools('runpod')) as { state?: string; detail?: string }
check("the whole road: an older runner's gap reaches the popup in words", olderRunner.state === 'unavailable' && /predates the MCP tools list/.test(olderRunner.detail ?? ''), j(olderRunner))
reply = async () => ({ ok: true, op: 'sessionControl', outcome: 'applied', mcpTools: { server: 'runpod', tools: [{ name: 'x', description: '', inputSchema: {}, deferred: true }] } })
const unreadable = (await connector.mcpTools('runpod')) as { state?: string; detail?: string }
check('a payload the screen cannot read is said so, never painted as a list', unreadable.state === 'unavailable' && /cannot read/.test(unreadable.detail ?? ''), j(unreadable))

console.log(`\n${checks - failures}/${checks} checks passed; ${failures} failed`)
stand.close()
rmSync(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
