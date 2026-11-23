
import { mkdtempSync, rmSync } from 'node:fs'
import { gitArgs } from '../git/spawnArgs.js'

export function sweepProbeDir(
  dir: string,
  remover: (path: string) => void = path => rmSync(path, { recursive: true, force: true }),
  attempts = 4,
  pauseMs = 50,
): boolean {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      remover(dir)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = isTransientWin32FsCode(code) || code === 'ENOTEMPTY'
      if (!transient || attempt === attempts) {
        logForDebugging(`deep probe: scratch sweep of ${dir} failed after ${attempt} attempt(s): ${String(error)}`)
        return false
      }
      sleepSync(pauseMs)
    }
  }
  return false
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from '../logs/debugLog.js'
import { subprocessEnv } from '../processes/subprocessEnv.js'
import { isTransientWin32FsCode } from '../substrate/durablePublish.js'
import type { HealthCheck } from './healthCertCore.js'
import { deleteFlagEnv, flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import { pollUntil } from '../async/deadline.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { LSPServerInstance } from '../../integrations/lsp/LSPServerInstance.js'
import type { LSPServerManager } from '../../integrations/lsp/LSPServerManager.js'
import { endProcessTree } from '../processes/processGroup.js'
import { passedOver } from '../errors/passedOver.js'
import { sleepSync, startTimeout } from '../async/timers.js'

type CheckResult = Omit<HealthCheck, 'id' | 'label'>

function fixtureOwnerKey(mod: typeof import('../../engine/run-owner/ownerKey.js'), tag: string) {
  return mod.makeOwnerKey({
    workspace: `/tmp/health-probe`,
    sessionId: `health-${tag}-${process.pid}`,
    lane: 'main',
  })
}

export async function probeRunKernel(): Promise<CheckResult> {
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const kernel = await import('../../engine/run/runKernel.js')
  const sidecar = await import('../../engine/run/runSidecar.js')
  const coordinator = await import('../../engine/run/runCoordinator.js')
  const lifecycle = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'runkernel')
  try {
    let snap = kernel.emptyRunSnapshot({
      runId: 'probe',
      owner,
      objective: 'health probe',
      rootMessageId: null,
      at: Date.now(),
    })
    snap = kernel.reduceRunEvent(snap, { type: 'substantive', at: Date.now(), reason: 'probe' })
    snap = kernel.reduceRunEvent(snap, {
      type: 'task-transition',
      at: Date.now(),
      taskId: 'p1',
      title: 'probe deliverable',
      state: 'open',
    })
    snap = kernel.reduceRunEvent(snap, {
      type: 'tool-effected',
      at: Date.now(),
      toolName: 'Edit',
      toolUseId: 'p-tu',
      operation: 'edit',
      outcome: 'succeeded',
      changedPaths: ['/tmp/health-probe/x.ts'],
    })
    await sidecar.saveRunSidecar(owner, snap)
    const loaded = await sidecar.loadRunSidecar(owner)
    if (loaded.state !== 'loaded' || loaded.snapshot.deliverables.length !== 1) {
      return { status: 'fail', evidence: `sidecar round trip broke: ${loaded.state}` }
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(sidecar.runSidecarPath(owner), '{"schema":1,"snaps', 'utf8')
    const torn = await sidecar.loadRunSidecar(owner)
    if (torn.state !== 'recoverable') {
      return { status: 'fail', evidence: `torn sidecar loaded as ${torn.state} (must be recoverable)` }
    }
    await sidecar.saveRunSidecar(owner, snap)
    const rec = await coordinator.reconcileOnResume(owner, process.cwd())
    if (rec.state !== 'reconciled') {
      return { status: 'fail', evidence: `reconcile returned ${rec.state}` }
    }
    return {
      status: 'ok',
      evidence: `functional: create→persist→torn-recover→reload→reconcile→dispose completed (fixture owner, atomic sidecar)`,
    }
  } finally {
    await sidecar.deleteRunSidecar(owner).catch(passedOver)
    await lifecycle.disposeOwner(owner)
  }
}

export async function probeContextParity(): Promise<CheckResult> {
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const planMod = await import('../../engine/run/requestContextPlan.js')
  const epochs = await import('../../engine/run/contextEpochs.js')
  const lifecycle = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'ctx')
  const other = fixtureOwnerKey(ownerMod, 'ctx-other')
  try {
    const messages: Message[] = [
      {
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-0000000000a1',
        timestamp: new Date().toISOString(),
        requestId: undefined,
        message: {
          type: 'message',
          role: 'assistant',
          id: 'probe-msg-1',
          model: 'probe',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/f' } }],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            inference_geo: null,
            iterations: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
          container: null,
          context_management: null,
        },
      },
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-0000000000b1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'probe '.repeat(40) }],
        },
      },
    ]
    const input = {
      messages,
      owner,
      querySource: 'main_thread' as const,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
    }
    const applied = await planMod.buildRequestContextPlan(input, 'apply')
    const inspected = await planMod.buildRequestContextPlan(input, 'inspect')
    if (applied.digest !== inspected.digest) {
      return {
        status: 'fail',
        evidence: `apply/inspect digests DIVERGE (${applied.digest.slice(0, 8)} vs ${inspected.digest.slice(0, 8)})`,
      }
    }
    const e1 = epochs.advanceContextEpoch(owner, {
      kind: 'manual-compact',
      reason: 'probe',
      tokensBefore: 100,
      tokensAfter: 10,
      preservedTailCount: 0,
    })
    let staleRan = false
    epochs.advanceContextEpoch(owner, {
      kind: 'manual-compact',
      reason: 'probe2',
      tokensBefore: null,
      tokensAfter: null,
      preservedTailCount: null,
    })
    epochs.ifEpochCurrent(owner, e1, () => {
      staleRan = true
    })
    if (staleRan) return { status: 'fail', evidence: 'a STALE epoch sweep was allowed to run' }
    if (epochs.getContextEpoch(other).epoch !== 0) {
      return { status: 'fail', evidence: 'epoch advance leaked across owners' }
    }
    return {
      status: 'ok',
      evidence: 'functional: apply/inspect digest parity + epoch monotonicity + stale-sweep guard + owner isolation completed on a fixture',
    }
  } finally {
    await lifecycle.disposeOwner(owner)
    await lifecycle.disposeOwner(other)
  }
}

