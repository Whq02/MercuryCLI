#!/usr/bin/env bun
// ============================================================================
//  — the coordinator kernel + the ONE global identity.
//
//  §1 mode resolution — off/rules-only pass through; agent-assisted
//     DOWNGRADES to rules-only with a VISIBLE fallback reason (the
//     shape; never silent).
//  §2 pure evaluation tables — same facts + same event ⇒ byte-identical
//     decisions; R1/R2/R3 exact shapes (code owns the decisions).
//  §3 idempotent execution at the owners — running the SAME decision twice
//     applies once (ref-idempotent raise; exactly-once supersede; revision-
//     dedup emit) — the shared idempotency contract, the dedupe.
//  §4 Rules-only ZERO model calls — STRUCTURAL: the kernel module's import
//     closure contains no provider/model/stream module (the zero-call
//     leg; the agent-assisted lane will live in its OWN module).
//  §5 the global identity — ensureCoordinatorIdentity is idempotent by
//     binding (same agentId across calls), role-linked 'coordinator'
//     (the stable global crew identity).
//  §6 the production wires exist — dispatch-refused (R1) at the dispatch
//     owner; worker-settled (R2) at the settle owner; R3's one live source
//     is the hook (adjudication pinned).
//
//  Hermetic per proof-hygiene: mkdtemp scratch roots, explicit dirs.
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evaluateKernel,
  executeKernelDecision,
  resolveCoordinatorMode,
  runCoordinatorKernel,
  type KernelEventV1,
} from '../../src/services/concourse/coordinatorKernel.ts'
import {
  ensureCoordinatorIdentity,
  _resetCoordinatorIdentityForTesting,
} from '../../src/services/concourse/coordinatorIdentity.ts'
import { upsertObligation, openObligations, obligationOf } from '../../src/services/crew/obligations.ts'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'sg5-kernel-'))
const crewDir = join(scratch, 'crew')
const configDir = join(scratch, 'config')
const identityDir = join(scratch, 'identity')
for (const d of [crewDir, configDir, identityDir]) mkdirSync(d, { recursive: true })

// ── §1 mode resolution ──────────────────────────────────────────────────────
console.log('§1 mode resolution (ONE owner)')
{
  check('undefined ⇒ rules-only (the default truth)', resolveCoordinatorMode(undefined).effective === 'rules-only')
  check('off passes through', resolveCoordinatorMode('off').effective === 'off')
  check('rules-only passes through with NO fallback reason', resolveCoordinatorMode('rules-only').fallbackReason === undefined)
  const assisted = resolveCoordinatorMode('agent-assisted')
  // (5f): the lane EXISTS — the mode owner resolves agent-assisted
  // as itself; whether the lane may take a MODEL turn is the separate
  // composition (resolveEffectiveCoordinator — its own §1 legs pin the
  // typed registry/route downgrades). The kernel rules run mode-agnostic
  // under their true label in every non-off mode.
  check('agent-assisted resolves as ITSELF (the lane exists — A6 lift)', assisted.effective === 'agent-assisted')
  check('…with NO fallback reason at the mode owner (assist validity lives in the composition)', assisted.fallbackReason === undefined)
  check('…and the REQUESTED mode is preserved in the resolution', assisted.requested === 'agent-assisted')
}

// ── §2 pure evaluation tables ───────────────────────────────────────────────
console.log('§2 pure evaluation (byte-identical, no I/O)')
{
  const refuse: KernelEventV1 = {
    kind: 'dispatch-refused',
    clientMessageId: 'cm-9',
    reason: 'concourse runtime ceiling reached (5 live sessions)',
    workspaceDir: '/ws',
    promptPreview: 'Fix the reconnect race in the daemon control socket please',
  }
  const a = evaluateKernel({ openObligations: [] }, refuse)
  const b = evaluateKernel({ openObligations: [] }, refuse)
  check('R1: one attention.raise per refusal', a.length === 1 && a[0]?.verb === 'attention.raise')
  check('R1: ref is capacity-scoped by clientMessageId', a[0]?.verb === 'attention.raise' && a[0].ref === 'kernel:capacity:cm-9')
  check('R1: the question names the reason AND the preserved draft', a[0]?.verb === 'attention.raise' && a[0].question.includes('ceiling') && a[0].question.includes('preserved'))
  check('pure: same facts + event ⇒ byte-identical decisions', JSON.stringify(a) === JSON.stringify(b))

  const rows = [
    { obligationId: 'o1', sessionId: 's-gone', revision: 2, question: 'q1' },
    { obligationId: 'o2', sessionId: 's-live', revision: 1, question: 'q2' },
    { obligationId: 'o3', sessionId: 's-gone', revision: 5, question: 'q3' },
  ] as never[]
  const settled = evaluateKernel({ openObligations: rows }, { kind: 'worker-settled', sessionId: 's-gone', runnerId: 'concourse-w2' })
  check('R2: supersedes EXACTLY the ended session’s open rows', settled.length === 2 && settled.every(d => d.verb === 'attention.supersede'))
  check('R2: the untouched session’s row is untouched', !settled.some(d => d.verb === 'attention.supersede' && d.obligationId === 'o2'))

  // SB-C7 (close audit): merge identity keys to the SESSION — a recycled
  // worker short settling a second fork must never replay the first fork's
  // receipt (the dispatch door is idempotent by clientMessageId).
  const retainedOf = (sessionId: string) =>
    evaluateKernel({ openObligations: [] }, {
      kind: 'worker-settled',
      sessionId,
      runnerId: 'concourse-w2',
      retained: {
        workspaceId: '/ws',
        title: `fork ${sessionId}`,
        branchName: `mercury/${sessionId}`,
        mainHolderSessionId: 'main-1',
        batchBranches: [],
      },
    } as never)
  const idA = retainedOf('sess-A').find(d => d.verb === 'session.redirect')?.clientMessageId
  const idB = retainedOf('sess-B').find(d => d.verb === 'session.redirect')?.clientMessageId
  check('SB-C7: two settles on ONE recycled short mint DISTINCT merge ids', idA !== undefined && idA !== idB, `${idA} vs ${idB}`)
  check('SB-C7: the merge id carries the session identity', idA === 'merge-back:sess-A', String(idA))

  const emit = evaluateKernel({ openObligations: rows }, { kind: 'obligation-open', obligationId: 'o3' })
  check('R3: emits the row’s CURRENT revision', emit.length === 1 && emit[0]?.verb === 'signal.emit' && emit[0].revision === 5)
  const gone = evaluateKernel({ openObligations: rows }, { kind: 'obligation-open', obligationId: 'o-settled-meanwhile' })
  check('R3: a row settled between trigger and fold emits NOTHING', gone.length === 0)
}

