import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'floor-admission-')))
const before = process.cwd()
const plain = join(scratch, 'plain')
const bare = join(scratch, 'bare')
mkdirSync(plain)
mkdirSync(bare)
writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
process.chdir(plain)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setIsInteractive(false)
bootstrap.setCwdState(plain)
await import('../../src/Tool.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { scoutRefusal } = await import('../../src/tools/AgentTool/scoutPolicy.js')
const { reviewerRefusal } = await import('../../src/tools/AgentTool/reviewerPolicy.js')
const { runTools } = await import('../../src/services/tools/toolOrchestration.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createAssistantMessage } = await import('../../src/utils/messages.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const prepare = (input: { command: string }) => BashTool.prepare!(input as never)
const safe = (input: { command: string }) => BashTool.isReadOnly(input as never) && BashTool.isConcurrencySafe(input as never)
const cwd = (path: string) => { process.chdir(path); bootstrap.setCwdState(path) }
const watchdog = setTimeout(() => { console.error('floor-admission: timed out waiting for product marks'); process.exit(1) }, 60_000)
try {
  const cold = { command: 'cat admission-cold-file' }
  check('cold synchronous admission refuses to guess', !safe(cold))
  await prepare(cold)
  check('prepare proves an ordinary read', safe(cold))
  const a = { command: 'git status' }
  await prepare(a)
  check('plain cwd permits the prepared git read', safe(a))
  cwd(bare)
  check('changing cwd invalidates even the same input object', !safe(a))
  const b = { command: 'git status' }
  await prepare(b)
  check('the same text beside bare-repository structure is not read-only', !safe(b))
  cwd(plain)
  check('the first input retains its own context-stamped verdict', safe(a))
  check('the second input never lends its verdict across cwds', !safe(b))
  writeFileSync(join(plain, 'f'), 'data\n')
  const disk = { command: 'cat f' }
  await prepare(disk)
  rmSync(join(plain, 'f'))
  check('read-only describes command effects, not file existence', safe(disk))
  await prepare({ command: 'echo admission-weak-reference' })
  for (let i = 0; i < 6; i++) { await new Promise<void>(resolve => setImmediate(resolve)); Bun.gc(true) }
  check('collected text-only retention becomes unproven', !safe({ command: 'echo admission-weak-reference' }))
  const retained = { command: 'echo admission-weak-reference' }
  await prepare(retained)
  check('a reclaimed verdict can be prepared again', safe(retained))
  check('scout prepares a cold read', await scoutRefusal(BashTool as never, { command: 'cat scout-admission-file' }) === null)
  const receipt = join(plain, 'review.txt')
  writeFileSync(receipt, 'review\n')
  check('reviewer prepares a cold read', await reviewerRefusal(BashTool as never, { command: 'cat reviewer-admission-file' }, receipt, plain) === null)
  for (const count of [3, 20]) {
    const inputs = Array.from({ length: count }, (_, i) => ({ command: `echo admission-${count}-${i}` }))
    await Promise.all(inputs.map(prepare))
    check(`${count} parallel preparations retain every verdict`, inputs.every(safe))
    let active = 0
    let peak = 0
    let calls = 0
    const waiting: Array<() => void> = []
    const width = Math.min(count, 10)
    const tool = {
      ...BashTool,
      async validateInput() { return { result: true as const } },
      async call(input: { command: string }) {
        calls++
        peak = Math.max(peak, ++active)
        await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === width) { for (const release of waiting.splice(0)) release() } })
        active--
        return { data: input.command }
      },
      mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
    }
    let state = getDefaultAppState()
    const context = {
      abortController: new AbortController(),
      options: { commands: [], tools: [tool], engineModel: 'claude-fable-5-1', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => state,
      setAppState: (update: (prev: typeof state) => typeof state) => { state = update(state) },
      messages: [], readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    }
    const blocks = inputs.map((input, i) => ({ type: 'tool_use', id: `admission-${count}-${i}`, name: 'Bash', input }))
    const parent = createAssistantMessage({ content: blocks as never })
    const allow = async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'fixture' } })
    let results = 0
    for await (const update of runTools(blocks as never, [parent], allow as never, context as never)) {
      const message = update.message
      if (message?.type === 'user' && Array.isArray(message.message.content)) results += message.message.content.filter(block => block.type === 'tool_result' && !block.is_error).length
    }
    check(`${count} real Bash admission predicates produce concurrent execution batches`, calls === count && results === count && peak === width, { calls, results, peak })
  }
} finally {
  clearTimeout(watchdog)
  cwd(before)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `floor-admission: ${failures} FAILURE(S)` : 'floor-admission: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
