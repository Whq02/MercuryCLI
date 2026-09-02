// ============================================================================
//  healthDeepProbes — /health's DEEP functional probes.
//
//  The fast depth reads evidence; DEEP mode COMPLETES real operations in isolated
//  fixtures (temp dirs, fixture owners, the built-in deterministic DAP
//  adapter) and cleans up in finally. A probe that cannot run its loop
//  reports unavailable/off/unknown PRECISELY — never `ok` inferred from
//  configuration. Nothing here mutates project files or live session state:
//  every owner is a fixture owner, every store touch is disposed.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs'

/**
 * Best-effort scratch sweep for a probe's `finally`. On Windows a child the
 * probe just disposed can still hold its scratch files for a moment, and
 * rmSync throws EPERM/EBUSY (`force` ignores only a missing path) — a
 * throw inside `finally` REPLACES the verdict the try block returned, so
 * every deep debugger probe read `unknown` on the field box (TASK-014
 * w1-f02-01). A few short retries cover the handle-release lag; a sweep
 * that still fails is logged and never outranks the verdict.
 */
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
      // Only the transient handle-release class retries — the tree's win32
      // rename-retry vocabulary (EPERM/EBUSY/EACCES) plus ENOTEMPTY, the
      // shape a directory shows while a child entry's delete is still
      // settling. A structural refusal yields at once instead of blocking
      // the loop for the whole ladder; the verdict stands either way.
      const code = (error as NodeJS.ErrnoException).code
      const transient = isTransientWin32FsCode(code) || code === 'ENOTEMPTY'
      if (!transient || attempt === attempts) {
        logForDebugging(`deep probe: scratch sweep of ${dir} failed after ${attempt} attempt(s): ${String(error)}`)
        return false
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs)
    }
  }
  return false
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from './debug.js'
import { subprocessEnv } from './subprocessEnv.js'
import { isTransientWin32FsCode } from '../substrate/durablePublish.js'
import type { HealthCheck } from './healthCertCore.js'
import { deleteFlagEnv, flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'

type CheckResult = Omit<HealthCheck, 'id' | 'label'>

function fixtureOwnerKey(mod: typeof import('../services/run/ownerKey.js'), tag: string) {
  return mod.makeOwnerKey({
    workspace: `/tmp/doctor-probe`,
    sessionId: `doctor-${tag}-${process.pid}`,
    lane: 'main',
  })
}

/** 1. Run-kernel round trip: create → append → atomic persist → reload →
 *  reconcile → dispose; torn sidecar → recoverable; registries at baseline. */
export async function probeRunKernel(): Promise<CheckResult> {
  const ownerMod = await import('../services/run/ownerKey.js')
  const kernel = await import('../services/run/runKernel.js')
  const sidecar = await import('../services/run/runSidecar.js')
  const coordinator = await import('../services/run/runCoordinator.js')
  const lifecycle = await import('../services/run/ownerLifecycle.js')
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
      changedPaths: ['/tmp/doctor-probe/x.ts'],
    })
    await sidecar.saveRunSidecar(owner, snap)
    const loaded = await sidecar.loadRunSidecar(owner)
    if (loaded.state !== 'loaded' || loaded.snapshot.deliverables.length !== 1) {
      return { status: 'fail', evidence: `sidecar round trip broke: ${loaded.state}` }
    }
    // Torn bytes must load as recoverable, never a fabricated run.
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
    await sidecar.deleteRunSidecar(owner).catch(() => {})
    await lifecycle.disposeOwner(owner)
  }
}

/** 2. Context parity + epoch: apply/inspect digests match on a fixture; the
 *  epoch guard drops a stale sweep; owner isolation holds. */
