


import { appendObservation } from '../../memdir/mnemeBuffer.js'
import { appendAuditRow } from './auditChain.js'
import { createPhaseMachine, type PhaseMachine, type PhaseResult } from './phases.js'
import {
  normalizeSDS,
  routeRepair,
  taskPriority,
  topoLayers,
  validateSDS,
  verifyOwnership,
  type NormalizedSds,
  type RepairIssue,
  type Sds,
} from './sdsContract.js'
import { createTraceTable, scanDiff, type TraceTable } from './trace.js'

export interface ThemisWorkflowHost {
  validateSDS: (raw: unknown) => Promise<unknown>
  normalizeSDS: (sds: unknown) => Promise<unknown>
  topoLayers: (depGraph: unknown) => Promise<unknown>
  taskPriority: (input: unknown) => Promise<unknown>
  verifyOwnership: (input: unknown) => Promise<unknown>
  routeRepair: (input: unknown) => Promise<unknown>
  scanDiff: (input: unknown) => Promise<unknown>
  phase: (input: unknown) => Promise<unknown>
  traceUpdate: (input: unknown) => Promise<unknown>
  verifyTrace: (input: unknown) => Promise<unknown>
  observe: (input: unknown) => Promise<unknown>
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

export function makeThemisWorkflowHost(runId?: string): ThemisWorkflowHost {
  let machine: PhaseMachine | null = null
  let trace: TraceTable | null = null
  const audit = (action: string, details: string): void => {
    void appendAuditRow({ actor: 'workflow', action, details: runId ? `[${runId}] ${details}` : details })
  }
  const ensureTrace = (): TraceTable => (trace ??= createTraceTable())

  return {
    async validateSDS(raw) {
      return validateSDS(typeof raw === 'string' ? raw : (raw as object))
    },
    async normalizeSDS(sds) {
      return normalizeSDS(sds as Sds)
    },
    async topoLayers(depGraph) {
      return topoLayers(asRecord(depGraph) as Record<string, string[]>)
    },
    async taskPriority(input) {
      const o = asRecord(input)
      return taskPriority(asRecord(o.depGraph) as Record<string, string[]>, Array.isArray(o.sdsOrder) ? (o.sdsOrder as string[]) : [])
    },
    async verifyOwnership(input) {
      const o = asRecord(input)
      const lane = asRecord(o.lane)
      const verdict = verifyOwnership(asRecord(o.ownership) as Record<string, string>, {
        owner: String(lane.owner ?? ''),
        changedPaths: Array.isArray(lane.changedPaths) ? (lane.changedPaths as string[]) : [],
      })
      if (!verdict.ok) audit('ownership-violation', `${lane.owner}: ${verdict.violations.map(v => v.path).join(', ')}`)
      return verdict
    },
    async routeRepair(input) {
      const o = asRecord(input)
      const norm = asRecord(o.normalized)
      const sds = asRecord(norm.sds)
      if (
        !Array.isArray(sds.files) ||
        norm.ownership === null || typeof norm.ownership !== 'object' ||
        norm.depGraph === null || typeof norm.depGraph !== 'object'
      ) {
        audit('route-repair-malformed', 'normalized SDS shape invalid — no route')
        return null
      }
      const iss = asRecord(o.issue)
      const issue: RepairIssue = {
        symptom: String(iss.symptom ?? ''),
        suspectedFiles: Array.isArray(iss.suspectedFiles)
          ? (iss.suspectedFiles as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
        symbol: typeof iss.symbol === 'string' && iss.symbol ? iss.symbol : undefined,
        publicApiImpact: iss.publicApiImpact === true,
      }
      return routeRepair(issue, o.normalized as unknown as NormalizedSds)
    },
    async scanDiff(input) {
      const o = asRecord(input)
      const r = scanDiff(
        Array.isArray(o.declared) ? (o.declared as string[]) : [],
        Array.isArray(o.actual) ? (o.actual as string[]) : [],
      )
      if (!r.ok) audit('scan-diff-violation', `undeclared: ${r.undeclared.join(', ')}`)
      return r
    },
    async phase(input) {
      const o = asRecord(input)
      const op = String(o.op ?? '')
      if (op === 'init') {
        if (machine) {
          const s = machine.state()
          if (s.open !== -1 || s.ended.length > 0 || s.iteration > 0) {
            audit('phase-violation', `ALREADY_INITIALIZED: re-init refused (open=${s.open} ended=${s.ended.length} iteration=${s.iteration})`)
            return { ok: false, kind: 'ALREADY_INITIALIZED', detail: 'phase machine already in use — re-init would reset the iteration cap and gate history' }
          }
        }
        const phaseList = Array.isArray(o.phases) ? (o.phases as string[]) : []
        machine = createPhaseMachine({
          phases: phaseList,
          iterationCap: typeof o.iterationCap === 'number' ? o.iterationCap : undefined,
          audit: (action, details) => audit(action, details),
        })
        audit('phase-init', `${phaseList.length} phase(s), iterationCap ${typeof o.iterationCap === 'number' ? o.iterationCap : 'default'}`)
        return { ok: true }
      }
      if (!machine) return { ok: false, kind: 'NOT_INITIALIZED', detail: "call themis.phase({op:'init', phases}) first" }
      const m = machine
      const result: PhaseResult | { ok: false; kind: string; detail: string } | object = (() => {
        switch (op) {
          case 'start':
            return m.start(String(o.phase ?? ''))
          case 'end':
            return m.end(String(o.phase ?? ''))
          case 'rollback':
            return m.rollbackTo(String(o.phase ?? ''))
          case 'delegation': {
            const r = asRecord(o.receipt)
            return m.recordDelegation(String(o.phase ?? ''), {
              id: String(r.id ?? ''),
              wroteFiles: r.wroteFiles === true,
              received: r.received === true,
            })
          }
          case 'scan':
            return m.recordSecurityScan(String(o.phase ?? ''), o.status === 'clean' ? 'clean' : 'dirty')
          case 'review':
            return m.recordReview(String(o.phase ?? ''), o.verdict === 'approved' ? 'approved' : 'rejected')
          case 'iteration':
            return m.bumpIteration()
          case 'state':
            return m.state()
          default:
            return { ok: false, kind: 'UNKNOWN_OP', detail: `no phase op '${op}'` }
        }
      })()
      return result
    },
    async traceUpdate(input) {
      const o = asRecord(input)
      const t = ensureTrace()
      switch (String(o.op ?? '')) {
        case 'criterion':
          t.addCriterion(String(o.id ?? ''), typeof o.text === 'string' ? o.text : undefined)
          return { ok: true }
        case 'file':
          return { ok: t.linkFile(String(o.acId ?? ''), String(o.path ?? '')) }
        case 'test':
          return { ok: t.linkTest(String(o.acId ?? ''), String(o.test ?? '')) }
        case 'status':
          return { ok: t.setStatus(String(o.acId ?? ''), o.status as never) }
        case 'specHash':
          t.setSpecHash(String(o.hash ?? ''))
          return { ok: true }
        case 'declared':
          return { declared: t.declaredFiles() }
        case 'state':
          return t.state()
        default:
          return { ok: false, detail: `no trace op '${String(o.op)}'` }
      }
    },
    async verifyTrace() {
      const verdict = ensureTrace().verifyTraceComplete()
      if (!verdict.ok) audit('trace-incomplete', verdict.violations.map(v => v.detail).join(' · '))
      return verdict
    },
    async observe(input) {
      const o = asRecord(input)
      const written = appendObservation({
        text: String(o.text ?? ''),
        source: String(o.source ?? 'daedalus'),
        topicHint: typeof o.topicHint === 'string' ? o.topicHint : undefined,
      })
      return { written }
    },
  }
}