export async function probeLspEngine(): Promise<CheckResult> {
  const { normalizeWorkspaceEdit, applyEditsToText } = await import(
    '../../integrations/lsp/workspaceEditApply.js'
  )
  const { awaitDiagnosticStabilization } = await import('../../tools/lsp/mercuryOps.js')
  const { registerPendingLSPDiagnostic, _publishListenerCountForTesting } = await import(
    '../../integrations/lsp/LSPDiagnosticRegistry.js'
  )
  const normalized = normalizeWorkspaceEdit({
    changes: {
      'file:///tmp/probe.ts': [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          newText: 'qux',
        },
      ],
    },
  })
  if (!normalized.ok || normalized.files.length !== 1) {
    return { status: 'fail', evidence: 'workspace-edit normalization broke' }
  }
  const appliedText = applyEditsToText('const foo = 1\n', normalized.files[0]!.edits)
  if (!appliedText.ok || !appliedText.text.startsWith('const qux')) {
    return { status: 'fail', evidence: 'edit application produced wrong text' }
  }
  const fakeServer: LSPServerInstance = {
    name: 'probe',
    config: { command: 'probe', extensionToLanguage: { '.py': 'python' }, transport: 'stdio', scope: 'dynamic', source: 'probe' },
    state: 'running',
    capabilities: {},
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    generation: 1,
    start: async () => {},
    stop: async () => undefined,
    restart: async () => undefined,
    isHealthy: () => true,
    sendRequest: async () => {
      throw new Error('probe fakeServer.sendRequest not used')
    },
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
  }
  const fakeManager: LSPServerManager = {
    initialize: async () => {},
    shutdown: async () => [],
    getServerForFile: () => fakeServer,
    getServersForFile: () => [fakeServer],
    ensureServerStarted: async () => fakeServer,
    sendRequest: async () => undefined,
    getAllServers: () => new Map([['probe', fakeServer]]),
    openFile: async () => {},
    changeFile: async () => {},
    saveFile: async () => {},
    closeFile: async () => {},
    changeAndSaveFile: async () => {},
    getDocumentVersion: () => 1,
    closeAllFiles: async () => 0,
    isFileOpen: () => false,
    revalidateOpenDocuments: async () => ({ checked: 0, resynced: [], closed: [], failed: [] }),
  }
  const before = _publishListenerCountForTesting()
  const pending = awaitDiagnosticStabilization(fakeManager, '/tmp/health-push/probe.py', {
    deadlineMs: 1_200,
    quietWindowMs: 80,
  })
  startTimeout(() => {
    registerPendingLSPDiagnostic({
      serverName: 'probe',
      files: [
        {
          uri: 'file:///tmp/health-push/probe.py',
          diagnostics: [
            {
              severity: 'Error',
              message: 'x',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
        },
      ],
    })
  }, 40)
  const outcome = await pending
  if (outcome.state !== 'fresh' || outcome.errors !== 1) {
    return { status: 'fail', evidence: `push stabilization returned ${outcome.state} (wanted fresh/1 error)` }
  }
  if (_publishListenerCountForTesting() !== before) {
    return { status: 'fail', evidence: 'stabilization barrier leaked a publish listener' }
  }
  return {
    status: 'ok',
    evidence: 'functional: workspace-edit normalize/apply + push-lane quiet-window barrier completed (deterministic, no live server)',
  }
}

export async function probeDapEngine(signal?: AbortSignal): Promise<CheckResult> {
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const dap = await import('../../integrations/debugger/dapClient.js')
  const { probeAdapterSpec } = await import('../../integrations/debugger/probeAdapter.js')
  const lifecycle = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'dap')
  const dir = mkdtempSync(join(tmpdir(), 'health-dap-'))
  try {
    const session = await dap.createDapSession({
      owner,
      id: 'health-probe',
      adapterKey: 'health-probe',
      specOverride: probeAdapterSpec(),
      program: '/tmp/probe.py',
      cwd: dir,
      breakpoints: new Map([['/tmp/probe.py', [3]]]),
    })
    const stop = await session.waitForStopOutcome(6_000, signal)
    if (stop.state !== 'stopped' || stop.info.reason !== 'breakpoint') {
      return { status: 'fail', evidence: `no breakpoint stop (${stop.state})` }
    }
    const verified = session.breakpoints.get('/tmp/probe.py')?.[0]?.verified === true
    const stack = await session.request('stackTrace', { threadId: 1 })
    const topFrame = (stack.stackFrames as Array<{ name?: string }>)[0]?.name
    const evald = await session.request('evaluate', { expression: 'x+1', frameId: 1000 })
    session.lastStopped = null
    await session.request('continue', { threadId: 1 })
    const end = await session.waitForStopOutcome(6_000, signal)
    await dap.removeDapSession(owner, 'health-probe')
    if (!verified || topFrame !== 'main' || evald.result !== '42' || end.state !== 'terminated') {
      return {
        status: 'fail',
        evidence: `loop incomplete: verified=${verified} frame=${topFrame} eval=${String(evald.result)} end=${end.state}`,
      }
    }
    if (dap.getDapSession(owner, 'health-probe') !== undefined) {
      return { status: 'fail', evidence: 'registry entry survived disposal' }
    }
    return {
      status: 'ok',
      evidence: 'functional: launch → verified breakpoint → stop → stack → evaluate(42) → continue → terminated → dispose (built-in deterministic adapter; registry clean)',
    }
  } finally {
    await lifecycle.disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

export async function probePythonDebugger(signal?: AbortSignal): Promise<CheckResult> {
  const { projectPythonDebugAdapter } = await import('../../integrations/ide/pythonProject.js')
  const resolution = projectPythonDebugAdapter()
  if (resolution.state === 'unavailable') {
    return {
      status: 'warn',
      evidence: `unavailable: ${resolution.reason.slice(0, 180)}`,
      fix: resolution.remedy,
    }
  }
  const prov = resolution.provenance
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const dap = await import('../../integrations/debugger/dapClient.js')
  const lifecycle = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'pydbg')
  const dir = mkdtempSync(join(tmpdir(), 'health-pydbg-'))
  const program = join(dir, 'probe.py')
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      program,
      'def compute(a, b):\n    total = a * 10 + b\n    return total\n\nx = compute(4, 2)\nprint("result:", x)\n',
    )
    const session = await dap.createDapSession({
      owner,
      id: 'health-pydbg',
      adapterKey: 'python',
      program,
      cwd: dir,
      breakpoints: new Map([[program, [2]]]),
    })
    const stop = await session.waitForStopOutcome(15_000, signal)
    if (stop.state !== 'stopped' || stop.info.reason !== 'breakpoint') {
      return { status: 'fail', evidence: `no breakpoint stop (${stop.state}) — ${prov.lastProbe.slice(0, 120)}` }
    }
    const verified = session.breakpoints.get(program)?.[0]?.verified === true
    const threadId = stop.info.threadId ?? 1
    const stack = await session.request('stackTrace', { threadId, startFrame: 0, levels: 3 })
    const frames = stack.stackFrames as Array<{ id?: number; name?: string }>
    const frameId = frames[0]?.id
    const topFrame = frames[0]?.name ?? '?'
    let sawLocal = false
    if (frameId !== undefined) {
      const scopes = await session.request('scopes', { frameId })
      const localRef = (scopes.scopes as Array<{ name?: string; variablesReference?: number }>).find(s =>
        /local/i.test(s.name ?? ''),
      )?.variablesReference
      if (typeof localRef === 'number') {
        const vars = await session.request('variables', { variablesReference: localRef })
        sawLocal = (vars.variables as Array<{ name?: string; value?: string }>).some(
          v => v.name === 'a' && v.value === '4',
        )
      }
    }
    const evald = await session.request('evaluate', {
      expression: 'a * 10 + b',
      ...(frameId !== undefined ? { frameId } : {}),
      context: 'repl',
    })
    session.lastStopped = null
    await session.request('continue', { threadId })
    const end = await session.waitForStopOutcome(15_000, signal)
    await dap.removeDapSession(owner, 'health-pydbg')
    if (!verified || !topFrame.includes('compute') || !sawLocal || evald.result !== '42' || end.state !== 'terminated') {
      return {
        status: 'fail',
        evidence: `loop incomplete: verified=${verified} frame=${topFrame} local-a=${sawLocal} eval=${String(evald.result)} end=${end.state}`,
      }
    }
    return {
      status: 'ok',
      evidence:
        `functional: ${prov.adapterSource === 'bundled' ? 'BUNDLED' : 'environment'} debugpy ${prov.debugpyVersion ?? '?'} via ` +
        `${prov.interpreter ?? '?'}${prov.interpreterVersion ? ` ${prov.interpreterVersion}` : ''} — ` +
        'launch → verified breakpoint → stop → locals(a=4) → evaluate(42) → continue → terminated → dispose',
    }
  } finally {
    await lifecycle.disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

export async function probeJsDebugBoot(signal?: AbortSignal): Promise<CheckResult> {
  const { resolveJsDebugServer, jsDebugSourceLabel } = await import('../../integrations/debugger/dapClient.js')
  const resolved = resolveJsDebugServer()
  if (resolved === null) {
    return { status: 'off', evidence: 'no js-debug server resolved (no pin, no vendored bundle, no ~/.js-debug)' }
  }
  const { spawn } = await import('node:child_process')
  const net = await import('node:net')
  const port = 41000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [resolved.path, String(port), '127.0.0.1'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let outputTail = ''
  const keepTail = (chunk: unknown): void => {
    outputTail = (outputTail + String(chunk)).slice(-300)
  }
  child.stdout.on('data', keepTail)
  child.stderr.on('data', keepTail)
  try {
    return await pollUntil<CheckResult, CheckResult, CheckResult>(
      async () => {
        if (child.exitCode !== null) {
          return {
            status: 'fail',
            evidence: `the resolved js-debug server exited ${child.exitCode} before listening — ${outputTail.trim().slice(-180) || 'no output'} (${resolved.path})`,
          }
        }
        const accepted = await new Promise<boolean>(resolve => {
          const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.destroy()
            resolve(true)
          })
          socket.on('error', () => resolve(false))
        })
        if (accepted) {
          return {
            status: 'ok',
            evidence: `functional: the resolved js-debug server booted and listened on 127.0.0.1:${port} (via ${jsDebugSourceLabel(resolved.source)})`,
          }
        }
        return undefined
      },
      150,
      8_000,
      () => ({
        status: 'fail',
        evidence: `the resolved js-debug server never listened on 127.0.0.1:${port} within 8s — ${outputTail.trim().slice(-180) || 'no output'}`,
      }),
      { signal, onAbort: () => ({ status: 'unknown', evidence: 'health run cancelled' }) },
    )
  } finally {
    child.kill()
  }
}

