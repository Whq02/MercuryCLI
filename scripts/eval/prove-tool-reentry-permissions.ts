#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, makeContext, section, setup, sleep, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { makeEvalBridgeServer } = await import('../../src/tools/engines/eval-kernels/evalBridge.js')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.js')
const { FileReadTool } = await import('../../src/tools/read/ReadTool.js')

function failHint(ok: boolean, detail: string, fix: string): string {
  return ok ? detail : detail ? `${detail} — ${fix}` : fix
}

type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; decisionReason?: unknown }

function makeAskQueue(script: (toolName: string, input: Record<string, unknown>) => Promise<Decision> | Decision) {
  const log: Array<{ tool: string; at: number; settledAt?: number }> = []
  let chain: Promise<unknown> = Promise.resolve()
  let concurrent = 0
  let maxConcurrent = 0
  const canUseTool = (async (tool: { name: string }, input: Record<string, unknown>) => {
    const entry = { tool: tool.name, at: Date.now() } as { tool: string; at: number; settledAt?: number }
    log.push(entry)
    const run = async (): Promise<Decision> => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        return await script(tool.name, input)
      } finally {
        concurrent--
        entry.settledAt = Date.now()
      }
    }
    const result = chain.then(run, run)
    chain = result.catch(() => undefined)
    return result
  }) as never
  return { canUseTool, log, stats: () => ({ maxConcurrent }) }
}

async function runCellWithBridge(args: {
  owner: string
  code: string
  canUseTool: never
  abort?: AbortController
  timeoutSeconds?: number
  tools?: unknown[]
}) {
  const abort = args.abort ?? new AbortController()
  const context = await makeContext({ tools: args.tools ?? [FileWriteTool, FileReadTool], abortController: abort })
  const cellAbort = new AbortController()
  const serveBridge = makeEvalBridgeServer({ context, canUseTool: args.canUseTool, cellAbort })
  try {
    return await within(
      'cell with bridge',
      60_000,
      evalKernelManager.runCell({
        owner: args.owner,
        cwd: work,
        input: { language: 'py', code: args.code, ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}) },
        abortSignal: abort.signal,
        serveBridge,
      }),
    )
  } finally {
    cellAbort.abort()
  }
}

