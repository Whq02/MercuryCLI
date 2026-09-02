#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-tool-reentry-permissions.ts
//  PROOF (spec c.4 #3 — THE gate): a re-entered tool call inside a cell
//  meets the SAME permission machinery as a direct call, through the SAME
//  canUseTool the session handed the tool. Proven here:
//    · deny  → typed cell error naming the refusal; NOTHING written;
//    · allow → the write lands, attributed through the full transaction;
//    · a pending ask PAUSES the runtime budget (a 1s-budget cell survives a
//      2.4s human decision);
//    · two cells' asks queue without wedging (both settle; decisions serial);
//    · abort mid-ask → the cell cancels; no wedge, nothing written;
//    · an unknown tool name → the transaction's own typed refusal;
//    · Eval can never re-enter itself.
//  The permission double stands in for the interactive dialog; the DECISION
//  path around it (runToolUse → resolveHookPermissionDecision → canUseTool)
//  is the production one, unmocked.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, makeContext, section, setup, sleep, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { makeEvalBridgeServer } = await import('../../src/services/eval/evalBridge.js')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.js')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')

type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; decisionReason?: unknown }

/** The permission double: scripted decisions, serialized like the real ask
 *  queue, with full observability. */
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
  check('cell completed (the deny raised INTO the cell)', d1.status === 'ok', JSON.stringify(d1.error ?? d1.annotations))
  check('the refusal names the permission denial', (d1.resultRepr ?? '').includes('denied'), d1.resultRepr)
  check('NOTHING was written', !existsSync(denyTarget))
  check('the decision saw the real tool name (Write)', denyQueue.log.some(e => e.tool === 'Write'), JSON.stringify(denyQueue.log))

  section('ALLOW lands the write through the full transaction')
  const allowTarget = join(work, 'allowed.txt')
  const allowQueue = makeAskQueue((_tool, input) => ({ behavior: 'allow', updatedInput: input }))
  const a1 = await runCellWithBridge({
    owner: 'perm-A',
    code: `write_file(${JSON.stringify(allowTarget)}, 'landed')\n'done'`,
    canUseTool: allowQueue.canUseTool,
  })
  check('cell ok', a1.status === 'ok', JSON.stringify(a1.error ?? a1.annotations))
  check('the write LANDED', existsSync(allowTarget) && readFileSync(allowTarget, 'utf8') === 'landed')

  section('a pending ask PAUSES the runtime budget')
  const slowTarget = join(work, 'slow.txt')
  const slowQueue = makeAskQueue(async (_tool, input) => {
    await sleep(2_400) // the human thinks for 2.4s; the cell budget is 1s
    return { behavior: 'allow', updatedInput: input }
  })
  const s1 = await runCellWithBridge({
    owner: 'perm-A',
    code: `write_file(${JSON.stringify(slowTarget)}, 'patient')\n'finished'`,
    canUseTool: slowQueue.canUseTool,
    timeoutSeconds: 1,
  })
  check('the 1s-budget cell SURVIVED the 2.4s decision (budget paused)', s1.status === 'ok', `${s1.status} ${JSON.stringify(s1.annotations)}`)
  check('the write landed after the slow allow', existsSync(slowTarget))
  check('bridge time was accounted (>=2.4s)', s1.bridgeMs >= 2_300, String(s1.bridgeMs))
  check('runtime stayed under budget', s1.runtimeMs < 1_000, String(s1.runtimeMs))

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
  check('both cells settled ok', c1.status === 'ok' && c2.status === 'ok', `${c1.status}/${c2.status}`)
  check('both writes landed', existsSync(t1) && existsSync(t2))
  check('asks were answered SERIALLY (queue, not overlap)', q.stats().maxConcurrent === 1, String(q.stats().maxConcurrent))

  section('abort mid-ask: no wedge, nothing written, cell cancelled')
  const abortTarget = join(work, 'aborted.txt')
  const abortController = new AbortController()
  let askSeen = false
  const hangingQueue = makeAskQueue(async () => {
    askSeen = true
    await sleep(60_000) // the dialog never answers; the user aborts instead
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
  check('the ask was pending when the abort fired', askSeen)
  abortController.abort()
  const ab = await within('abort settles the cell', 20_000, pendingCell)
  check('the cell settled cancelled (no wedge)', ab.status === 'cancelled', ab.status)
  check('nothing was written through the aborted ask', !existsSync(abortTarget))

  section('transaction-level refusals reach the cell typed')
  const allow2 = makeAskQueue((_t, input) => ({ behavior: 'allow', updatedInput: input }))
  const u1 = await runCellWithBridge({
    owner: 'perm-A',
    code: "try:\n    tool.NoSuchTool(x=1)\n    r = 'ran'\nexcept Exception as e:\n    r = 'refused: ' + str(e)\nr",
    canUseTool: allow2.canUseTool,
  })
  check('unknown tool → typed refusal into the cell', (u1.resultRepr ?? '').includes('No such tool'), u1.resultRepr)
  const self1 = await runCellWithBridge({
    owner: 'perm-A',
    code: "try:\n    tool.Eval(language='py', code='1')\n    r = 'ran'\nexcept Exception as e:\n    r = 'refused: ' + str(e)\nr",
    canUseTool: allow2.canUseTool,
  })
  check('Eval cannot re-enter itself', (self1.resultRepr ?? '').includes('cannot re-enter itself'), self1.resultRepr)
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  cleanup()
}
finish('TOOL-REENTRY-PERMISSIONS')
