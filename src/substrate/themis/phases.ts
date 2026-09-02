


export interface PhaseSpec {
  name: string
  reviewRequired?: boolean
}

export type PhaseViolationKind =
  | 'PHASE_ORDER'
  | 'END_WITHOUT_START'
  | 'ALREADY_ENDED'
  | 'DELEGATION_GATE'
  | 'SECURITY_SCAN_GATE'
  | 'REVIEW_GATE'
  | 'ITERATION_CAP'
  | 'UNKNOWN_PHASE'

export interface PhaseViolation {
  ok: false
  kind: PhaseViolationKind
  detail: string
}

export type PhaseResult = { ok: true } | PhaseViolation

export interface DelegationReceipt {
  id: string
  wroteFiles: boolean
  received: boolean
}

export interface PhaseMachineState {
  phases: PhaseSpec[]
  open: number
  ended: string[]
  delegations: Record<string, DelegationReceipt[]>
  securityScan: Record<string, 'clean' | 'dirty' | 'pending'>
  review: Record<string, 'approved' | 'rejected' | 'pending'>
  iteration: number
  iterationCap: number
}

export interface PhaseMachine {
  start(phase: string): PhaseResult
  end(phase: string): PhaseResult
  recordDelegation(phase: string, receipt: DelegationReceipt): PhaseResult
  recordSecurityScan(phase: string, status: 'clean' | 'dirty'): PhaseResult
  recordReview(phase: string, verdict: 'approved' | 'rejected'): PhaseResult
  bumpIteration(): PhaseResult
  rollbackTo(phase: string): PhaseResult
  state(): PhaseMachineState
}

const clampCap = (n: number | undefined): number => {
  const v = Math.floor(typeof n === 'number' && Number.isFinite(n) ? n : 3)
  return Math.min(5, Math.max(1, v))
}

export function createPhaseMachine(opts: {
  phases: Array<string | PhaseSpec>
  iterationCap?: number
  audit?: (action: string, details: string) => void
}): PhaseMachine {
  const phases: PhaseSpec[] = opts.phases.map(p => (typeof p === 'string' ? { name: p } : p))
  const st: PhaseMachineState = {
    phases,
    open: -1,
    ended: [],
    delegations: {},
    securityScan: {},
    review: {},
    iteration: 0,
    iterationCap: clampCap(opts.iterationCap),
  }
  const audit = (action: string, details: string): void => {
    try {
      opts.audit?.(action, details)
    } catch {
    }
  }
  const idx = (name: string): number => phases.findIndex(p => p.name === name)
  const violate = (kind: PhaseViolationKind, detail: string): PhaseViolation => {
    audit('phase-violation', `${kind}: ${detail}`)
    return { ok: false, kind, detail }
  }

  return {
    start(name) {
      const i = idx(name)
      if (i === -1) return violate('UNKNOWN_PHASE', `no phase named ${name}`)
      if (st.ended.includes(name)) return violate('ALREADY_ENDED', `${name} already ended`)
      if (st.open !== -1) {
        return violate('PHASE_ORDER', `cannot start ${name} while ${phases[st.open]!.name} is open`)
      }
      for (let k = 0; k < i; k++) {
        if (!st.ended.includes(phases[k]!.name)) {
          return violate('PHASE_ORDER', `cannot start ${name}: ${phases[k]!.name} has not ended`)
        }
      }
      st.open = i
      audit('phase-start', name)
      return { ok: true }
    },

    end(name) {
      const i = idx(name)
      if (i === -1) return violate('UNKNOWN_PHASE', `no phase named ${name}`)
      if (st.open !== i) return violate('END_WITHOUT_START', `${name} is not the open phase`)
      const receipts = st.delegations[name] ?? []
      const unreceipted = receipts.filter(r => !r.received)
      if (unreceipted.length > 0) {
        return violate('DELEGATION_GATE', `${unreceipted.length} delegation(s) without receipts in ${name}`)
      }
      const wroteFiles = receipts.some(r => r.wroteFiles)
      if (wroteFiles && st.securityScan[name] !== 'clean') {
        return violate('SECURITY_SCAN_GATE', `file-writing delegations occurred in ${name} and securityScan is ${st.securityScan[name] ?? 'pending'}, not clean`)
      }
      if (phases[i]!.reviewRequired && st.review[name] !== 'approved') {
        return violate('REVIEW_GATE', `${name} requires review; verdict is ${st.review[name] ?? 'pending'}`)
      }
      st.open = -1
      st.ended.push(name)
      audit('phase-end', name)
      return { ok: true }
    },

    recordDelegation(phase, receipt) {
      if (idx(phase) === -1) return violate('UNKNOWN_PHASE', `no phase named ${phase}`)
      if (st.ended.includes(phase)) {
        return violate('ALREADY_ENDED', `${phase} already ended — a post-end delegation would dodge the scan gate (rollbackTo reopens it)`)
      }
      const list = (st.delegations[phase] ??= [])
      const existing = list.findIndex(r => r.id === receipt.id)
      if (existing >= 0) list[existing] = receipt
      else list.push(receipt)
      if (receipt.wroteFiles && st.securityScan[phase] === undefined) {
        st.securityScan[phase] = 'pending'
      }
      audit('delegation', `${phase}: ${receipt.id} received=${receipt.received} wroteFiles=${receipt.wroteFiles}`)
      return { ok: true }
    },

    recordSecurityScan(phase, status) {
      if (idx(phase) === -1) return violate('UNKNOWN_PHASE', `no phase named ${phase}`)
      if (st.ended.includes(phase)) {
        return violate('ALREADY_ENDED', `${phase} already ended — its record is immutable (rollbackTo reopens it)`)
      }
      st.securityScan[phase] = status
      audit('security-scan', `${phase}: ${status}`)
      return { ok: true }
    },

    recordReview(phase, verdict) {
      if (idx(phase) === -1) return violate('UNKNOWN_PHASE', `no phase named ${phase}`)
      if (st.ended.includes(phase)) {
        return violate('ALREADY_ENDED', `${phase} already ended — its record is immutable (rollbackTo reopens it)`)
      }
      st.review[phase] = verdict
      audit('review', `${phase}: ${verdict}`)
      return { ok: true }
    },

    bumpIteration() {
      if (st.iteration >= st.iterationCap) {
        return violate('ITERATION_CAP', `auto-fix cap ${st.iterationCap} exhausted — escalate to the operator`)
      }
      st.iteration++
      audit('iteration', `${st.iteration}/${st.iterationCap}`)
      return { ok: true }
    },

    rollbackTo(name) {
      const i = idx(name)
      if (i === -1) return violate('UNKNOWN_PHASE', `no phase named ${name}`)
      if (!(i < st.ended.length || st.open === i)) {
        return violate('PHASE_ORDER', `cannot roll back to ${name}: it never started`)
      }
      st.ended = st.ended.filter(n => idx(n) < i)
      st.open = -1
      for (const p of phases.slice(i).map(p => p.name)) {
        delete st.review[p]
        delete st.securityScan[p]
        delete st.delegations[p]
      }
      st.iteration = 0
      audit('rollback', `to ${name} (iteration counter reset)`)
      return { ok: true }
    },

    state() {
      return JSON.parse(JSON.stringify(st)) as PhaseMachineState
    },
  }
}