export async function probeEffectObserver(): Promise<CheckResult> {
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const v = await import('../verification/verificationState.js')
  const { observeToolTerminal } = await import('../../engine/run-owner/effectObserver.js')
  const lifecycle = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'effects')
  const dir = mkdtempSync(join(tmpdir(), 'health-effect-'))
  try {
    const summarize = () => v.verificationSummary(dir, { skipDigest: true, owner }).mutationsSinceEvidence
    const emit = (outcome: 'succeeded' | 'failed' | 'no-change' | 'indeterminate', paths: string[]) =>
      observeToolTerminal({
        owner,
        toolName: 'LspRename',
        toolUseId: `probe-${outcome}`,
        input: {},
        ok: outcome !== 'failed',
        durationMs: 1,
        effect: {
          outcome,
          operation: 'lsp.probe.apply',
          changedPaths: paths,
          evidence: 'health probe',
          startedAt: 1,
          completedAt: 2,
        },
        cwd: dir,
      })
    emit('failed', [])
    if (summarize() !== 0) return { status: 'fail', evidence: 'a FAILED effect marked a mutation' }
    emit('no-change', [])
    if (summarize() !== 0) return { status: 'fail', evidence: 'a no-change effect marked a mutation' }
    emit('indeterminate', ['/tmp/x'])
    if (summarize() !== 0) return { status: 'fail', evidence: 'an INDETERMINATE effect marked a mutation' }
    emit('succeeded', ['/tmp/x'])
    if (summarize() !== 1) return { status: 'fail', evidence: 'a succeeded effect did not mark exactly one mutation' }
    return {
      status: 'ok',
      evidence: 'functional: failed/no-change/indeterminate → no mutation; succeeded+paths → exactly one (fixture owner)',
    }
  } finally {
    await lifecycle.disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

export async function probeDurableTransaction(): Promise<CheckResult> {
  const { runJournaledOperation, recoverJournalDir, listJournalOperations } = await import(
    '../substrate/operationJournal.js'
  )
  const { durableAtomicPublish, DurablePublishError } = await import(
    '../substrate/durablePublish.js'
  )
  const { readFileSync, writeFileSync, existsSync, readdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'health-txn-probe-'))
  const journal = join(dir, 'journal')
  const priorFaultSpec = flagEnv('MERCURY_FAULT_INJECT')
  try {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    const outcome = await runJournaledOperation<{ done: boolean }>({
      journalDir: journal,
      ownerKey: 'health-probe',
      kind: 'probe-op',
      idempotencyKey: 'probe:txn',
      steps: [
        { id: 's1', target: a, run: async () => void (await durableAtomicPublish(a, '{"s":1}')) },
        { id: 's2', target: b, run: async () => void (await durableAtomicPublish(b, '{"s":2}')) },
      ],
      result: () => ({ done: true }),
    })
    if (outcome.outcome !== 'committed' || !existsSync(a) || !existsSync(b)) {
      return { status: 'fail', evidence: `journaled commit broke (${outcome.outcome})` }
    }
    const replay = await runJournaledOperation<{ done: boolean }>({
      journalDir: journal,
      ownerKey: 'health-probe',
      kind: 'probe-op',
      idempotencyKey: 'probe:txn',
      steps: [
        {
          id: 's1',
          target: a,
          run: async () => {
            throw new Error('replay must not re-run steps')
          },
        },
      ],
    })
    if (replay.outcome !== 'replayed') {
      return { status: 'fail', evidence: `idempotent replay broke (${replay.outcome})` }
    }
    const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 10_000 }).pid ?? 999999
    const orphan = join(dir, 'orphan.json')
    await durableAtomicPublish(orphan, '{"half":true}')
    writeFileSync(
      join(journal, 'op-health-dead.json'),
      JSON.stringify({
        schema: 1,
        operationId: 'health-dead',
        ownerKey: 'health-probe',
        kind: 'probe-dead',
        idempotencyKey: 'probe:dead',
        state: 'applying',
        steps: [{ id: 's1', target: orphan, state: 'applied' }, { id: 's2', target: b, state: 'pending' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        writerPid: deadPid,
      }),
      'utf8',
    )
    let compensated = false
    const rec = await recoverJournalDir(journal, {
      'probe-dead': {
        compensate: async () => {
          compensated = true
          const { unlink } = await import('node:fs/promises')
          await unlink(orphan).catch(passedOver)
        },
      },
    })
    const deadOp = (await listJournalOperations(journal)).find(o => o.operationId === 'health-dead')
    if (!compensated || rec.compensated.length !== 1 || deadOp?.state !== 'aborted' || existsSync(orphan)) {
      return {
        status: 'fail',
        evidence: `died-writer recovery broke (compensated=${compensated}, state=${deadOp?.state}, orphanGone=${!existsSync(orphan)})`,
      }
    }
    setFlagEnv('MERCURY_FAULT_INJECT', 'flush-file@health-txn-probe:throw')
    let typedFailure = false
    try {
      await durableAtomicPublish(a, '{"s":"MUST NOT LAND"}')
    } catch (e) {
      typedFailure = e instanceof DurablePublishError && e.phase === 'flush-file'
    } finally {
      if (priorFaultSpec === undefined) deleteFlagEnv('MERCURY_FAULT_INJECT')
      else setFlagEnv('MERCURY_FAULT_INJECT', priorFaultSpec)
    }
    const survived = readFileSync(a, 'utf8') === '{"s":1}'
    const debris = readdirSync(dir).filter(n => n.endsWith('.tmp')).length
    if (!typedFailure || !survived || debris > 0) {
      return {
        status: 'fail',
        evidence: `fault-injected publish broke (typed=${typedFailure}, destinationIntact=${survived}, tempDebris=${debris})`,
      }
    }
    return {
      status: 'ok',
      evidence:
        'functional: journaled commit → idempotent replay → died-writer compensation → fault-injected publish left the committed bytes intact (disposable journal, cleaned up)',
    }
  } finally {
    if (priorFaultSpec === undefined) deleteFlagEnv('MERCURY_FAULT_INJECT')
    else setFlagEnv('MERCURY_FAULT_INJECT', priorFaultSpec)
    sweepProbeDir(dir)
  }
}

