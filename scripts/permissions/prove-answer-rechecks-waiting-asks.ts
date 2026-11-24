import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const originalCwd = process.cwd()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'answer-recheck-')))
const projectDir = join(sandbox, 'proj')
const outsideDir = join(sandbox, 'outside')
const configDir = join(sandbox, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(join(projectDir, 'wordstats.py'), 'def most_common():\n    return []\n')
writeFileSync(join(projectDir, 'test_wordstats.py'), 'def test_a():\n    pass\n')
writeFileSync(join(projectDir, 'a.txt'), 'a\n')
writeFileSync(join(projectDir, 'b.txt'), 'b\n')

process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(projectDir)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(projectDir)
setProjectRoot(projectDir)
setCwdState(projectDir)

const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createRunnerAsks } = await import('../../src/daemon/runner/runnerAsks.ts')
const { createPeer } = await import('../../src/daemon/runner-wire/peer.ts')
const { RunnerConnection } = await import('../../src/daemon/runner-link/runnerConnection.ts')
const { holdWorkerAsk, answerPermissionAsk, listPendingPermissionAsks } = await import('../../src/daemon/session-seat/permissionAsks.ts')
const { daemonDir } = await import('../../src/daemon/control/controlSocket.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { AsksPart } = await import('../../src/engine/connector/daemon/asks.ts')
const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
const { WriteTool } = await import('../../src/tools/write/WriteTool.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')

let failures = 0
const HINT =
  'change decisionOfAnswer and createHostCanUseTool in src/daemon/runner/runnerAsks.ts so an allow answer that changes the mode or adds a rule rechecks waiting asks via recheckPendingPermissionRequests, and wire AsksPart in src/engine/connector/daemon/asks.ts so recheckPermission and answerThroughDaemon refresh asks'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

const settle = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const ASSISTANT = { message: { id: 'recheck-proof' } } as never
const CAPABILITIES = { holds_asks: true, elicitation: false, partial_rows: false }

function makeContext(mode: 'default' | 'implement' | 'flow' = 'default') {
  let state = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode },
    tasks: {},
    sessionHooks: new Map(),
  }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    options: { tools: [EditTool, WriteTool, BashTool], isNonInteractiveSession: false },
    messages: [],
    readFileState: new Map(),
  }
  return {
    ctx: ctx as never,
    mode: () => state.toolPermissionContext.mode,
    abort: () => ctx.abortController.abort(),
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms = 500): Promise<{ settled: true; value: T } | { settled: false }> {
  return Promise.race([
    promise.then(value => ({ settled: true as const, value })),
    settle(ms).then(() => ({ settled: false as const })),
  ])
}