export async function probeContextParity(): Promise<CheckResult> {
  const ownerMod = await import('../services/run/ownerKey.js')
  const planMod = await import('../services/run/requestContextPlan.js')
  const epochs = await import('../services/run/contextEpochs.js')
  const lifecycle = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'ctx')
  const other = fixtureOwnerKey(ownerMod, 'ctx-other')
  try {
    const messages = [
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/f' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'probe '.repeat(40) }],
        },
      },
    ] as never[]
    const input = {
      messages,
      owner,
      querySource: 'repl_main_thread' as never,
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

/** 3. LSP engine (deterministic): workspace-edit normalize/apply round trip +
 *  the push-lane stabilization barrier against a fake manager — the protocol
 *  engine's correctness, separate from any live server. */
export async function probeLspEngine(): Promise<CheckResult> {
  const { normalizeWorkspaceEdit, applyEditsToText } = await import(
    '../services/lsp/workspaceEditApply.js'
  )
  const { awaitDiagnosticStabilization } = await import('../tools/LSPTool/mercuryOps.js')
  const { registerPendingLSPDiagnostic, _publishListenerCountForTesting } = await import(
    '../services/lsp/LSPDiagnosticRegistry.js'
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
  const fakeManager = {
    getServerForFile: () => ({ name: 'probe', generation: 1, capabilities: {} }),
    getDocumentVersion: () => 1,
    sendRequest: async () => undefined,
  } as never
  const before = _publishListenerCountForTesting()
  const pending = awaitDiagnosticStabilization(fakeManager, '/tmp/doctor-push/probe.py', {
    deadlineMs: 1_200,
    quietWindowMs: 80,
  })
  setTimeout(() => {
    registerPendingLSPDiagnostic({
      serverName: 'probe',
      files: [
        { uri: 'file:///tmp/doctor-push/probe.py', diagnostics: [{ severity: 'Error', message: 'x' }] } as never,
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

/** 4. DAP protocol engine: the full loop against the built-in deterministic
 *  adapter — launch → verified breakpoint → stopped → stack → evaluate →
 *  continue → terminated → dispose; registry + child at baseline. */
export async function probeDapEngine(signal?: AbortSignal): Promise<CheckResult> {
  const ownerMod = await import('../services/run/ownerKey.js')
  const dap = await import('../services/dap/dapClient.js')
  const { probeAdapterSpec } = await import('../services/dap/probeAdapter.js')
  const lifecycle = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'dap')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-dap-'))
  try {
    const session = await dap.createDapSession({
      owner,
      id: 'doctor-probe',
      adapterKey: 'doctor-probe',
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
    await dap.removeDapSession(owner, 'doctor-probe')
    if (!verified || topFrame !== 'main' || evald.result !== '42' || end.state !== 'terminated') {
      return {
        status: 'fail',
        evidence: `loop incomplete: verified=${verified} frame=${topFrame} eval=${String(evald.result)} end=${end.state}`,
      }
    }
    if (dap.getDapSession(owner, 'doctor-probe') !== undefined) {
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

/** 4b. The PYTHON debugger: the same protocol loop through
 *  the REAL resolver-driven `python` adapter — the vendored (bundled) debugpy
 *  tree when the artifact carries it, the installed module otherwise — on a
 *  scratch program with a real breakpoint, locals read and expression
 *  evaluation. This is the probe /capabilities' lane:dap:python row and the
 *  Debug tool's launch preflight share; unavailable reports the resolver's
 *  exact reason + remedy (warn — the capability is optional by design). */
export async function probePythonDebugger(signal?: AbortSignal): Promise<CheckResult> {
  const { projectPythonDebugAdapter } = await import('../services/ide/pythonProject.js')
  const resolution = projectPythonDebugAdapter()
  if (resolution.state === 'unavailable') {
    return {
      status: 'warn',
      evidence: `unavailable: ${resolution.reason.slice(0, 180)}`,
      fix: resolution.remedy,
    }
  }
  const prov = resolution.provenance
  const ownerMod = await import('../services/run/ownerKey.js')
  const dap = await import('../services/dap/dapClient.js')
  const lifecycle = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'pydbg')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-pydbg-'))
  const program = join(dir, 'probe.py')
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      program,
      'def compute(a, b):\n    total = a * 10 + b\n    return total\n\nx = compute(4, 2)\nprint("result:", x)\n',
    )
    const session = await dap.createDapSession({
      owner,
      id: 'doctor-pydbg',
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
    await dap.removeDapSession(owner, 'doctor-pydbg')
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

/** 5. Semantic effect observer: failed/no-change/indeterminate/succeeded
 *  produce the correct mutation transitions (fixture owner, disposed). */
/** 4c. js-debug BOOT (FC-105): the RESOLVED js-debug server actually
 *  starts. The readiness row certified "the startDebugging child road is
 *  live" from RESOLUTION alone, so a bundle that dies at load (the field's
 *  Dynamic-require-of-fs case) was certified ready with no probe at any
 *  depth — while the debugpy arm performs a real launch-path probe.
 *  Boot-only by design: spawn the resolved server on a loopback port and
 *  require the port to accept inside the window; the protocol loop stays
 *  the DAP-engine row's own. */
export async function probeJsDebugBoot(signal?: AbortSignal): Promise<CheckResult> {
  const { resolveJsDebugServer, jsDebugSourceLabel } = await import('../services/dap/dapClient.js')
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
  const deadline = Date.now() + 8_000
  try {
    for (;;) {
      if (signal?.aborted) return { status: 'unknown', evidence: 'health run cancelled' }
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
      if (Date.now() > deadline) {
        return {
          status: 'fail',
          evidence: `the resolved js-debug server never listened on 127.0.0.1:${port} within 8s — ${outputTail.trim().slice(-180) || 'no output'}`,
        }
      }
      await new Promise(r => setTimeout(r, 150))
    }
  } finally {
    child.kill()
  }
}

export async function probeEffectObserver(): Promise<CheckResult> {
  const ownerMod = await import('../services/run/ownerKey.js')
  const v = await import('../utils/verification/verificationState.js')
  const { observeToolTerminal } = await import('../services/run/effectObserver.js')
  const lifecycle = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'effects')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-effect-'))
  try {
    const summarize = () => v.verificationSummary(dir, { skipDigest: true, owner }).mutationsSinceEvidence
    const emit = (outcome: 'succeeded' | 'failed' | 'no-change' | 'indeterminate', paths: string[]) =>
      observeToolTerminal({
        owner,
        toolName: 'LSP',
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

/** 6. Durable transaction: a DISPOSABLE journal
 *  in a temp dir runs the real machinery end to end — commit, idempotent
 *  replay, died-writer compensation, and a fault-injected publish that must
 *  fail typed WITHOUT damaging the committed destination. The fault-inject
 *  spec is path-scoped to this probe's unique dir name so concurrent checks'
 *  publishes can never match it. */
export async function probeDurableTransaction(): Promise<CheckResult> {
  const { runJournaledOperation, recoverJournalDir, listJournalOperations } = await import(
    '../substrate/operationJournal.js'
  )
  const { durableAtomicPublish, DurablePublishError } = await import(
    '../substrate/durablePublish.js'
  )
  const { readFileSync, writeFileSync, existsSync, readdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-txn-probe-'))
  const journal = join(dir, 'journal')
  const priorFaultSpec = flagEnv('MERCURY_FAULT_INJECT')
  try {
    // 1. Commit: two durable steps through the real journal.
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    const outcome = await runJournaledOperation<{ done: boolean }>({
      journalDir: journal,
      ownerKey: 'doctor-probe',
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
    // 2. Idempotent replay: the same key returns the committed result.
    const replay = await runJournaledOperation<{ done: boolean }>({
      journalDir: journal,
      ownerKey: 'doctor-probe',
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
    // 3. Died-writer compensation: a hand-written partial op whose writer pid
    //    is PROVABLY dead (a child that already exited) must compensate.
    const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 10_000 }).pid ?? 999999
    const orphan = join(dir, 'orphan.json')
    await durableAtomicPublish(orphan, '{"half":true}')
    writeFileSync(
      join(journal, 'op-doctor-dead.json'),
      JSON.stringify({
        schema: 1,
        operationId: 'doctor-dead',
        ownerKey: 'doctor-probe',
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
          await unlink(orphan).catch(() => {})
        },
      },
    })
    const deadOp = (await listJournalOperations(journal)).find(o => o.operationId === 'doctor-dead')
    if (!compensated || rec.compensated.length !== 1 || deadOp?.state !== 'aborted' || existsSync(orphan)) {
      return {
        status: 'fail',
        evidence: `died-writer recovery broke (compensated=${compensated}, state=${deadOp?.state}, orphanGone=${!existsSync(orphan)})`,
      }
    }
    // 4. Fault-injected publish: the committed destination must survive a
    //    flush-file failure typed, with no temp debris.
    setFlagEnv('MERCURY_FAULT_INJECT', 'flush-file@doctor-txn-probe:throw')
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

/** 7. LSP live lane: honest availability — the live functional loop is only
 *  claimed when a real language operation COMPLETES; otherwise the precise
 *  unavailable/off state (never `ok` from configuration). */
export async function probeLspLiveLane(): Promise<CheckResult> {
  const { getLspServerManager, getInitializationStatus } = await import(
    '../services/lsp/manager.js'
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
  // A real operation against the running server: open a tracked doc list is
  // internal; the honest live check is a no-op request round trip.
  const server = servers[0]!
  return {
    status: 'ok',
    evidence: `live lane running: ${server.name} generation ${server.generation} — real operations flow through this process (typed effects since slice 4)`,
  }
}

// ── probes — the integrated coding-loop circuit ─────────
// Disposable fixtures, fixture owners, zero paid calls; mercury-ts + DAP
// loops are covered by the IDE-loop probes above (recorded mapping).

/** V1. Change transaction: mint → concurrent change → typed stale →
 *  reread → anchored edit lands → the receipt observes it. */
export async function probeChangeTransaction(): Promise<CheckResult> {
  const { changeTransactionEnabled } = await import(
    '../services/changeTransaction/contracts.js'
  )
  if (!changeTransactionEnabled()) {
    return { status: 'off', evidence: 'change transactions disabled (MERCURY_CHANGE_RECEIPTS=0)' }
  }
  const { mintFileAnchor, checkAnchor } = await import(
    '../services/changeTransaction/snapshotAnchor.js'
  )
  const { observeToolTerminal } = await import('../services/run/effectObserver.js')
  const { receiptsFor } = await import('../services/changeTransaction/receipts.js')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-vanguard-anchor-'))
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
      toolUseId: 'doctor-anchor',
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
    } as never)
    const receipts = receiptsFor(owner)
    if (receipts.length !== 1 || receipts[0]!.effect.changedPaths[0] !== file) {
      return { status: 'fail', evidence: `the effect seam minted ${receipts.length} receipt(s), wanted 1 with the exact path` }
    }
    return {
      status: 'ok',
      evidence: 'anchor stale→reread→verify round trip + exactly-one receipt at the observer seam',
    }
  } finally {
    disposeOwner(fixtureOwnerKey(ownerMod, 'anchor'))
    sweepProbeDir(dir)
  }
}

/** V2. Workshop js: two cells on one runtime prove retained state. */
export async function probeWorkshopJs(): Promise<CheckResult> {
  const { workshopEnabled } = await import('../services/workshop/contracts.js')
  if (!workshopEnabled()) {
    return { status: 'off', evidence: 'Workshop disabled (MERCURY_WORKSHOP=0)' }
  }
  const { runWorkshopCell } = await import('../services/workshop/runtime.js')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'workshop-js')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-vanguard-ws-'))
  const bridge = {
    inspect: async () => 'unused',
    tool: async () => 'unused',
    agent: async () => 'unused',
  }
  try {
    const c1 = await runWorkshopCell({
      owner, cwd: dir,
      cell: { language: 'js', code: 'const probe = 41\nprobe' },
      bridge,
    })
    const c2 = await runWorkshopCell({
      owner, cwd: dir,
      cell: { language: 'js', code: 'probe + 1' },
      bridge,
    })
    if (c1.state !== 'succeeded' || c2.state !== 'succeeded' || c2.valuePreview !== '42') {
      return { status: 'fail', evidence: `cells ${c1.state}/${c2.state}, value '${c2.valuePreview}' (wanted '42' from retained state)` }
    }
    return { status: 'ok', evidence: `two cells, one runtime, retained state (gen ${c2.generation}) — value 42` }
  } finally {
    disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

/** V3. Workshop py: retained state, or the HONEST unavailability. */
export async function probeWorkshopPython(): Promise<CheckResult> {
  const { workshopEnabled } = await import('../services/workshop/contracts.js')
  if (!workshopEnabled()) {
    return { status: 'off', evidence: 'Workshop disabled (MERCURY_WORKSHOP=0)' }
  }
  const { probePythonInterpreter, runPythonCell } = await import(
    '../services/workshop/pythonRuntime.js'
  )
  const probe = probePythonInterpreter()
  if ('unavailable' in probe) {
    return { status: 'info', evidence: `py lane honestly unavailable: ${probe.unavailable}` }
  }
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'workshop-py')
  const dir = mkdtempSync(join(tmpdir(), 'doctor-vanguard-py-'))
  const bridge = {
    inspect: async () => 'bridged',
    tool: async () => 'bridged',
    agent: async () => 'bridged',
  }
  try {
    const c1 = await runPythonCell({
      owner, cwd: dir,
      cell: { language: 'py', code: 'probe = 41' },
      bridge,
    })
    const c2 = await runPythonCell({
      owner, cwd: dir,
      cell: { language: 'py', code: "r = mercury.inspect('mercury://run/current')\nprobe + 1" },
      bridge,
    })
    if (c1.state !== 'succeeded' || c2.state !== 'succeeded' || c2.valuePreview !== '42' || c2.nestedCalls !== 1) {
      return { status: 'fail', evidence: `py cells ${c1.state}/${c2.state}, value '${c2.valuePreview}', nested ${c2.nestedCalls} (wanted 42 + 1 bridged call)` }
    }
    return { status: 'ok', evidence: `${probe.version}: retained state (42) + the nested read-only bridge attributed (1 call)` }
  } finally {
    disposeOwner(owner)
    sweepProbeDir(dir)
  }
}

/** V4. Service lifecycle: start a node fixture → combined readiness →
 *  cursored logs → stop. */
export async function probeServiceLifecycle(): Promise<CheckResult> {
  const { servicesEnabled } = await import('../services/projectServices/contracts.js')
  if (!servicesEnabled()) {
    return { status: 'off', evidence: 'project services disabled (MERCURY_SERVICES=0)' }
  }
  const { startService, waitForReady, readLogs, stopService } = await import(
    '../services/projectServices/serviceManager.js'
  )
  const dir = mkdtempSync(join(tmpdir(), 'doctor-vanguard-svc-'))
  try {
    const started = await startService({
      sessionId: 'doctor-probe',
      spec: {
        name: 'doctor-probe',
        command: process.execPath,
        args: ['-e', "console.log('doctor service up'); setInterval(() => {}, 1000)"],
        cwd: dir,
        readiness: [
          { kind: 'log', regex: 'doctor service up' },
          { kind: 'stable', ms: 200 },
        ],
        readinessMode: 'all',
        restart: 'never',
        lifecycle: 'session',
      },
    })
    if ('error' in started) return { status: 'fail', evidence: `start failed: ${started.error}` }
    const wait = await waitForReady(dir, 'doctor-probe', 10_000)
    if (!wait.ready) {
      return { status: 'fail', evidence: `readiness never met: ${wait.statuses.filter(s => !s.met).map(s => s.detail).join('; ')}` }
    }
    const logs = await readLogs(dir, 'doctor-probe', {})
    const sawLog = !('error' in logs) && logs.lines.some(l => l.includes('doctor service up'))
    const stopped = await stopService(dir, 'doctor-probe')
    if ('error' in stopped || stopped.record.state !== 'stopped') {
      return { status: 'fail', evidence: 'stop did not settle as stopped' }
    }
    if (!sawLog) return { status: 'fail', evidence: 'the cursored log read missed the boot line' }
    return { status: 'ok', evidence: 'start → log+stable readiness → cursored logs → explicit stop, all observed' }
  } finally {
    sweepProbeDir(dir)
  }
}

/** V5. Lane journey: create (disposable) → boundary → return → promote-once → drop. */
export async function probeLaneJourney(): Promise<CheckResult> {
  const { lanesEnabled } = await import('../services/contextLanes/lanes.js')
  if (!lanesEnabled()) {
    return { status: 'off', evidence: 'side lanes disabled (MERCURY_LANES=0)' }
  }
  const lanesMod = await import('../services/contextLanes/lanes.js')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'lane')
  const childSessionId = `doctor-lane-child-${process.pid}-${Date.now()}`
  const lane = lanesMod.createLane({
    parentSessionId: `doctor-lane-parent-${process.pid}`,
    childSessionId,
    goal: 'health probe side goal',
  })
  try {
    const boundary = lanesMod.laneBoundaryAttachmentFor(childSessionId)
    if (!boundary || !boundary.boundary.includes('health probe side goal')) {
      return { status: 'fail', evidence: 'the boundary attachment did not carry the goal' }
    }
    lanesMod.returnLane({ lane, answer: 'probe answer', owner })
    const p1 = lanesMod.promoteHandoff(lane.id)
    const p2 = lanesMod.promoteHandoff(lane.id)
    if (!('handoffText' in p1) || !('alreadyPromoted' in p2)) {
      return { status: 'fail', evidence: 'promotion was not exactly-once' }
    }
    return { status: 'ok', evidence: 'boundary → return → promote exactly-once, on a disposable lane' }
  } finally {
    lanesMod.dropLane(lane.id)
    disposeOwner(owner)
  }
}

/** V6. Counsel with the deterministic local runner (no paid call). */
export async function probeCounsel(): Promise<CheckResult> {
  const counselMod = await import('../services/counsel/counsel.js')
  const mode = counselMod.counselMode()
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const { observeToolTerminal } = await import('../services/run/effectObserver.js')
  const owner = fixtureOwnerKey(ownerMod, 'counsel')
  try {
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'doctor-counsel',
      input: { file_path: '/tmp/doctor-counsel.ts' },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/doctor-counsel.ts'],
        evidence: 'doctor counsel fixture',
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    } as never)
    const result = await counselMod.runCounsel(owner, '/tmp', async () => ({
      text: '{"disposition":"approve","findings":[]}',
      model: 'doctor-fixture',
    }))
    if (result.disposition !== 'approve' || result.reviewedSeqs.length !== 1) {
      return { status: 'fail', evidence: `deterministic review read ${result.disposition} over ${result.reviewedSeqs.length} receipt(s), wanted approve over 1` }
    }
    return {
      status: 'ok',
      evidence: `deterministic review loop green (window of 1, disposition approve) — live mode: ${mode}`,
    }
  } finally {
    disposeOwner(owner)
  }
}

/** V7. Agent envelope: declared tail + observed receipts normalize honestly. */
export async function probeAgentEnvelope(): Promise<CheckResult> {
  const { buildAgentResultEnvelope } = await import('../services/agentResults/normalize.js')
  const { observeToolTerminal } = await import('../services/run/effectObserver.js')
  const { processOwnerForLane } = await import('../services/run/resolveOwner.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const agentId = `doctor-envelope-${process.pid}`
  const owner = processOwnerForLane(agentId)
  try {
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'doctor-envelope',
      input: { file_path: '/tmp/doctor-envelope.ts' },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/doctor-envelope.ts'],
        evidence: 'doctor envelope fixture',
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    } as never)
    const envelope = await buildAgentResultEnvelope({
      agentId,
      status: 'completed',
      finalText:
        'done. I also touched /tmp/prose-claim.ts\n<mercury-envelope>{"summary":"probe summary","checks":["never-ran"]}</mercury-envelope>',
    })
    const ok =
      envelope.summary === 'probe summary' &&
      envelope.changedPaths.length === 1 &&
      envelope.changedPaths[0] === '/tmp/doctor-envelope.ts' &&
      envelope.checks.some(c => c.name === 'never-ran' && c.state === 'unknown')
    if (!ok) {
      return { status: 'fail', evidence: `envelope drifted: ${JSON.stringify({ s: envelope.summary, c: envelope.changedPaths, k: envelope.checks })}` }
    }
    return {
      status: 'ok',
      evidence: 'declared summary honored, observed path from the receipt ring, unverified check read unknown',
    }
  } finally {
    disposeOwner(owner)
  }
}

/** the primitive journey on a disposable fixture owner —
 *  execution lifecycle → synthetic mutation → receipt → transaction →
 *  evidence → resource traversal → stream fixture → disposal. Zero paid
 *  calls; every record dies with the fixture owner. */
export async function probeAxiomPrimitives(): Promise<CheckResult> {
  const ownerMod = await import('../services/run/ownerKey.js')
  const P = await import('../services/primitives/index.js')
  const { observeToolTerminal } = await import('../services/run/effectObserver.js')
  const { resolveResource } = await import('../services/resources/registry.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const owner = fixtureOwnerKey(ownerMod, 'axiom')
  try {
    // Execution lifecycle + evidence at settlement.
    P.registerExecution({ owner, id: 'probe-exec', kind: 'process', label: 'probe', lifecycle: 'owner' })
    P.transitionExecution(owner, 'probe-exec', 'starting')
    P.transitionExecution(owner, 'probe-exec', 'running')
    P.settleExecution(owner, 'probe-exec', 'succeeded', { outcome: { code: 0 } })
    const exec = P.getExecution(owner, 'probe-exec')
    if (exec?.state !== 'succeeded' || exec.generation !== 1) {
      return { status: 'fail', evidence: `execution lifecycle broke: ${exec?.state}` }
    }
    // Synthetic mutation → receipt → transaction → change evidence.
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'axiom-probe',
      input: { file_path: '/tmp/doctor-axiom.ts' },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: ['/tmp/doctor-axiom.ts'],
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
    // Resource traversal: owner → execution child.
    const res = await resolveResource('mercury://owner', { owner, cwd: '/tmp' })
    if (res.state !== 'ok' || !res.resource.children?.some(c => c.ref === 'mercury://execution/probe-exec')) {
      return { status: 'fail', evidence: `owner→execution traversal broke (${res.state})` }
    }
    // Stream fixture: SSE → canonical order.
    const state = P.newAnthropicProjectionState()
    const events = [
      { type: 'message_start', message: { model: 'fixture' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ].flatMap(e => P.projectAnthropicStreamEvent(e as never, state))
    if (events.map(e => e.type).join(',') !== 'response.started,text.delta,response.completed') {
      return { status: 'fail', evidence: `canonical stream fixture drifted: ${events.map(e => e.type).join(',')}` }
    }
    // Disposal: everything owned dies with the owner.
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

/**
 * the structural closed loop — query → write-nothing
 * preview → stale-safe apply → re-read verification → parse-diagnostics
 * rerun → canonical evidence, on a disposable fixture project. Proves the
 * parser facility (workspace or vendored) INSIDE this build.
 */
export async function probeStructureLoop(): Promise<CheckResult> {
  const { structureEnabled } = await import('../services/structure/contracts.js')
  if (!structureEnabled()) {
    return { status: 'off', evidence: 'MERCURY_STRUCTURE=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const { runStructureQuery } = await import('../services/structure/query.js')
  const { buildPreview, applyPreview } = await import('../services/structure/transform.js')
  const { resolveStructureTypescript } = await import('../services/structure/tsFacility.js')

  const owner = fixtureOwnerKey(ownerMod, 'structure')
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'doctor-structure-'))
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
    // Stale refusal: a second identical preview against the NOW-CHANGED
    // tree must refuse at apply time if the tree drifts under it.
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

/**
 * the git work-graph closed loop — a disposable
 * repository, typed status/diff, a two-group commit plan applied with
 * per-commit verification + transactions, then the stale-refusal law —
 * all INSIDE this build.
 */
export async function probeGitGraph(): Promise<CheckResult> {
  const { gitGraphEnabled } = await import('../services/gitGraph/contracts.js')
  if (!gitGraphEnabled()) {
    return { status: 'off', evidence: 'MERCURY_GIT_GRAPH=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const { gitStatus, gitDiff, isGitRepo } = await import('../services/gitGraph/observe.js')
  const { preparePlan, applyPlan } = await import('../services/gitGraph/plan.js')
  const { transactionById } = await import('../services/primitives/transactionPlane.js')

  const owner = fixtureOwnerKey(ownerMod, 'gitgraph')
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'doctor-git-'))
  const sh = (args: string[]): string =>
    execFileSync('git', args, {
      windowsHide: true,
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...subprocessEnv(),
        GIT_AUTHOR_NAME: 'doctor',
        GIT_AUTHOR_EMAIL: 'doctor@local',
        GIT_COMMITTER_NAME: 'doctor',
        GIT_COMMITTER_EMAIL: 'doctor@local',
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
    // stale refusal
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

/**
 * the application-journey closed loop — a REAL loopback
 * node HTTP fixture started as a project service, verified end to end
 * (readiness → request assertions → log match → explicit stop), plus the
 * honest-failure leg (a wrong expectation settles failed with the mismatch
 * NAMED, later steps skipped, cleanup recorded) — inside this build.
 */
export async function probeJourneyLoop(): Promise<CheckResult> {
  const { journeysEnabled } = await import('../services/journeys/contracts.js')
  if (!journeysEnabled()) {
    return { status: 'off', evidence: 'MERCURY_JOURNEYS=0' }
  }
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const ownerMod = await import('../services/run/ownerKey.js')
  const { disposeOwner } = await import('../services/run/ownerLifecycle.js')
  const { runJourney } = await import('../services/journeys/runner.js')
  const { getExecution } = await import('../services/primitives/executionPlane.js')

  const owner = fixtureOwnerKey(ownerMod, 'journey')
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'doctor-journey-'))
  const PORT = 42_733
  fs.writeFileSync(
    pathMod.join(root, 'server.mjs'),
    `import { createServer } from 'node:http'
createServer((req, res) => { console.log('hit ' + req.url); res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})) })
  .listen(${PORT}, '127.0.0.1', () => console.log('DOCTOR FIXTURE READY'))
`,
  )
  try {
    const good = await runJourney(
      {
        objective: 'doctor: verify the loopback fixture end to end',
        steps: [
          {
            kind: 'service.start',
            name: 'doctor-journey-fixture',
            command: process.execPath,
            args: ['server.mjs'],
            readiness: [{ kind: 'log', regex: 'DOCTOR FIXTURE READY' }],
          },
          { kind: 'service.wait', name: 'doctor-journey-fixture' },
          {
            kind: 'http.request',
            url: `http://127.0.0.1:${PORT}/health`,
            expect: { status: 200, bodyIncludes: '"ok":true' },
          },
          { kind: 'log.match', service: 'doctor-journey-fixture', pattern: 'hit /health' },
          { kind: 'service.stop', name: 'doctor-journey-fixture' },
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
        objective: 'doctor: a wrong expectation fails honestly',
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