export async function probeLspLiveLane(): Promise<CheckResult> {
  const { getLspServerManager, getInitializationStatus } = await import(
    '../../integrations/lsp/serverManagerLifecycle.js'
  )
  const init = getInitializationStatus()
  const manager = getLspServerManager()
  if (init.status !== 'success' || !manager) {
    return {
      status: 'info',
      evidence: `live lane not exercised — manager ${init.status} in this process (deep functional coverage: the deterministic engine probe above; live coverage: run /health deep inside an interactive session with a language server)`,
    }
  }
  const servers = [...manager.getAllServers().values()].filter(s => s.state === 'running')
  if (servers.length === 0) {
    return {
      status: 'info',
      evidence: 'live lane not exercised — no language server RUNNING right now (servers start lazily on first file use)',
    }
  }
  const server = servers[0]!
  return {
    status: 'ok',
    evidence: `live lane running: ${server.name} generation ${server.generation} — real operations flow through this process (typed effects since slice 4)`,
  }
}


export async function probeChangeTransaction(): Promise<CheckResult> {
  const { changeTransactionEnabled } = await import(
    '../../tools/engines/change-transaction/contracts.js'
  )
  if (!changeTransactionEnabled()) {
    return { status: 'off', evidence: `change transactions disabled (MERCURY_CHANGE_RECEIPTS=${flagEnv('MERCURY_CHANGE_RECEIPTS')?.trim() || '0'})` }
  }
  const { mintFileAnchor, checkAnchor } = await import(
    '../../tools/engines/change-transaction/snapshotAnchor.js'
  )
  const { observeToolTerminal } = await import('../../engine/run-owner/effectObserver.js')
  const { receiptsFor } = await import('../../tools/engines/change-transaction/receipts.js')
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'health-vanguard-anchor-'))
  const owner = fixtureOwnerKey(ownerMod, 'anchor')
  try {
    const file = join(dir, 'probe.ts')
    writeFileSync(file, 'const a = 1\n')
    const anchor = mintFileAnchor('const a = 1\n')
    writeFileSync(file, 'const a = 2\n')
    const stale = checkAnchor(anchor, 'const a = 2\n', file)
    if (stale.ok || stale.reason !== 'stale' || !stale.currentAnchor) {
      return { status: 'fail', evidence: 'a concurrent change did not produce the typed stale result' }
    }
    const fresh = checkAnchor(stale.currentAnchor, 'const a = 2\n', file)
    if (!fresh.ok) {
      return { status: 'fail', evidence: 'the reread anchor did not verify against current content' }
    }
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'health-anchor',
      input: { file_path: file },
      ok: true,
      durationMs: 1,
      cwd: dir,
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: [file],
        evidence: 'health probe edit',
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    })
    const receipts = receiptsFor(owner)
    if (receipts.length !== 1 || receipts[0]!.effect.changedPaths[0] !== file) {
      return { status: 'fail', evidence: `the effect seam minted ${receipts.length} receipt(s), wanted 1 with the exact path` }
    }
    return {
      status: 'ok',
      evidence: 'anchor stale→reread→verify round trip + exactly-one receipt at the observer seam',
    }
  } finally {
    await disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

export async function probeServiceLifecycle(): Promise<CheckResult> {
  const { servicesEnabled } = await import('../../tools/engines/project-services/contracts.js')
  if (!servicesEnabled()) {
    return { status: 'off', evidence: `project services disabled (MERCURY_SERVICES=${flagEnv('MERCURY_SERVICES')?.trim() || '0'})` }
  }
  const { startService, waitForReady, readLogs, stopService } = await import(
    '../../tools/engines/project-services/serviceManager.js'
  )
  const dir = mkdtempSync(join(tmpdir(), 'health-vanguard-svc-'))
  let running = false
  let startedPid: number | null | undefined
  try {
    const started = await startService({
      sessionId: 'health-probe',
      spec: {
        name: 'health-probe',
        command: process.execPath,
        args: ['-e', "console.log('health service up'); setInterval(() => {}, 1000)"],
        cwd: dir,
        readiness: [
          { kind: 'log', regex: 'health service up' },
          { kind: 'stable', ms: 200 },
        ],
        readinessMode: 'all',
        restart: 'never',
        lifecycle: 'session',
      },
    })
    if ('error' in started) return { status: 'fail', evidence: `start failed: ${started.error}` }
    running = true
    startedPid = started.record.pid
    const wait = await waitForReady(dir, 'health-probe', 10_000)
    if (!wait.ready) {
      return { status: 'fail', evidence: `readiness never met: ${wait.statuses.filter(s => !s.met).map(s => s.detail).join('; ')}` }
    }
    const logs = await readLogs(dir, 'health-probe', {})
    const sawLog = !('error' in logs) && logs.lines.some(l => l.includes('health service up'))
    const stopped = await stopService(dir, 'health-probe')
    running = false
    if ('error' in stopped || stopped.record.state !== 'stopped') {
      return { status: 'fail', evidence: 'stop did not settle as stopped' }
    }
    if (!sawLog) return { status: 'fail', evidence: 'the cursored log read missed the boot line' }
    return { status: 'ok', evidence: 'start → log+stable readiness → cursored logs → explicit stop, all observed' }
  } finally {
    if (running) {
      let stoppedOk = false
      try {
        const stopped = await stopService(dir, 'health-probe')
        stoppedOk = !('error' in stopped)
      } catch (error) {
        logForDebugging(`deep probe: stopService failed in probeServiceLifecycle cleanup: ${String(error)}`)
      }
      if (!stoppedOk && typeof startedPid === 'number' && startedPid > 1) {
        try {
          await endProcessTree(startedPid, 'SIGKILL')
        } catch (error) {
          logForDebugging(`deep probe: fallback endProcessTree for pid ${startedPid} failed: ${String(error)}`)
        }
      }
    }
    sweepProbeDir(dir)
  }
}

export async function probeAgentEnvelope(): Promise<CheckResult> {
  const { buildAgentResultEnvelope } = await import('../../crew/agent-results/normalize.js')
  const { observeToolTerminal } = await import('../../engine/run-owner/effectObserver.js')
  const { processOwnerForLane } = await import('../../engine/run-owner/resolveOwner.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const agentId = `health-envelope-${process.pid}`
  const owner = processOwnerForLane(agentId)
  try {
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'health-envelope',
      input: { file_path: '/tmp/health-envelope.ts' },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/health-envelope.ts'],
        evidence: 'health envelope fixture',
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    })
    const envelope = await buildAgentResultEnvelope({
      agentId,
      status: 'completed',
      finalText:
        'done. I also touched /tmp/prose-claim.ts\n<mercury-envelope>{"summary":"probe summary","checks":["never-ran"]}</mercury-envelope>',
    })
    const ok =
      envelope.summary === 'probe summary' &&
      envelope.changedPaths.length === 1 &&
      envelope.changedPaths[0] === '/tmp/health-envelope.ts' &&
      envelope.checks.some(c => c.name === 'never-ran' && c.state === 'unknown')
    if (!ok) {
      return { status: 'fail', evidence: `envelope drifted: ${JSON.stringify({ s: envelope.summary, c: envelope.changedPaths, k: envelope.checks })}` }
    }
    return {
      status: 'ok',
      evidence: 'declared summary honored, observed path from the receipt ring, unverified check read unknown',
    }
  } finally {
    await disposeOwner(owner)
  }
}

