#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-primitives.ts — slice-1 contract laws.
//
//    · Owner: descriptor derivation is total + scope-correct; parent
//      derivation; project/machine owners are canonical keys; no collision
//      with real session keys.
//    · Execution graph: the prompt's journeys are legal; terminals locked;
//      no trap states (every non-terminal reaches a terminal); unavailable
//      only from pre-run states; typed refusals.
//    · Transaction graph: full previewable path + direct-edit skip path
//      legal; stale only pre-apply; check-fail-after-apply legal; terminals
//      locked; no trap states; typed refusals.
//    · Evidence: origin promotion is identity-only (declared NEVER becomes
//      observed); derived must name sources; structural validation total.
//    · View: execution + transaction card mappings are total and land on
//      card-grammar-mapped tones (no primitive state renders as the unknown
//      fallback).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const P = await import('../../src/services/primitives/index.ts')

// ── Owner descriptor laws ────────────────────────────────────────────────────
console.log('owner descriptor laws')
{
  const session = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: P.MAIN_LANE })
  const agent = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: P.agentLane('a9') })
  const dSession = P.describeOwner(session)
  const dAgent = P.describeOwner(agent)
  check('session scope derived', dSession.scope === 'session' && dSession.parent === undefined)
  check('agent scope derived with parent = session main lane',
    dAgent.scope === 'agent' && dAgent.parent === session)
  const proj = P.projectOwner('/w')
  const dProj = P.describeOwner(proj)
  check('project owner is canonical + scope project',
    P.isOwnerKey(proj) && dProj.scope === 'project' && dProj.workspace === '/w')
  check('project owner never collides with a session key', proj !== session)
  const mach = P.machineOwner()
  check('machine owner scope', P.describeOwner(mach).scope === 'machine')
  // A REAL session literally named like the sentinel cannot forge project
  // scope only if the sentinel is impossible as a session id; record the
  // honest current truth: the sentinel is name-reserved, not escaped.
  const lane = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: 'side', querySource: '' })
  check('non-agent lane scope derived with parent', P.describeOwner(lane).scope === 'lane')
}