try {
  section('DENY blocks the write with a typed cell error; nothing lands')
  const denyTarget = join(work, 'denied.txt')
  const denyQueue = makeAskQueue(() => ({ behavior: 'deny', message: 'Permission to use Write was denied by the operator.' }))
  const d1 = await runCellWithBridge({
    owner: 'perm-A',
    code: `try:\n    write_file(${JSON.stringify(denyTarget)}, 'nope')\n    outcome = 'wrote'\nexcept Exception as e:\n    outcome = 'refused: ' + str(e)\noutcome`,
    canUseTool: denyQueue.canUseTool,
  })
  check('cell completed (the deny raised INTO the cell)', d1.status === 'ok', failHint(d1.status === 'ok', JSON.stringify(d1.error ?? d1.annotations), 'a denied permission must come back to the cell as a catchable error, not end the cell; see the canUseTool call in makeEvalBridgeServer, src/tools/engines/eval-kernels/evalBridge.ts'))
  check('the refusal names the permission denial', (d1.resultRepr ?? '').includes('denied'), failHint((d1.resultRepr ?? '').includes('denied'), d1.resultRepr ?? '', 'the deny message must reach the cell error text; see the error returned for a denied call in src/tools/engines/eval-kernels/evalBridge.ts'))
  check('NOTHING was written', !existsSync(denyTarget), failHint(!existsSync(denyTarget), '', 'a denied Write must not run; the bridge in src/tools/engines/eval-kernels/evalBridge.ts must stop at the canUseTool deny before the tool executes'))
  check('the decision saw the real tool name (Write)', denyQueue.log.some(e => e.tool === 'Write'), failHint(denyQueue.log.some(e => e.tool === 'Write'), JSON.stringify(denyQueue.log), 'write_file in the cell must ask canUseTool with the Write tool; see src/tools/engines/eval-kernels/evalBridge.ts'))

  section('ALLOW lands the write through the full transaction')
  const allowTarget = join(work, 'allowed.txt')
  const allowQueue = makeAskQueue((_tool, input) => ({ behavior: 'allow', updatedInput: input }))
  const a1 = await runCellWithBridge({
    owner: 'perm-A',
    code: `write_file(${JSON.stringify(allowTarget)}, 'landed')\n'done'`,
    canUseTool: allowQueue.canUseTool,
  })
  check('cell ok', a1.status === 'ok', failHint(a1.status === 'ok', JSON.stringify(a1.error ?? a1.annotations), 'an allowed write_file must complete the cell; see makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts'))
  check('the write LANDED', existsSync(allowTarget) && readFileSync(allowTarget, 'utf8') === 'landed', failHint(existsSync(allowTarget) && readFileSync(allowTarget, 'utf8') === 'landed', '', 'an allow decision must run the Write tool with its updatedInput; see src/tools/engines/eval-kernels/evalBridge.ts'))

  section('a pending ask PAUSES the runtime budget')
  const slowTarget = join(work, 'slow.txt')
  const slowQueue = makeAskQueue(async (_tool, input) => {
    await sleep(2_400)
    return { behavior: 'allow', updatedInput: input }
  })
  const s1 = await runCellWithBridge({
    owner: 'perm-A',
    code: `write_file(${JSON.stringify(slowTarget)}, 'patient')\n'finished'`,
    canUseTool: slowQueue.canUseTool,
    timeoutSeconds: 1,
  })
  check('the 1s-budget cell SURVIVED the 2.4s decision (budget paused)', s1.status === 'ok', failHint(s1.status === 'ok', `${s1.status} ${JSON.stringify(s1.annotations)}`, 'the runtime budget must pause while a bridge call waits; see runtime.pause() in runCell, src/tools/engines/eval-kernels/kernelManager.ts'))
  check('the write landed after the slow allow', existsSync(slowTarget), failHint(existsSync(slowTarget), '', 'the slow allow must still run the write; see runCell in src/tools/engines/eval-kernels/kernelManager.ts and src/tools/engines/eval-kernels/evalBridge.ts'))
  check('bridge time was accounted (>=2.4s)', s1.bridgeMs >= 2_300, failHint(s1.bridgeMs >= 2_300, String(s1.bridgeMs), 'time spent waiting on a bridge call must be added to bridgeMs in runCell, src/tools/engines/eval-kernels/kernelManager.ts'))
  check('runtime stayed under budget', s1.runtimeMs < 1_000, failHint(s1.runtimeMs < 1_000, String(s1.runtimeMs), 'bridge wait time must not count toward runtimeMs; see the budget pause and resume in src/tools/engines/eval-kernels/kernelManager.ts'))

  section("two cells' asks queue without wedging")
  const q = makeAskQueue(async (_tool, input) => {
    await sleep(500)
    return { behavior: 'allow', updatedInput: input }
  })
  const t1 = join(work, 'queue-1.txt')
  const t2 = join(work, 'queue-2.txt')
  const [c1, c2] = await Promise.all([
    runCellWithBridge({ owner: 'perm-Q1', code: `write_file(${JSON.stringify(t1)}, 'one')\n'q1'`, canUseTool: q.canUseTool, timeoutSeconds: 30 }),
    runCellWithBridge({ owner: 'perm-Q2', code: `write_file(${JSON.stringify(t2)}, 'two')\n'q2'`, canUseTool: q.canUseTool, timeoutSeconds: 30 }),
  ])
  check('both cells settled ok', c1.status === 'ok' && c2.status === 'ok', failHint(c1.status === 'ok' && c2.status === 'ok', `${c1.status}/${c2.status}`, 'a queued permission ask must not wedge or fail the other cell; see src/tools/engines/eval-kernels/evalBridge.ts and runCell in src/tools/engines/eval-kernels/kernelManager.ts'))
  check('both writes landed', existsSync(t1) && existsSync(t2), failHint(existsSync(t1) && existsSync(t2), '', 'both queued allows must run their writes; see src/tools/engines/eval-kernels/evalBridge.ts'))
  check('asks were answered SERIALLY (queue, not overlap)', q.stats().maxConcurrent === 1, failHint(q.stats().maxConcurrent === 1, String(q.stats().maxConcurrent), 'the ask queue in makeAskQueue in this file chains decisions; a value above 1 means the chain in this test helper was bypassed'))

  section('abort mid-ask: no wedge, nothing written, cell cancelled')
  const abortTarget = join(work, 'aborted.txt')
  const abortController = new AbortController()
  let askSeen = false
  const hangingQueue = makeAskQueue(async () => {
    askSeen = true
    await sleep(60_000)
    return { behavior: 'deny', message: 'unreachable' }
  })
  const pendingCell = runCellWithBridge({
    owner: 'perm-A',
    code: `write_file(${JSON.stringify(abortTarget)}, 'never')\n'x'`,
    canUseTool: hangingQueue.canUseTool,
    abort: abortController,
    timeoutSeconds: 30,
  })
  await sleep(1_200)
  check('the ask was pending when the abort fired', askSeen, failHint(askSeen, '', 'write_file never reached canUseTool within 1.2s; see makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts and the kernel start in src/tools/engines/eval-kernels/kernelManager.ts'))
  abortController.abort()
  const ab = await within('abort settles the cell', 20_000, pendingCell)
  check('the cell settled cancelled (no wedge)', ab.status === 'cancelled', failHint(ab.status === 'cancelled', ab.status, 'aborting the session while an ask is pending must cancel the cell; see the abortSignal handling in runCell, src/tools/engines/eval-kernels/kernelManager.ts'))
  check('nothing was written through the aborted ask', !existsSync(abortTarget), failHint(!existsSync(abortTarget), '', 'an aborted ask must not run the Write tool; see src/tools/engines/eval-kernels/evalBridge.ts'))

  section('transaction-level refusals reach the cell typed')
  const allow2 = makeAskQueue((_t, input) => ({ behavior: 'allow', updatedInput: input }))
  const u1 = await runCellWithBridge({
    owner: 'perm-A',
    code: "try:\n    tool.NoSuchTool(x=1)\n    r = 'ran'\nexcept Exception as e:\n    r = 'refused: ' + str(e)\nr",
    canUseTool: allow2.canUseTool,
  })
  check('unknown tool → typed refusal into the cell', (u1.resultRepr ?? '').includes('No such tool'), failHint((u1.resultRepr ?? '').includes('No such tool'), u1.resultRepr ?? '', 'an unknown tool name must be refused with No such tool available; see the unknown-tool branch in src/engine/tool-dispatch/toolExecution.ts'))
  const self1 = await runCellWithBridge({
    owner: 'perm-A',
    code: "try:\n    tool.Eval(language='py', code='1')\n    r = 'ran'\nexcept Exception as e:\n    r = 'refused: ' + str(e)\nr",
    canUseTool: allow2.canUseTool,
  })
  check('Eval cannot re-enter itself', (self1.resultRepr ?? '').includes('cannot re-enter itself'), failHint((self1.resultRepr ?? '').includes('cannot re-enter itself'), self1.resultRepr ?? '', 'tool.Eval from a cell must be refused with Eval cannot re-enter itself; see src/tools/engines/eval-kernels/evalBridge.ts'))
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0, failHint(evalKernelManager.kernelCount() === 0, '', 'disposeAll must close every kernel; see disposeAll in src/tools/engines/eval-kernels/kernelManager.ts'))
  cleanup()
}
finish('TOOL-REENTRY-PERMISSIONS')