export async function probeAxiomPrimitives(): Promise<CheckResult> {
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const P = await import('../../engine/runtime-kernel/index.js')
  const { observeToolTerminal } = await import('../../engine/run-owner/effectObserver.js')
  const { resolveResource } = await import('../../integrations/resources/registry.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'axiom')
  try {
    P.registerExecution({ owner, id: 'probe-exec', kind: 'process', label: 'probe', lifecycle: 'owner' })
    P.transitionExecution(owner, 'probe-exec', 'starting')
    P.transitionExecution(owner, 'probe-exec', 'running')
    P.settleExecution(owner, 'probe-exec', 'succeeded', { outcome: { code: 0 } })
    const exec = P.getExecution(owner, 'probe-exec')
    if (exec?.state !== 'succeeded' || exec.generation !== 1) {
      return { status: 'fail', evidence: `execution lifecycle broke: ${exec?.state}` }
    }
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'axiom-probe',
      input: { file_path: '/tmp/health-axiom.ts' },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/health-axiom.ts'],
        evidence: 'health probe',
        startedAt: 1,
        completedAt: 2,
      },
    })
    const txns = P.transactionsFor(owner)
    if (txns.length !== 1 || txns[0]!.state !== 'settled' || !txns[0]!.effectRef) {
      return { status: 'fail', evidence: `receipt→transaction broke: ${txns[0]?.state}` }
    }
    const evidence = P.evidenceFor(owner)
    const change = evidence.find(r => r.kind === 'change' && r.origin === 'observed')
    const settle = evidence.find(r => r.kind === 'execution')
    if (!change || !settle) {
      return { status: 'fail', evidence: `evidence spine missing rows (${evidence.length} total)` }
    }
    const res = await resolveResource('mercury://owner', { owner, cwd: '/tmp' })
    if (res.state !== 'ok' || !res.resource.children?.some(c => c.ref === 'mercury://execution/probe-exec')) {
      return { status: 'fail', evidence: `owner→execution traversal broke (${res.state})` }
    }
    const state = P.newAnthropicProjectionState()
    const events = [
      { type: 'message_start', message: { model: 'fixture' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ].flatMap(e => P.projectAnthropicStreamEvent(e, state))
    if (events.map(e => e.type).join(',') !== 'response.started,text.delta,response.completed') {
      return { status: 'fail', evidence: `canonical stream fixture drifted: ${events.map(e => e.type).join(',')}` }
    }
    await disposeOwner(owner)
    if (P.listExecutions(owner).length !== 0 || P.transactionsFor(owner).length !== 0 || P.evidenceFor(owner).length !== 0) {
      return { status: 'fail', evidence: 'owner disposal left primitive records behind' }
    }
    return {
      status: 'ok',
      evidence:
        'execution lifecycle · receipt→transaction→evidence · owner→execution traversal · canonical stream fixture · clean disposal',
    }
  } finally {
    await disposeOwner(owner)
  }
}