try {
  {
    const toHost = new PassThrough()
    const toRunner = new PassThrough()
    const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
    const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
    runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'in-proc-recheck' }))
    const hostAsks: Array<{ id: number; params: Record<string, unknown>; resolve: (a: Record<string, unknown>) => void }> = []
    const withdrawn = new Set<number>()
    host.onRequest('permission/request', (params, ctx) => {
      const id = ctx.id
      ctx.signal.addEventListener('abort', () => withdrawn.add(id), { once: true })
      return new Promise(resolve => {
        hostAsks.push({ id, params: params as Record<string, unknown>, resolve: resolve as (a: Record<string, unknown>) => void })
      }) as never
    })
    await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities: CAPABILITIES })
    const asks = createRunnerAsks(runner, () => CAPABILITIES)
    const canUseTool = asks.createCanUseTool()
    const state = makeContext('default')

    const edit1Input = { file_path: join(projectDir, 'wordstats.py'), old_string: 'return []', new_string: 'return [1]' }
    const edit2Input = { file_path: join(projectDir, 'test_wordstats.py'), old_string: 'pass', new_string: 'assert True' }
    const bashInput = { command: 'node -e "process.exit(0)"' }
    const outsideInput = { file_path: join(outsideDir, 'out.txt'), content: 'outside' }

    const pEdit1 = canUseTool(EditTool as never, edit1Input, state.ctx, ASSISTANT, 'edit-1')
    const pEdit2 = canUseTool(EditTool as never, edit2Input, state.ctx, ASSISTANT, 'edit-2')
    const pBash = canUseTool(BashTool as never, bashInput, state.ctx, ASSISTANT, 'bash-1')
    const pOutside = canUseTool(WriteTool as never, outsideInput, state.ctx, ASSISTANT, 'outside-1')

    for (let i = 0; i < 100 && hostAsks.length < 4; i++) await settle(10)
    check('in-process: all four asks reached the host', hostAsks.length === 4 && asks.parkedAsks() === 4, `hostAsks=${hostAsks.length} parked=${asks.parkedAsks()}`)

    const edit1Ask = hostAsks.find(a => a.params.tool_use_id === 'edit-1')!
    const edit2Ask = hostAsks.find(a => a.params.tool_use_id === 'edit-2')!
    const bashAsk = hostAsks.find(a => a.params.tool_use_id === 'bash-1')!
    const outsideAsk = hostAsks.find(a => a.params.tool_use_id === 'outside-1')!

    edit1Ask.resolve({
      outcome: 'allow',
      rules: [{ type: 'setMode', mode: 'implement', destination: 'session' }],
    })

    const dEdit1 = await pEdit1
    const rEdit2 = await raceTimeout(pEdit2, 400)
    await settle(40)
    const rBash = await raceTimeout(pBash, 80)
    const rOutside = await raceTimeout(pOutside, 80)

    check('in-process: answering edit 1 with setMode implement allows edit 1 and switches mode', dEdit1.behavior === 'allow' && state.mode() === 'implement', JSON.stringify(dEdit1))
    check(
      'in-process: waiting edit 2 goes through automatically with mode judgement and is withdrawn on the wire',
      rEdit2.settled && rEdit2.value.behavior === 'allow' && rEdit2.value.decisionReason?.type === 'mode' && withdrawn.has(edit2Ask.id),
      JSON.stringify({ rEdit2, withdrawn: [...withdrawn], edit2Id: edit2Ask.id }),
    )
    check(
      'in-process: waiting shell ask still waits untouched after switching to implement mode',
      !rBash.settled && !withdrawn.has(bashAsk.id),
      JSON.stringify({ rBash, withdrawn: [...withdrawn] }),
    )
    check(
      'in-process: waiting outside-project write still waits untouched after switching to implement mode',
      !rOutside.settled && !withdrawn.has(outsideAsk.id),
      JSON.stringify({ rOutside, withdrawn: [...withdrawn] }),
    )

    const pBash2 = canUseTool(BashTool as never, { command: 'node -e "process.exit(1)"' }, state.ctx, ASSISTANT, 'bash-2')
    const pBashOther = canUseTool(BashTool as never, { command: 'python3 -c "pass"' }, state.ctx, ASSISTANT, 'bash-other')
    for (let i = 0; i < 100 && hostAsks.length < 6; i++) await settle(10)
    const bash2Ask = hostAsks.find(a => a.params.tool_use_id === 'bash-2')!
    const bashOtherAsk = hostAsks.find(a => a.params.tool_use_id === 'bash-other')!

    bashAsk.resolve({
      outcome: 'allow',
      rules: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'node -e *' }] }],
    })
    const dBash1 = await pBash
    const rBash2 = await raceTimeout(pBash2, 400)
    await settle(40)
    const rBashOther = await raceTimeout(pBashOther, 80)
    const rOutsideStill = await raceTimeout(pOutside, 80)

    check(
      'in-process: answering with addRules releases matching waiting shell ask with rule judgement (not human approval)',
      dBash1.behavior === 'allow' &&
        rBash2.settled &&
        rBash2.value.behavior === 'allow' &&
        rBash2.value.decisionReason?.type !== 'permissionPromptTool' &&
        withdrawn.has(bash2Ask.id),
      JSON.stringify({ dBash1, rBash2, withdrawn: [...withdrawn] }),
    )
    check(
      'in-process: non-matching shell ask and outside write stay waiting untouched',
      !rBashOther.settled && !withdrawn.has(bashOtherAsk.id) && !rOutsideStill.settled && !withdrawn.has(outsideAsk.id),
      JSON.stringify({ rBashOther, rOutsideStill, withdrawn: [...withdrawn] }),
    )

    asks.denyPendingPermissionRequests('cleanup')
    await Promise.all([pBashOther, pOutside])
    host.end()
    runner.end()
  }

  {
    const dDir = daemonDir()
    mkdirSync(dDir, { recursive: true })
    const sessionId = 'daemon-recheck-session'
    const workerId = 'concourse-w1'
    writeFileSync(
      concourseWorkersPath(dDir),
      JSON.stringify({
        version: 1,
        workers: {
          [workerId]: {
            runnerId: workerId,
            sessionId,
            workspaceId: projectDir,
            modelKey: 'claude-sonnet-5-5',
            permissionMode: 'default',
            createdAt: Date.now(),
            startedAt: Date.now(),
          },
        },
      }),
    )

    const toHost = new PassThrough()
    const toRunner = new PassThrough()
    const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
    runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: sessionId }))

    const conn = new RunnerConnection(
      { input: toHost, output: toRunner },
      CAPABILITIES,
      {
        onRow() {},
        onAsk: params => holdWorkerAsk(workerId, params, dDir, undefined, () => 'attached'),
        onApplied() {},
        onProtocolError() {},
        log() {},
      },
    )
    await conn.initialized

    const asks = createRunnerAsks(runner, () => CAPABILITIES)
    const canUseTool = asks.createCanUseTool()
    const state = makeContext('default')

    let recheckAsksCalls = 0
    const asksPart = new AsksPart({
      record: () => ({ sessionId, modelKey: 'claude-sonnet-5-5' }),
      rows: () => [],
      facts: () => null,
      permissionMode: () => state.mode(),
      chainRpc: async req => {
        const res = answerPermissionAsk(
          String(req.requestId),
          req.allow === true,
          'operator',
          undefined,
          req.answer as Parameters<typeof answerPermissionAsk>[4],
        )
        return { ok: true, ...res }
      },
      deliver: async () => ({ ok: true }) as never,
      recheckAsks: () => {
        recheckAsksCalls++
      },
    })

    const pEdit1 = canUseTool(EditTool as never, { file_path: join(projectDir, 'a.txt'), old_string: 'a', new_string: 'a1' }, state.ctx, ASSISTANT, 'd-edit-1')
    const pEdit2 = canUseTool(EditTool as never, { file_path: join(projectDir, 'b.txt'), old_string: 'b', new_string: 'b1' }, state.ctx, ASSISTANT, 'd-edit-2')
    const pBash = canUseTool(BashTool as never, { command: 'node -e "process.exit(0)"' }, state.ctx, ASSISTANT, 'd-bash-1')
    const pOutside = canUseTool(WriteTool as never, { file_path: join(outsideDir, 'd-out.txt'), content: 'x' }, state.ctx, ASSISTANT, 'd-outside-1')

    for (let i = 0; i < 100 && listPendingPermissionAsks().filter(a => a.sessionId === sessionId).length < 4; i++) await settle(10)
    asksPart.readAsks()
    check('daemon: screen sees all four waiting asks', asksPart.asks().length === 4, `asks=${asksPart.asks().length}`)

    const first = asksPart.asks().find(a => a.confirm.toolUseID === 'd-edit-1')!
    await first.confirm.onAllow(first.confirm.input, [{ type: 'setMode', mode: 'implement', destination: 'session' }])

    const dEdit1 = await pEdit1
    const rEdit2 = await raceTimeout(pEdit2, 500)
    for (let i = 0; i < 50 && listPendingPermissionAsks().filter(a => a.sessionId === sessionId).length > 2; i++) await settle(10)

    const remainingBefore = asksPart.asks()
    await remainingBefore[0]?.confirm.recheckPermission()
    const remainingAfter = asksPart.asks()
    const rBash = await raceTimeout(pBash, 80)
    const rOutside = await raceTimeout(pOutside, 80)

    check(
      'daemon: waiting edit 2 resolves automatically with mode judgement',
      dEdit1.behavior === 'allow' && rEdit2.settled && rEdit2.value.behavior === 'allow' && rEdit2.value.decisionReason?.type === 'mode',
      JSON.stringify({ dEdit1, rEdit2 }),
    )
    check(
      'daemon: recheckPermission drops edit 2 from the screen asks and leaves only the shell and outside-write asks untouched',
      remainingAfter.length === 2 &&
        remainingAfter.some(a => a.confirm.toolUseID === 'd-bash-1') &&
        remainingAfter.some(a => a.confirm.toolUseID === 'd-outside-1') &&
        !remainingAfter.some(a => a.confirm.toolUseID === 'd-edit-2') &&
        recheckAsksCalls > 0,
      JSON.stringify({ ids: remainingAfter.map(a => a.confirm.toolUseID), recheckAsksCalls }),
    )
    check(
      'daemon: shell and outside-write asks stay pending on runner and daemon',
      !rBash.settled && !rOutside.settled && listPendingPermissionAsks().filter(a => a.sessionId === sessionId).length === 2,
      JSON.stringify({ rBash, rOutside, pending: listPendingPermissionAsks().filter(a => a.sessionId === sessionId).map(a => a.toolName) }),
    )

    asks.denyPendingPermissionRequests('cleanup')
    await Promise.all([pBash, pOutside])
    conn.close('cleanup')
    runner.end()
  }
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `Answer rechecks waiting asks: ${failures} FAILED` : 'Answer rechecks waiting asks: ALL PASS')
process.exit(failures ? 1 : 0)
