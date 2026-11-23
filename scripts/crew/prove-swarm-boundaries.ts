import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod/v4'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'boundaries-home-'))
process.env.MERCURY_CONFIG_DIR = home
const work = join(home, 'boundary-proof')
mkdirSync(work, { recursive: true })
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const boot = await import('../../src/boot/process-state/processState.ts')
boot.setOriginalCwd(work); boot.setCwdState(work); boot.setProjectRoot(work)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const seam = await import('../../src/crew/board/seam.ts')
const swarmOnText = runSwarmCommand('on')
assert(swarmOnText.startsWith('Swarm on'), `runSwarmCommand('on') failed in src/commands/swarm/swarm.ts: ${swarmOnText}`)
await seam.latchSwarmAgent('reader', 'Reader')
await seam.latchSwarmAgent('writer', 'Writer')
const board = seam.swarmStore()!
const writer = seam.swarmPrincipal('writer')!
const { query } = await import('../../src/engine/turnDoor.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { buildTool } = await import('../../src/tools/kit/tool.ts')
const echo = buildTool({ name: 'Echo', maxResultSizeChars: 1000, inputSchema: z.object({}), async description() { return 'Echo' }, async prompt() { return 'Echo' }, isReadOnly: () => true, async call() { return { data: 'done' } }, mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result' as const, tool_use_id: id, content: data }) })
let state = getDefaultAppState()
const ctx: any = { agentId: 'reader', agentKind: 'crewmate', abortController: new AbortController(), options: { tools: [echo, ...seam.swarmTools('reader')], commands: [], engineModel: 'claude-fable-5-1', thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } }, getAppState: () => state, setAppState: (f: any) => { state = f(state) }, messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {} }
const text = (words: string) => { const row = createAssistantMessage({ content: words }); row.message.stop_reason = 'end_turn'; return row }
let serial = 0
async function run(withTool: boolean): Promise<any[]> {
  const requests: any[] = []
  async function* callModel(request: any): AsyncGenerator<any> {
    requests.push(request)
    request.options.onStreamActivity?.(Date.now())
    if (requests.length === 1) {
      const posted = board.post(writer, { clientOpId: `during-${++serial}`, kind: 'message', text: withTool ? 'The next tool boundary sees this.' : 'Keep this for the next active turn.', mentions: ['reader'] })
      assert(posted.ok, `board.post during inference failed in src/crew/board/store.ts: ${JSON.stringify(posted)}`)
      if (withTool) {
        const row = createAssistantMessage({ content: [{ type: 'tool_use', id: `echo-${serial}`, name: 'Echo', input: {} }] as never })
        row.message.stop_reason = 'tool_use'
        yield row
        return
      }
    }
    yield text('Finished the assigned check.')
  }
  const generator = query({ messages: [createUserMessage({ content: 'Check the row.' })], systemPrompt: ['Complete the check.'] as never, userContext: {}, systemContext: {}, canUseTool: (async (_t: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never, toolUseContext: ctx, querySource: 'agent:mercury-crew' as never, deps: { uuid: randomUUID, callModel: callModel as never, autocompact: (async () => ({ wasCompacted: false })) as never, microcompact: (async (messages: unknown[]) => ({ messages })) as never } })
  for await (const _event of generator) {}
  return requests
}
const working = await run(true)
assert.equal(working.length, 2)
assert(!JSON.stringify(working[0].messages).includes('The next tool boundary sees this.'), 'board post made during first inference leaked into first request in src/engine/turnDoor.ts')
assert.equal(JSON.stringify(working[1].messages).split('The next tool boundary sees this.').length, 2)
console.log('PASS a post during inference reaches only the next tool boundary, once')
const ending = await run(false)
assert.equal(ending.length, 1)
assert(board.boundary(seam.swarmPrincipal('reader')!, new Set())?.text.includes('Keep this for the next active turn.'), 'unread board post did not stay queued for next active turn in src/crew/board/store.ts')
console.log('PASS a final reply does not start a peer-only follow-up')
const driverArg = process.argv.indexOf('--driver')
const { createTurnDriver } = driverArg < 0 ? await import('../../src/daemon/runner/turnDriver.ts') : await import(pathToFileURL(process.argv[driverArg + 1]!).href)
let peeks = 0
let sleeps = 0
let running = 7
const queue: any[] = [{ value: 'outside report', mode: 'task-notification', priority: 'next', origin: { kind: 'outside-report', sender: 'fixture', via: 'mcp-server' }, ridesNextWords: true, skipSlashCommands: true }]
const turns: any[] = []
let fault: unknown
const driver = createTurnDriver({
  dequeue: () => queue.shift(), dequeueCommand: (command: any) => { const i = queue.indexOf(command); return i < 0 ? undefined : queue.splice(i, 1)[0] },
  peek: () => { if (++peeks > 20000) throw new Error('20,000 unslept passes'); return queue[0] }, queuedMainThread: () => queue,
  notifyLifecycle() {}, enqueueOutput() {}, async writeDirect() {}, drainRows: () => [], async executeTurn(command: any) { turns.push(command) },
  async beforeCycle() {}, onTurnStart() {}, turnIdOf: () => 'turn', openTurnRow: () => ({ type: 'turn', state: 'started' }), onTurnSettled() {},
  hasWaitableBackgroundTasks: () => running > 0, hasHoldableBackgroundAgents: () => running > 0, waitableBackgroundTaskCount: () => running,
  async settleIdle() { return 'stay' }, async closeOutput() {}, isShuttingDown: () => false, idleTimerStop() {}, idleTimerStart() {},
  onCycleError(error: unknown) { fault = error; return { type: 'outcome', status: 'failed' } }, shutdown() {},
  clock: { sleep: (ms: number) => { sleeps++; return new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))) }, now: Date.now },
})
driver.kick()
await new Promise(resolve => setTimeout(resolve, 150))
assert(!fault, String(fault))
assert(sleeps > 0 && peeks < 20000 && turns.length === 0, `turnDriver spun or ran premature turn (sleeps=${sleeps}, peeks=${peeks}, turns=${turns.length}) in src/daemon/runner/turnDriver.ts`)
queue.push({ value: 'Stop waiting.', mode: 'prompt', priority: 'next' })
driver.kick()
await new Promise(resolve => setTimeout(resolve, 30))
running = 0
driver.kick()
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(turns.length, 1)
assert(board.view().peerTurns === 0, `expected 0 peerTurns, got ${board.view().peerTurns} in src/crew/board/store.ts`)
console.log('PASS seven active seats, an outside report and unread board posts leave timers and operator work responsive')
board.close()
process.exit(0)