export async function probeStructureLoop(): Promise<CheckResult> {
  const { structureEnabled } = await import('../../tools/engines/structure/contracts.js')
  if (!structureEnabled()) {
    return { status: 'off', evidence: 'MERCURY_STRUCTURE=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const { runStructureQuery } = await import('../../tools/engines/structure/query.js')
  const { buildPreview, applyPreview } = await import('../../tools/engines/structure/transform.js')
  const { resolveStructureTypescript } = await import('../../tools/engines/structure/tsFacility.js')

  const owner = fixtureOwnerKey(ownerMod, 'structure')
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'health-structure-'))
  try {
    const resolution = resolveStructureTypescript(root)
    if (resolution.state === 'unavailable') {
      return { status: 'fail', evidence: resolution.note }
    }
    fs.writeFileSync(
      pathMod.join(root, 'app.ts'),
      "import { log } from './logger'\nexport function greet(name: string): void {\n  log('hello', name)\n}\n",
    )
    fs.writeFileSync(
      pathMod.join(root, 'cli.tsx'),
      "import { log } from './logger'\nexport const Cli = () => <button onClick={() => log('click', 'cli')}>go</button>\n",
    )
    const query = runStructureQuery(root, { select: 'call', callee: 'log' })
    if ('state' in query) return { status: 'fail', evidence: query.note }
    if (query.matches.length !== 2) {
      return { status: 'fail', evidence: `expected 2 matches, got ${query.matches.length}` }
    }
    const before = fs.readFileSync(pathMod.join(root, 'app.ts'), 'utf8')
    const preview = buildPreview(owner, query, undefined, {
      action: 'replace-callee',
      to: 'audit.log',
    })
    if ('reason' in preview) return { status: 'fail', evidence: `preview refused: ${preview.reason}` }
    if (fs.readFileSync(pathMod.join(root, 'app.ts'), 'utf8') !== before) {
      return { status: 'fail', evidence: 'preview WROTE — the write-nothing law broke' }
    }
    const applied = await applyPreview(owner, preview.id)
    if (applied.state !== 'applied') {
      return { status: 'fail', evidence: `apply refused: ${JSON.stringify(applied)}` }
    }
    if (!fs.readFileSync(pathMod.join(root, 'app.ts'), 'utf8').includes("audit.log('hello', name)")) {
      return { status: 'fail', evidence: 'transformation did not land' }
    }
    if (!applied.diagnostics.every(d => d.ok)) {
      return { status: 'fail', evidence: 'post-apply parse diagnostics not clean' }
    }
    if (applied.evidenceRefs.length < 2) {
      return { status: 'fail', evidence: 'canonical change+check evidence missing' }
    }
    const query2 = runStructureQuery(root, { select: 'call', callee: 'audit.log' })
    if ('state' in query2) return { status: 'fail', evidence: query2.note }
    const preview2 = buildPreview(owner, query2, undefined, { action: 'remove' })
    if ('reason' in preview2) return { status: 'fail', evidence: preview2.reason }
    fs.appendFileSync(pathMod.join(root, 'app.ts'), '// drift\n')
    const stale = await applyPreview(owner, preview2.id)
    if (stale.state !== 'refused' || stale.code !== 'stale') {
      return { status: 'fail', evidence: 'stale preview was NOT refused' }
    }
    return {
      status: 'ok',
      evidence: `query(2 langs) → preview(write-nothing) → apply(re-read verified, diagnostics clean, evidence ×${applied.evidenceRefs.length}) → stale refusal; facility: ${resolution.source}`,
    }
  } finally {
    await disposeOwner(owner)
    sweepProbeDir(root)
  }
}

