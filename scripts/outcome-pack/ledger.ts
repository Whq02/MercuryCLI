import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Acceptance, Context } from './runtime.ts'

const fixture = 'not applicable: fixture' as const
const costColumns = ['uncachedInput', 'cachedInput', 'cacheWrites', 'cacheTTL', 'output', 'billedReasoning', 'retries', 'failedRequests', 'verifierCalls', 'repairCalls', 'leadJudgeCalls', 'toolCharges', 'computeCharges', 'currency', 'effectivePriceSource', 'effectivePriceDate', 'cash', 'estimatedEquivalent', 'billingClassification', 'subscriptionPeriod', 'subscriptionCost'] as const
export function writeLedger(path: string, row: Record<string, unknown>): void {
  for (const key of ['schemaVersion', 'task', 'execution', 'delivered', 'cost', 'time', 'acceptance', 'integration']) if (!(key in row)) throw new Error(`ledger missing ${key}`)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(row)}\n`)
}
export function calibrationRow(args: {
  task: { id: string; stratum: string; specHash: string; evaluatorVersion: string }
  ctx: Context; control: string; expected: string; acceptance: Acceptance; baseTree: string; buildTree: string; artifactDigest: string
  firstCandidate: string; finalCandidate: string; changed: Record<string, string>; start: string; end: string; durationMs: number; attemptId: string; stale: boolean
}): Record<string, unknown> {
  const { task, ctx, acceptance: result } = args
  return {
    schemaVersion: 1,
    task: { id: task.id, stratum: task.stratum, specificationHash: task.specHash, baseTree: args.baseTree, dependencyPins: { node: process.versions.node, bun: process.versions.bun ?? fixture, dependencies: 'none' }, evaluatorHash: task.evaluatorVersion, controlId: args.control, pairId: fixture, arm: 'calibration', randomisation: { seed: fixture, block: 'W2', order: args.control }, inclusionRule: 'six frozen calibration seams', replacementReason: null },
    execution: { runId: ctx.facts.runId, sessionId: ctx.facts.sessionId, seat: 'fixture', attemptId: args.attemptId, model: 'fixture', version: 'scriptedTurn', provider: 'fixture', billingRoad: fixture, effort: fixture, thinking: fixture, outputSettings: fixture, toolSet: ['Read', 'Edit', 'Write', 'Bash'], permissionScope: task.id === '5' ? 'hosted ask; explicit session stop' : 'sovereign scratch task', resourceIds: ctx.files, askIds: ctx.facts.effects.askIds ?? [], stopScope: ctx.facts.effects.stopScope ?? fixture, eventSequence: ctx.facts.events },
    delivered: { firstCandidateHash: args.firstCandidate, finalCandidateHash: args.finalCandidate, changedPaths: Object.keys(args.changed), contentDigests: args.changed, artifactDigest: args.artifactDigest, buildTree: args.buildTree, checkIds: [`outcome-pack/${task.id}/${args.control}`], checkedTree: result.treeDigest, checkStart: result.checkStart, checkEnd: result.checkEnd, result: result.verdict, capturedEffects: ctx.facts.effects, staleEvidence: args.stale, refusalReason: result.witness.filter(row => !row.ok).map(row => row.id), fixRetestAncestry: null },
    cost: Object.fromEntries(costColumns.map(column => [column, fixture])),
    time: { start: args.start, end: args.end, durationMs: args.durationMs, clock: 'performance.now', queue: fixture, permissionWait: fixture, providerWait: fixture, modelWork: fixture, toolCheckTime: ctx.facts.events, repair: fixture, activeHumanMinutes: fixture, finalAcceptanceTime: result.checkEnd, parkedIntervals: [], supersededIntervals: [] },
    acceptance: { verdictPerRequirement: result.witness, first: result.verdict, final: result.verdict, expected: args.expected, controlId: args.control, falseRejection: args.expected === 'accept' && result.verdict === 'refuse', falseAcceptance: args.expected === 'refuse' && result.verdict === 'accept', rootCauseId: null, severity: null, discoveryStage: 'calibration', manualAdjudication: fixture, changedRulingSource: null },
    integration: 'not applicable',
  }
}