// ── §3 idempotent execution at the owners ───────────────────────────────────
console.log('§3 idempotent execution (the owners’ own laws)')
{
  const raise = evaluateKernel({ openObligations: [] }, {
    kind: 'dispatch-refused',
    clientMessageId: 'cm-idem',
    reason: 'ceiling',
    workspaceDir: '/ws',
    promptPreview: 'p',
  })[0]!
  const r1 = await executeKernelDecision(raise, { crewDir })
  const r2 = await executeKernelDecision(raise, { crewDir })
  check('raise applies once', r1.outcome === 'applied', r1.detail)
  check('re-raise is a no-op (ref-idempotent at the owner)', r2.outcome === 'noop', r2.detail)
  const open = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('exactly ONE obligation row exists', open.length === 1)

  // R2 against the REAL store: settle the row via the kernel.
  const sup = evaluateKernel({ openObligations: open }, { kind: 'worker-settled', sessionId: open[0]!.sessionId, runnerId: 'w-x' })
  const s1 = await executeKernelDecision(sup[0]!, { crewDir })
  const s2 = await executeKernelDecision(sup[0]!, { crewDir })
  check('supersede applies once', s1.outcome === 'applied', s1.detail)
  check('re-supersede is a no-op (exactly-once at the owner)', s2.outcome === 'noop', s2.detail)
  const row = await obligationOf(open[0]!.obligationId, { dir: crewDir, scope: 'switchboard' })
  check('the row settled superseded', row?.status === 'superseded', row?.status)

  // R3 through the policy layer with a recording sender.
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  await upsertObligation({ ref: 'q-emit', sessionId: 's-e', question: 'emit me', owner: 'worker', dir: crewDir, scope: 'switchboard' })
  const fresh = await openObligations({ dir: crewDir, scope: 'switchboard' })
  const target = fresh.find(o => o.ref === 'q-emit')!
  const sent: string[] = []
  const emit = evaluateKernel({ openObligations: fresh }, { kind: 'obligation-open', obligationId: target.obligationId })[0]!
  const e1 = await executeKernelDecision(emit, {
    crewDir,
    configDir,
    send: async a => {
      sent.push(a.title)
      return 'id'
    },
  })
  const e2 = await executeKernelDecision(emit, {
    crewDir,
    configDir,
    send: async a => {
      sent.push(a.title)
      return 'id'
    },
  })
  check('emit applies once for a revision', e1.outcome === 'applied', e1.detail)
  check('re-emit of the SAME revision is a no-op (dedupe)', e2.outcome === 'noop', e2.detail)
  check('exactly one host send happened', sent.length === 1, String(sent.length))

  // NO SENDER, NO CLAIM (FN-017 rank 8): an emission with no notifier is a
  // typed refusal that leaves the revision for the hook that can reach a
  // host — the stub sender used to CLAIM it, and the hook's later real
  // send was refused as duplicate-revision (no toast, no activation
  // pointer, permanently).
  await upsertObligation({ ref: 'q-nosender', sessionId: 's-n', question: 'who tells the operator?', owner: 'worker', dir: crewDir, scope: 'switchboard' })
  const fresh2 = await openObligations({ dir: crewDir, scope: 'switchboard' })
  const target2 = fresh2.find(o => o.ref === 'q-nosender')!
  const emit2 = evaluateKernel({ openObligations: fresh2 }, { kind: 'obligation-open', obligationId: target2.obligationId })[0]!
  const noSender = await executeKernelDecision(emit2, { crewDir, configDir })
  check('an emission with NO sender is refused (the base recorded an applied claim through a stub)', noSender.outcome === 'refused' && /no-sender/.test(noSender.detail ?? ''), JSON.stringify(noSender))
  const sent2: string[] = []
  const realSend = await executeKernelDecision(emit2, {
    crewDir,
    configDir,
    send: async a => {
      sent2.push(a.title)
      return 'id'
    },
  })
  check('…and the revision was NOT burned: the owner with a real sender still emits it', realSend.outcome === 'applied' && sent2.length === 1, JSON.stringify(realSend))

  // THE QUEUED OUTCOME (FN-017 rank 4): a held dispatch is a queue, never a
  // refusal — the receipt union and both daemon executors say so, and the
  // supervisor consumes a queued merge-back's collision evidence.
  const { readFileSync } = await import('node:fs')
  const kernelSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/services/concourse/coordinatorKernel.ts'), 'utf8')
  check("the receipt outcome union carries 'queued'", /outcome: 'applied' \| 'noop' \| 'refused' \| 'failed' \| 'queued'/.test(kernelSrc))
  check('both daemon executors read state=queued + heldReason as QUEUED', (kernelSrc.match(/heldOpen \? 'queued' : 'refused'/g) ?? []).length === 2)
  const supervisorSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/daemon/concourseSupervisor.ts'), 'utf8')
  check('the supervisor consumes the collision evidence for a queued merge-back too', /\(r\.outcome === 'applied' \|\| r\.outcome === 'queued'\)/.test(supervisorSrc))
  const routeSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/components/concourse/ConcourseRoute.tsx'), 'utf8')
  check('the board runs no obligation-open ride (R3 has one owner)', !/kind: 'obligation-open'/.test(routeSrc) && !/assistedSweep/.test(routeSrc))

  // The runner: mode off runs NOTHING.
  const offReceipts = await runCoordinatorKernel(
    { kind: 'worker-settled', sessionId: 's-any', runnerId: 'w' },
    { mode: 'off', crewDir },
  )
  check("mode 'off' executes nothing (operator parity keeps everything reachable)", offReceipts.length === 0)
}