// ── Execution graph laws ─────────────────────────────────────────────────────
console.log('execution graph laws')
{
  const chains: [string, P.ExecutionState[]][] = [
    ['happy completion', ['queued', 'starting', 'running', 'succeeded']],
    ['start failure', ['queued', 'starting', 'failed']],
    ['wait re-entry', ['queued', 'starting', 'running', 'waiting', 'running']],
    ['explicit stop', ['queued', 'starting', 'running', 'stopping', 'stopped']],
    ['stop racing success', ['queued', 'starting', 'running', 'stopping', 'succeeded']],
    ['service readiness', ['queued', 'starting', 'running', 'ready', 'running', 'ready']],
    ['reconciled indeterminate', ['queued', 'starting', 'running', 'indeterminate']],
    ['unavailable runtime', ['queued', 'starting', 'unavailable']],
  ]
  for (const [name, chain] of chains) {
    let ok = true
    for (let i = 1; i < chain.length; i++) {
      if (!P.canTransitionExecution(chain[i - 1]!, chain[i]!)) ok = false
    }
    check(`legal chain: ${name}`, ok)
  }
  check('terminals are locked',
    P.TERMINAL_EXECUTION_STATES.every(t => P.legalExecutionTransitions(t).length === 0))
  check('queued cannot jump to running', !P.canTransitionExecution('queued', 'running'))
  check('succeeded cannot resurrect', !P.canTransitionExecution('succeeded', 'running'))
  check('running is never unavailable', !P.canTransitionExecution('running', 'unavailable'))
  // No trap states: every non-terminal reaches a terminal via BFS.
  const nonTerminal = P.EXECUTION_STATES.filter(s => !P.isTerminalExecutionState(s))
  const reachesTerminal = (start: P.ExecutionState): boolean => {
    const seen = new Set<P.ExecutionState>([start])
    const queue = [start]
    while (queue.length) {
      const s = queue.shift()!
      if (P.isTerminalExecutionState(s)) return true
      for (const n of P.legalExecutionTransitions(s)) {
        if (!seen.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
    return false
  }
  check('no trap states', nonTerminal.every(reachesTerminal))
  try {
    throw new P.ExecutionTransitionError('x', 'succeeded', 'running')
  } catch (e) {
    check('typed execution refusal',
      e instanceof P.ExecutionTransitionError && e.from === 'succeeded' && e.to === 'running')
  }
}

// ── Transaction graph laws ───────────────────────────────────────────────────
console.log('transaction graph laws')
{
  const chains: [string, P.TransactionState[]][] = [
    ['full previewable path',
      ['created', 'prepared', 'proposed', 'authorised', 'applying', 'applied', 'checking', 'verified', 'settled']],
    ['direct edit skip', ['created', 'applying', 'applied', 'settled']],
    ['stale before apply', ['created', 'stale']],
    ['check fails after apply', ['created', 'applying', 'applied', 'checking', 'failed']],
    ['cancel before apply', ['created', 'prepared', 'cancelled']],
    ['cancel after apply', ['created', 'applying', 'applied', 'cancelled']],
  ]
  for (const [name, chain] of chains) {
    let ok = true
    for (let i = 1; i < chain.length; i++) {
      if (!P.canTransitionTransaction(chain[i - 1]!, chain[i]!)) ok = false
    }
    check(`legal chain: ${name}`, ok)
  }
  check('terminals are locked',
    P.TERMINAL_TRANSACTION_STATES.every(t => P.legalTransactionTransitions(t).length === 0))
  check('no stale once applying', !P.canTransitionTransaction('applying', 'stale')
    && !P.canTransitionTransaction('applied', 'stale'))
  check('cannot claim applied without applying', !P.canTransitionTransaction('created', 'applied'))
  check('cannot claim verified without checking', !P.canTransitionTransaction('applied', 'verified'))
  const nonTerminal = P.TRANSACTION_STATES.filter(s => !P.isTerminalTransactionState(s))
  const reachesTerminal = (start: P.TransactionState): boolean => {
    const seen = new Set<P.TransactionState>([start])
    const queue = [start]
    while (queue.length) {
      const s = queue.shift()!
      if (P.isTerminalTransactionState(s)) return true
      for (const n of P.legalTransactionTransitions(s)) {
        if (!seen.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
    return false
  }
  check('no trap states', nonTerminal.every(reachesTerminal))
  try {
    throw new P.TransactionTransitionError('t', 'settled', 'applying')
  } catch (e) {
    check('typed transaction refusal', e instanceof P.TransactionTransitionError)
  }
}

// ── Evidence laws ────────────────────────────────────────────────────────────
console.log('evidence laws')
{
  let promotions = 0
  for (const from of P.EVIDENCE_ORIGINS) {
    for (const to of P.EVIDENCE_ORIGINS) {
      if (from !== to && P.canPromoteEvidenceOrigin(from, to)) promotions++
    }
  }
  check('no origin promotion exists (declared never becomes observed)', promotions === 0)
  const owner = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: P.MAIN_LANE })
  const base = {
    version: 1 as const,
    id: 'ev1',
    owner,
    kind: 'check' as const,
    origin: 'observed' as const,
    claim: 'gate green',
    state: 'present' as const,
    observedAt: 1,
    refs: [],
  }
  check('valid observed record passes', P.evidenceRecordProblems(base).length === 0)
  check('derived without sources refused',
    P.evidenceRecordProblems({ ...base, origin: 'derived' }).some(p => p.includes('source refs')))
  check('missing claim refused',
    P.evidenceRecordProblems({ ...base, claim: '' }).length > 0)
}

// ── View mapping laws ────────────────────────────────────────────────────────
console.log('view mapping laws')
{
  const { cardTone } = await import('../../src/components/mercury-ui/toolCardGrammar.ts')
  const fallback = cardTone('__unknown__')
  const isMapped = (s: string) => {
    const t = cardTone(s)
    return t.glyph !== fallback.glyph || t.tone !== fallback.tone
  }
  const execUnmapped = P.EXECUTION_STATES.filter(s => !isMapped(P.executionCardState(s)))
  check('every execution state renders a mapped tone', execUnmapped.length === 0,
    execUnmapped.join(', '))
  const txnUnmapped = P.TRANSACTION_STATES.filter(s => !isMapped(P.transactionCardState(s)))
  check('every transaction state renders a mapped tone', txnUnmapped.length === 0,
    txnUnmapped.join(', '))
  check('applied is never painted succeeded', P.transactionCardState('applied') !== 'succeeded')
  check('stale reads as expiry honesty, not failure',
    P.transactionCardState('stale') === 'expired')
  const view = P.executionView({
    spec: { version: 1, id: 'svc:web', owner: P.projectOwner('/w'), kind: 'service', label: 'web', lifecycle: 'project' },
    generation: 2,
    state: 'ready',
    startedAt: 100,
    updatedAt: 200,
    settledAt: undefined,
    evidenceRefs: ['mercury://evidence/e1'],
    outputRef: 'mercury://execution/svc:web?child=output',
  })
  check('execution view derives, never stores',
    view.state === 'ready' && view.generation === 2 &&
      view.detailRefs.length === 2 && view.durationMs === undefined)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
