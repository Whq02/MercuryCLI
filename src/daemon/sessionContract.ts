
import { updateConcourseWorkers } from './concourseSupervisor.js'

export interface SessionContractAmendmentV1 {
  text: string
  at: number
  by: string
}

export interface SessionContractV1 {
  text: string
  status: 'draft' | 'acknowledged' | 'active' | 'amended' | 'closed'
  ackAt?: number
  amendedAt?: number
  amendments: SessionContractAmendmentV1[]
}

export type ContractOp = 'set' | 'ack' | 'amend' | 'close'

export interface ContractOpRequestV1 {
  op: ContractOp
  text?: string
}

export type ContractOpOutcome = { outcome: 'applied' | 'noop' | 'refused'; detail?: string }

export const CONTRACT_TEXT_CAP = 20_000

export function contractInForce(c: SessionContractV1 | undefined): boolean {
  return c !== undefined && (c.status === 'acknowledged' || c.status === 'active')
}

export function applyConcourseContractOp(
  sessionId: string,
  req: ContractOpRequestV1,
  by: string,
  dir?: string,
): ContractOpOutcome {
  const text = (req.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, CONTRACT_TEXT_CAP)
  let out: ContractOpOutcome = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const standing = rec.contract
    switch (req.op) {
      case 'set': {
        if (text.length === 0) {
          out = { outcome: 'refused', detail: 'a contract needs words' }
          return
        }
        if (standing === undefined || standing.status === 'closed') {
          rec.contract = {
            text,
            status: 'draft',
            amendments:
              standing === undefined
                ? []
                :
                  [...standing.amendments, { text: standing.text, at: Date.now(), by }],
          }
          out = { outcome: 'applied', detail: standing === undefined ? 'contract drafted' : 'contract drafted anew — the closed text is kept in its history' }
          return
        }
        if (standing.status === 'draft') {
          standing.text = text
          out = { outcome: 'applied', detail: 'draft revised' }
          return
        }
        out = { outcome: 'refused', detail: `the contract is ${standing.status} — amend it (history is kept); set only authors drafts` }
        return
      }
      case 'ack': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to acknowledge' }
          return
        }
        if (standing.status === 'acknowledged' || standing.status === 'active') {
          out = { outcome: 'noop', detail: 'already acknowledged' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'refused', detail: 'the contract is closed' }
          return
        }
        standing.status = 'acknowledged'
        standing.ackAt = Date.now()
        out = { outcome: 'applied', detail: 'acknowledged — the agreement is in force' }
        return
      }
      case 'amend': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to amend — set drafts one' }
          return
        }
        if (text.length === 0) {
          out = { outcome: 'refused', detail: 'an amendment needs words' }
          return
        }
        if (standing.status === 'draft') {
          out = { outcome: 'refused', detail: 'a draft is not in force — set revises it' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'refused', detail: 'the contract is closed — a new contract sets afresh' }
          return
        }
        standing.amendments.push({ text: standing.text, at: Date.now(), by })
        standing.text = text
        standing.status = 'amended'
        standing.amendedAt = Date.now()
        out = { outcome: 'applied', detail: 'amended — the worker re-acknowledges through its contract tool' }
        return
      }
      case 'close': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to close' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'noop', detail: 'already closed' }
          return
        }
        standing.status = 'closed'
        out = { outcome: 'applied', detail: 'contract closed — text and history kept' }
        return
      }
    }
  }, dir)
  return out
}