// ── §4 Rules-only zero model calls (structural) ─────────────────────────────
console.log('§4 zero provider surface (structural import closure)')
{
  // The kernel + its static closure must never touch provider/model/stream
  // modules. Walk static + dynamic import specifiers transitively from the
  // kernel source (repo-relative), flagging provider-shaped paths.
  const banned = /services\/providers\/|utils\/model\/|streamModel|run-core\/turn-machine|api\/|anthropic|openai/i
  const seen = new Set<string>()
  const queue = ['src/services/concourse/coordinatorKernel.ts']
  const offenders: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let src = ''
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of src.matchAll(/import\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (!spec.startsWith('.')) continue
      const base = join(file, '..', spec).replace(/\.js$/, '.ts')
      if (banned.test(base)) offenders.push(`${file} → ${spec}`)
      else queue.push(base)
    }
  }
  check('the kernel’s import closure contains NO provider/model module', offenders.length === 0, offenders.join('; '))
  check('the closure was actually walked (not vacuous)', seen.size >= 3, `${seen.size} modules`)
}

// ── §5 the ONE global identity ──────────────────────────────────────────────
console.log('§5 the global coordinator identity')
{
  _resetCoordinatorIdentityForTesting()
  const a = await ensureCoordinatorIdentity({ dir: identityDir })
  const b = await ensureCoordinatorIdentity({ dir: identityDir })
  check('idempotent by binding — ONE stable agentId', a.agentId === b.agentId)
  check('displayName is the named seat', a.displayName === 'Concourse Coordinator')
  const identity = await import('../../src/services/crew/identity.ts')
  const roles = await identity.listAgentRoles(a.agentId, { dir: identityDir })
  const link = roles.find(r => r.role === 'coordinator' && r.activeUntil === undefined)
  check("role-linked 'coordinator' (active)", link !== undefined, roles.map(r => r.role).join(','))
}

// ── §6 the production wires ─────────────────────────────────────────────────
console.log('§6 production wires at the owners')
{
  const dispatch = readFileSync('src/daemon/concourseDispatch.ts', 'utf8')
  check('R1 wired at the dispatch owner (refusal → kernel event)', dispatch.includes("kind: 'dispatch-refused'") && dispatch.includes('runCoordinatorKernel'))
  const supervisor = readFileSync('src/daemon/concourseSupervisor.ts', 'utf8')
  check('R2 wired at the settle owner (first settle → kernel event)', supervisor.includes("kind: 'worker-settled'") && supervisor.includes('runCoordinatorKernel'))
  const hook = readFileSync('src/hooks/useObligationSignals.ts', 'utf8')
  check("R3's ONE live source is the hook (adjudication holds)", hook.includes('emitConcourseSignal'))
  const kernel = readFileSync('src/services/concourse/coordinatorKernel.ts', 'utf8')
  check('the kernel pins the R3 adjudication in its contract', kernel.includes('PRODUCTION WIRE ADJUDICATION'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-COORDINATOR-KERNEL: PASS' : `\nPROVE-COORDINATOR-KERNEL: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
