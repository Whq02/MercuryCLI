#!/usr/bin/env bun
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

const P = await import('../../src/engine/runtime-kernel/index.ts')

console.log('owner descriptor laws')
{
  const session = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: P.MAIN_LANE })
  const agent = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: P.agentLane('a9') })
  const dSession = P.describeOwner(session)
  const dAgent = P.describeOwner(agent)
  check('session scope derived', dSession.scope === 'session' && dSession.parent === undefined,
    `scope ${dSession.scope}; fix describeOwner in src/engine/execution-plane/owner.ts`)
  check('agent scope derived with parent = session main lane',
    dAgent.scope === 'agent' && dAgent.parent === session,
    `scope ${dAgent.scope}; fix describeOwner in src/engine/execution-plane/owner.ts so an agent lane reports its session main lane as parent`)
  const proj = P.projectOwner('/w')
  const dProj = P.describeOwner(proj)
  check('project owner is canonical + scope project',
    P.isOwnerKey(proj) && dProj.scope === 'project' && dProj.workspace === '/w',
    `scope ${dProj.scope}, workspace ${dProj.workspace}; fix projectOwner or describeOwner in src/engine/execution-plane/owner.ts`)
  check('project owner never collides with a session key', proj !== session,
    'projectOwner in src/engine/execution-plane/owner.ts must build a key that differs from a session key for the same workspace')
  const mach = P.machineOwner()
  check('machine owner scope', P.describeOwner(mach).scope === 'machine',
    `scope ${P.describeOwner(mach).scope}; fix machineOwner or describeOwner in src/engine/execution-plane/owner.ts`)
  const lane = P.makeOwnerKey({ workspace: '/w', sessionId: 's1', lane: 'side', querySource: '' })
  check('non-agent lane scope derived with parent', P.describeOwner(lane).scope === 'lane',
    `scope ${P.describeOwner(lane).scope}; fix describeOwner in src/engine/execution-plane/owner.ts`)
}

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
    check(`legal chain: ${name}`, ok,
      `an edge in ${chain.join(' > ')} is refused; add it to the transition table behind canTransitionExecution in src/engine/execution-plane/execution.ts`)
  }
  check('terminals are locked',
    P.TERMINAL_EXECUTION_STATES.every(t => P.legalExecutionTransitions(t).length === 0),
    'a terminal state has outgoing edges; remove them from the transition table in src/engine/execution-plane/execution.ts')
  check('queued cannot jump to running', !P.canTransitionExecution('queued', 'running'),
    'remove the queued to running edge from the transition table in src/engine/execution-plane/execution.ts')
  check('succeeded cannot resurrect', !P.canTransitionExecution('succeeded', 'running'),
    'remove the succeeded to running edge from the transition table in src/engine/execution-plane/execution.ts')
  check('running is never unavailable', !P.canTransitionExecution('running', 'unavailable'),
    'remove the running to unavailable edge from the transition table in src/engine/execution-plane/execution.ts')
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
  check('no trap states', nonTerminal.every(reachesTerminal),
    `unreachable terminal from: ${nonTerminal.filter(s => !reachesTerminal(s)).join(', ')}; add an outgoing path in src/engine/execution-plane/execution.ts`)
  try {
    throw new P.ExecutionTransitionError('x', 'succeeded', 'running')
  } catch (e) {
    check('typed execution refusal',
      e instanceof P.ExecutionTransitionError && e.from === 'succeeded' && e.to === 'running',
      'ExecutionTransitionError in src/engine/execution-plane/execution.ts must keep the from and to states it is built with')
  }
}

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
    check(`legal chain: ${name}`, ok,
      `an edge in ${chain.join(' > ')} is refused; add it to the transition table behind canTransitionTransaction in src/engine/runtime-kernel/transaction.ts`)
  }
  check('terminals are locked',
    P.TERMINAL_TRANSACTION_STATES.every(t => P.legalTransactionTransitions(t).length === 0),
    'a terminal transaction state has outgoing edges; remove them from the transition table in src/engine/runtime-kernel/transaction.ts')
  check('no stale once applying', !P.canTransitionTransaction('applying', 'stale')
    && !P.canTransitionTransaction('applied', 'stale'),
    'remove the applying to stale and applied to stale edges from the transition table in src/engine/runtime-kernel/transaction.ts')
  check('cannot claim applied without applying', !P.canTransitionTransaction('created', 'applied'),
    'remove the created to applied edge from the transition table in src/engine/runtime-kernel/transaction.ts')
  check('cannot claim verified without checking', !P.canTransitionTransaction('applied', 'verified'),
    'remove the applied to verified edge from the transition table in src/engine/runtime-kernel/transaction.ts')
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
  check('no trap states', nonTerminal.every(reachesTerminal),
    `unreachable terminal from: ${nonTerminal.filter(s => !reachesTerminal(s)).join(', ')}; add an outgoing path in src/engine/runtime-kernel/transaction.ts`)
  try {
    throw new P.TransactionTransitionError('t', 'settled', 'applying')
  } catch (e) {
    check('typed transaction refusal', e instanceof P.TransactionTransitionError,
      'TransactionTransitionError in src/engine/runtime-kernel/transaction.ts must stay an Error subclass that instanceof recognises')
  }
}

console.log('evidence laws')
{
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
  check('valid observed record passes', P.evidenceRecordProblems(base).length === 0,
    `problems: ${P.evidenceRecordProblems(base).join('; ')}; fix evidenceRecordProblems in src/engine/runtime-kernel/evidence.ts`)
  check('derived without sources refused',
    P.evidenceRecordProblems({ ...base, origin: 'derived' }).some(p => p.includes('source refs')),
    'evidenceRecordProblems in src/engine/runtime-kernel/evidence.ts must report a problem mentioning source refs for a derived record with none')
  check('missing claim refused',
    P.evidenceRecordProblems({ ...base, claim: '' }).length > 0,
    'evidenceRecordProblems in src/engine/runtime-kernel/evidence.ts must report a problem for an empty claim')
}

console.log('view mapping laws')
{
  const { cardTone } = await import('../../src/screen/widgets/toolCardGrammar.ts')
  const fallback = cardTone('__unknown__')
  const isMapped = (s: string) => {
    const t = cardTone(s)
    return t.glyph !== fallback.glyph || t.tone !== fallback.tone
  }
  const execUnmapped = P.EXECUTION_STATES.filter(s => !isMapped(P.executionCardState(s)))
  check('every execution state renders a mapped tone', execUnmapped.length === 0,
    `${execUnmapped.join(', ')} (map each in executionCardState in src/engine/runtime-kernel/view.ts to a card state that cardTone in src/screen/widgets/toolCardGrammar.ts knows)`)
  const txnUnmapped = P.TRANSACTION_STATES.filter(s => !isMapped(P.transactionCardState(s)))
  check('every transaction state renders a mapped tone', txnUnmapped.length === 0,
    `${txnUnmapped.join(', ')} (map each in transactionCardState in src/engine/runtime-kernel/view.ts to a card state that cardTone in src/screen/widgets/toolCardGrammar.ts knows)`)
  check('applied is never painted succeeded', P.transactionCardState('applied') !== 'succeeded',
    'transactionCardState in src/engine/runtime-kernel/view.ts must not map applied to succeeded')
  check('stale reads as expiry honesty, not failure',
    P.transactionCardState('stale') === 'expired',
    'transactionCardState in src/engine/runtime-kernel/view.ts must map stale to expired')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