export async function probeGitGraph(): Promise<CheckResult> {
  const { gitGraphEnabled } = await import('../git-graph/contracts.js')
  if (!gitGraphEnabled()) {
    return { status: 'off', evidence: 'MERCURY_GIT_GRAPH=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const { gitStatus, gitDiff, isGitRepo } = await import('../git-graph/observe.js')
  const { preparePlan, applyPlan } = await import('../git-graph/plan.js')
  const { transactionById } = await import('../../engine/runtime-kernel/transactionPlane.js')

  const owner = fixtureOwnerKey(ownerMod, 'gitgraph')
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'health-git-'))
  const sh = (args: string[]): string =>
    execFileSync('git', gitArgs(args, root), {
      windowsHide: true,
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...subprocessEnv(),
        GIT_AUTHOR_NAME: 'health',
        GIT_AUTHOR_EMAIL: 'health@local',
        GIT_COMMITTER_NAME: 'health',
        GIT_COMMITTER_EMAIL: 'health@local',
      },
    })
  try {
    sh(['init', '--quiet', '--initial-branch=main'])
    if (!isGitRepo(root)) return { status: 'fail', evidence: 'fixture repo did not initialize' }
    fs.writeFileSync(pathMod.join(root, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(pathMod.join(root, 'b.md'), '# b\n')
    sh(['add', '.'])
    sh(['commit', '--quiet', '-m', 'seed'])
    fs.appendFileSync(pathMod.join(root, 'a.ts'), 'export const a2 = 2\n')
    fs.appendFileSync(pathMod.join(root, 'b.md'), 'more\n')

    const status = gitStatus(root)
    if ('state' in status || status.files.length !== 2) {
      return { status: 'fail', evidence: `status typing broke: ${JSON.stringify(status).slice(0, 120)}` }
    }
    const diff = gitDiff(root, { scope: 'worktree' })
    if ('state' in diff || diff.hunks.length < 2) {
      return { status: 'fail', evidence: 'worktree diff/hunks broke' }
    }
    const plan = preparePlan(owner, root, [
      { files: ['a.ts'], message: 'feat: a2' },
      { files: ['b.md'], message: 'docs: more' },
    ])
    if ('reason' in plan) return { status: 'fail', evidence: `prepare refused: ${plan.reason}` }
    const applied = applyPlan(owner, plan.id)
    if (applied.state !== 'applied' || applied.commits.length !== 2) {
      return { status: 'fail', evidence: `apply broke: ${JSON.stringify(applied).slice(0, 160)}` }
    }
    for (const c of applied.commits) {
      const txn = transactionById(owner, c.transactionId)
      if (txn?.state !== 'settled' || !txn.effectRef) {
        return { status: 'fail', evidence: `per-commit transaction not settled with observed effect (${c.transactionId})` }
      }
    }
    fs.appendFileSync(pathMod.join(root, 'a.ts'), 'export const a3 = 3\n')
    const plan2 = preparePlan(owner, root, [{ files: ['a.ts'], message: 'feat: a3' }])
    if ('reason' in plan2) return { status: 'fail', evidence: plan2.reason }
    fs.appendFileSync(pathMod.join(root, 'a.ts'), '// drift\n')
    const stale = applyPlan(owner, plan2.id)
    if (stale.state !== 'refused' || stale.code !== 'stale') {
      return { status: 'fail', evidence: 'stale plan was NOT refused' }
    }
    return {
      status: 'ok',
      evidence:
        'status(digest) → diff(hunks) → 2-group plan → 2 verified commits (settled transactions) → stale refusal, on a disposable repo',
    }
  } finally {
    await disposeOwner(owner)
    sweepProbeDir(root)
  }
}

export async function probeJourneyLoop(): Promise<CheckResult> {
  const { journeysEnabled } = await import('../../tools/engines/journeys/contracts.js')
  if (!journeysEnabled()) {
    return { status: 'off', evidence: 'MERCURY_JOURNEYS=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const ownerMod = await import('../../engine/run-owner/ownerKey.js')
  const { disposeOwner } = await import('../../engine/run-owner/ownerLifecycle.js')
  const { runJourney } = await import('../../tools/engines/journeys/runner.js')
  const { getExecution } = await import('../../engine/execution-plane/executionPlane.js')

  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'health-journey-'))
  const owner = fixtureOwnerKey(ownerMod, pathMod.basename(root))
  const portFile = pathMod.join(root, 'port')
  let boundPort: number | undefined
  const fixtureUrl = (): string => {
    if (boundPort === undefined && fs.existsSync(portFile)) {
      const parsed = Number(fs.readFileSync(portFile, 'utf8').trim())
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
        boundPort = parsed
      }
    }
    return `http://127.0.0.1:${boundPort ?? 0}/health`
  }
  fs.writeFileSync(
    pathMod.join(root, 'server.mjs'),
    `import { createServer } from 'node:http'
import { renameSync, writeFileSync } from 'node:fs'
const server = createServer((req, res) => { console.log('hit ' + req.url); res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})) })
server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  writeFileSync('port.tmp', String(port))
  renameSync('port.tmp', 'port')
  console.log('HEALTH FIXTURE READY')
})
`,
  )
  try {
    const good = await runJourney(
      {
        objective: 'health: verify the loopback fixture end to end',
        steps: [
          {
            kind: 'service.start',
            name: 'health-journey-fixture',
            command: process.execPath,
            args: ['server.mjs'],
            readiness: [{ kind: 'log', regex: 'HEALTH FIXTURE READY' }],
          },
          { kind: 'service.wait', name: 'health-journey-fixture' },
          {
            kind: 'http.request',
            get url() {
              return fixtureUrl()
            },
            expect: { status: 200, bodyIncludes: '"ok":true' },
          },
          { kind: 'log.match', service: 'health-journey-fixture', pattern: 'hit /health' },
          { kind: 'service.stop', name: 'health-journey-fixture' },
        ],
      },
      { owner, root },
    )
    if (good.state !== 'succeeded') {
      return {
        status: 'fail',
        evidence: `journey did not succeed: ${good.state} — ${good.steps.find(s => s.state === 'failed')?.detail ?? ''}`.slice(0, 200),
      }
    }
    if (getExecution(owner, good.id)?.state !== 'succeeded') {
      return { status: 'fail', evidence: 'journey execution record did not settle succeeded' }
    }
    const bad = await runJourney(
      {
        objective: 'health: a wrong expectation fails honestly',
        steps: [
          { kind: 'command.run', command: process.execPath, args: ['-e', 'process.exit(3)'] },
          { kind: 'file.inspect', path: 'never-reached.txt', label: 'skipped-step' },
        ],
      },
      { owner, root },
    )
    if (bad.state !== 'failed' || bad.failedStep !== 0 || bad.steps[1]?.state !== 'skipped') {
      return { status: 'fail', evidence: `honest-failure leg broke: ${bad.state} step1=${bad.steps[1]?.state}` }
    }
    if (!bad.steps[0]!.detail.includes('3')) {
      return { status: 'fail', evidence: 'the failure detail did not NAME the exit-code mismatch' }
    }
    return {
      status: 'ok',
      evidence:
        `service→readiness→http→log→stop all passed (${good.steps.length} steps, evidence ×${good.evidenceRefs.length}, cleanup ${good.cleanup.length === 0 ? 'explicit-stop' : 'recorded'}) · failure leg honest (exit 3 named, later steps skipped)`,
    }
  } finally {
    await disposeOwner(owner)
    sweepProbeDir(root)
  }
}
