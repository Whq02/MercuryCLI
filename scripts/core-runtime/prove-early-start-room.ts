import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'early-start-room-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'early-start-room-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) {
  delete process.env[k]
}

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { EarlyStarts } = await import('../../src/services/tools/earlyStarts.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { resultRoomFor, resultRoomForRound } = await import('../../src/services/run/resultRoom.ts')
const { getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — early-start-room prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const MODEL = 'claude-opus-4-8'

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    getPath: (input: Record<string, unknown>) => (typeof input.path === 'string' ? input.path : '/tmp/early-start-room-tree'),
    isMcp: false,
    maxResultSizeChars: 50_000,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `${name} answered ${JSON.stringify(input)}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const TOOLS = [makeTool('Grep')]
const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function makeCtx(messages: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: TOOLS,
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
}

function conversationOf(tokens: number): unknown[] {
  const chunk = 'the same line again and again, carried as context\n'
  const chars = tokens * 4
  const rounds = Math.ceil(chars / (chunk.length * 400))
  const body = chunk.repeat(400)
  const messages: unknown[] = []
  for (let i = 0; i < rounds; i++) messages.push(createUserMessage({ content: `${i} ${body}` }))
  return messages
}

async function settle(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return pred()
}

const block = (id: string) => ({ type: 'tool_use', id, name: 'Grep', input: { pattern: 'needle', path: '/tmp/early-start-room-tree' } }) as never

console.log('\n── past the fold line: the early road opens the round\'s room and the settled road shares it')
{
  const threshold = getAutoCompactThreshold(MODEL)
  const ctx = makeCtx(conversationOf(threshold + 2_000))
  const parent = createAssistantMessage({ content: [block('tu_room_1')] as never }) as unknown as Record<string, unknown>
  const early = new EarlyStarts(ctx as never, allowAll as never)
  early.offer(block('tu_room_1'), parent as never, 0)
  await early.ready()
  const opened = await settle(() => resultRoomFor(parent) !== null, 2_000)
  const room = resultRoomFor(parent)
  check('an early-started call opens the round\'s result room on its parent message', opened && room !== null, `room ${room === null ? 'null' : 'present'}`)
  check('the room is awake past the line', room?.budget.awake === true, JSON.stringify(room?.budget ?? null))
  check('the room is registered under the early road\'s round id', resultRoomForRound(early.roundID) === room)
  const settled = [parent] as never
  for await (const _update of runTools([block('tu_room_1')] as never, settled, allowAll as never, ctx as never, early)) void _update
  check('the settled round reuses the early road\'s room — one room per round', resultRoomFor(parent) === room && resultRoomForRound(early.roundID) === room)
}

console.log('\n── under the fold line: nothing changes on a normal day')
{
  const ctx = makeCtx(conversationOf(2_000))
  const parent = createAssistantMessage({ content: [block('tu_room_2')] as never }) as unknown as Record<string, unknown>
  const early = new EarlyStarts(ctx as never, allowAll as never)
  early.offer(block('tu_room_2'), parent as never, 0)
  await early.ready()
  await settle(() => early.take('tu_room_2') !== undefined, 2_000)
  check('the early road opens no room under the line', resultRoomFor(parent) === null)
  check('no room is registered for the round under the line', resultRoomForRound(early.roundID) === null)
}

console.log(`\nEARLY-START-ROOM: ${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks FAILED`}`)
clearTimeout(watchdog)
process.exit(failures === 0 ? 0 : 1)
