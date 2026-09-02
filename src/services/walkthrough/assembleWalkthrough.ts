// ============================================================================
//  walkthrough/assembleWalkthrough — evidence-backed completion artifacts
//
//
//  A walkthrough is ASSEMBLED from the authoritative owners — the run
//  kernel's snapshot, the ChangeReceipt ring (observed changed paths), the
//  evidence plane (checks with their origin honesty — 'declared' NEVER
//  reads as verified), the verification summary, git facts, journey
//  records and visual capture refs. The composer's input shape contains NO
//  transcript text — a triumphal completion story cannot be spun from
//  prose by construction. Every factual line mints a claim carrying the
//  mercury:// refs it was assembled from; the artifact stores both the
//  markdown AND the claims, so review can audit any sentence back to its
//  evidence.
// ============================================================================

import { getCwd } from '../../utils/cwd.js'
import {
  createReviewArtifact,
  type ReviewWriteResult,
} from '../../utils/artifacts/reviewStore.js'
import type {
  JourneyBodyStep,
  WalkthroughClaim,
} from '../../utils/artifacts/reviewContracts.js'
import { verificationSummary } from '../../utils/verification/verificationState.js'
import { receiptsFor } from '../changeTransaction/receipts.js'
import { gitStatus } from '../gitGraph/observe.js'
import { evidenceFor } from '../primitives/evidencePlane.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import { getJourney, listJourneys } from '../journeys/runner.js'

// ── injectable input shape (the pure composer's whole world) ────────────────

export interface WalkthroughReceiptFact {
  id: string
  toolName: string
  changedPaths: string[]
}

export interface WalkthroughCheckFact {
  id: string
  claim: string
  origin: 'observed' | 'derived' | 'declared'
  state: string
  refs: string[]
}

export interface WalkthroughJourneyFact {
  id: string
  title: string
  state: string
  steps: Array<{ id: string; title: string; state: string }>
}

export interface WalkthroughInputs {
  title: string
  objective: string | null
  runPhase: string | null
  runLifecycle: string | null
  receipts: WalkthroughReceiptFact[]
  checks: WalkthroughCheckFact[]
  verification: { state: string; detail?: string } | null
  gitFacts: { branch?: string; head?: string; dirtyPaths?: number } | null
  journeys: WalkthroughJourneyFact[]
  visualRefs: string[]
  reviewDecisions: string[]
  integrationStatus: string | null
  limitations: string[]
}

// ── the PURE composer ───────────────────────────────────────────────────────

export function composeWalkthroughBody(inputs: WalkthroughInputs): {
  markdown: string
  claims: WalkthroughClaim[]
} {
  const claims: WalkthroughClaim[] = []
  const lines: string[] = [`# ${inputs.title}`, '']

  const claim = (text: string, evidenceRefs: string[]): void => {
    claims.push({ text, evidenceRefs })
    lines.push(text)
  }

  lines.push('## Objective', '')
  if (inputs.objective) {
    claim(`- ${inputs.objective}`, ['mercury://run/current'])
  } else {
    lines.push('- (no recorded run objective)')
  }
  if (inputs.runLifecycle || inputs.runPhase) {
    claim(
      `- run state: ${inputs.runLifecycle ?? '?'}${inputs.runPhase ? ` (${inputs.runPhase})` : ''}`,
      ['mercury://run/current'],
    )
  }

  lines.push('', '## Changed areas (observed)', '')
  const allPaths = new Map<string, { count: number; refs: Set<string> }>()
  const areaOf = (p: string): string => {
    // Receipts carry ABSOLUTE paths (tool file_path inputs) — bucket by the
    // final directory pair, not a meaningless leading segment.
    const segs = p.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segs.length <= 1) return '(root)'
    return segs.slice(-3, -1).join('/') || '(root)'
  }
  for (const r of inputs.receipts) {
    for (const p of r.changedPaths) {
      const area = areaOf(p)
      const entry = allPaths.get(area) ?? { count: 0, refs: new Set() }
      entry.count++
      entry.refs.add(`mercury://receipt/${r.id}`)
      allPaths.set(area, entry)
    }
  }
  if (allPaths.size === 0) {
    lines.push('- no observed file changes (nothing in the receipt ring)')
  } else {
    for (const [area, entry] of [...allPaths.entries()].sort((a, b) => b[1].count - a[1].count)) {
      claim(`- ${area}: ${entry.count} observed change(s)`, [...entry.refs].slice(0, 8))
    }
  }

  lines.push('', '## Checks performed (exact verdicts)', '')
  if (inputs.checks.length === 0) {
    lines.push('- no recorded checks')
  } else {
    for (const c of inputs.checks) {
      const honesty =
        c.origin === 'declared' ? ' — DECLARED only, not independently observed' : ''
      claim(
        `- ${c.claim}: ${c.state}${honesty}`,
        c.refs.length > 0 ? c.refs : [`mercury://evidence/${c.id}`],
      )
    }
  }
  if (inputs.verification) {
    claim(
      `- working-tree verification: ${inputs.verification.state}${inputs.verification.detail ? ` (${inputs.verification.detail})` : ''}`,
      ['mercury://health/verification'],
    )
  }

  if (inputs.reviewDecisions.length > 0) {
    // Caller prose is NOT evidence — mark it so a stated decision can never
    // read like an assembled fact.
    lines.push('', '## Review decisions (operator-stated)', '')
    for (const d of inputs.reviewDecisions) lines.push(`- [stated] ${d}`)
  }

  if (inputs.journeys.length > 0) {
    lines.push('', '## Journeys', '')
    for (const j of inputs.journeys) {
      claim(
        `- ${j.title}: ${j.state} (${j.steps.filter(s => s.state === 'passed').length}/${j.steps.length} steps passed)`,
        [`mercury://journey/${j.id}`],
      )
    }
  }

  if (inputs.visualRefs.length > 0) {
    lines.push('', '## Visuals', '')
    for (const ref of inputs.visualRefs) {
      claim(`- capture: ${ref}`, [ref])
    }
  }

  if (inputs.gitFacts) {
    lines.push('', '## Integration state', '')
    claim(
      `- ${inputs.gitFacts.branch ?? '?'}@${(inputs.gitFacts.head ?? '').slice(0, 8) || '?'}` +
        (inputs.gitFacts.dirtyPaths !== undefined
          ? ` · ${inputs.gitFacts.dirtyPaths} dirty path(s)`
          : ''),
      ['mercury://git/status'],
    )
    if (inputs.integrationStatus) {
      claim(`- ${inputs.integrationStatus}`, ['mercury://git/status'])
    }
  }

  lines.push('', '## Honest limitations', '')
  const auto: string[] = []
  const declaredOnly = inputs.checks.filter(c => c.origin === 'declared')
  if (declaredOnly.length > 0) {
    auto.push(
      `${declaredOnly.length} check(s) are DECLARED only — no independent observation backs them`,
    )
  }
  if (inputs.verification && inputs.verification.state !== 'verified') {
    auto.push(`verification is '${inputs.verification.state}' — evidence does not cover the current tree`)
  }
  for (const j of inputs.journeys) {
    if (j.state === 'failed') auto.push(`journey '${j.title}' FAILED — see its record`)
  }
  const limitations = [...auto, ...inputs.limitations.map(l => `[stated] ${l}`)]
  if (limitations.length === 0) {
    lines.push('- none recorded beyond the evidence above')
  } else {
    for (const l of limitations) lines.push(`- ${l}`)
  }

  return { markdown: lines.join('\n'), claims }
}

// ── the live gatherer (bounded reads of the real owners) ────────────────────

const RECEIPTS_MAX = 60
const CHECKS_MAX = 40

export function gatherWalkthroughInputs(args: {
  owner: OwnerKey
  cwd?: string
  title?: string
  visualRefs?: string[]
  reviewDecisions?: string[]
  limitations?: string[]
}): WalkthroughInputs {
  const cwd = args.cwd ?? getCwd()
  const run = getRunSnapshot(args.owner)
  const runFacts = run as unknown as Record<string, unknown> | null

  const receipts: WalkthroughReceiptFact[] = receiptsFor(args.owner)
    .slice(-RECEIPTS_MAX)
    .map(r => ({
      id: r.id,
      toolName: r.toolName,
      changedPaths: [...(r.effect?.changedPaths ?? [])],
    }))

  const checks: WalkthroughCheckFact[] = evidenceFor(args.owner)
    .filter(e => e.kind === 'check' || e.kind === 'diagnostic')
    .slice(-CHECKS_MAX)
    .map(e => ({
      id: e.id,
      claim: e.claim,
      origin: e.origin,
      state: e.state,
      refs: [...e.refs],
    }))

  let verification: WalkthroughInputs['verification'] = null
  try {
    const summary = verificationSummary(cwd, { skipDigest: false })
    const s = summary as unknown as Record<string, unknown>
    if (typeof s.state === 'string') {
      verification = {
        state: s.state,
        ...(typeof s.detail === 'string' && { detail: s.detail }),
      }
    }
  } catch {
    verification = null
  }

  let gitFacts: WalkthroughInputs['gitFacts'] = null
  try {
    const status = gitStatus(cwd)
    if (!('state' in status)) {
      gitFacts = {
        branch: status.branch,
        head: status.head,
        dirtyPaths: status.files.length,
      }
    }
  } catch {
    gitFacts = null
  }

  const journeys: WalkthroughJourneyFact[] = listJourneys(args.owner).map(j => ({
    id: j.id,
    title: j.objective || j.id,
    state: j.state,
    steps: j.steps.map(s => ({ id: `${s.index}`, title: s.label, state: s.state })),
  }))

  return {
    title: args.title ?? 'Walkthrough',
    objective: typeof runFacts?.objective === 'string' ? runFacts.objective : null,
    runPhase: typeof runFacts?.phase === 'string' ? runFacts.phase : null,
    runLifecycle: typeof runFacts?.lifecycle === 'string' ? runFacts.lifecycle : null,
    receipts,
    checks,
    verification,
    gitFacts,
    journeys,
    visualRefs: args.visualRefs ?? [],
    reviewDecisions: args.reviewDecisions ?? [],
    integrationStatus: null,
    limitations: args.limitations ?? [],
  }
}

// ── artifact minting ────────────────────────────────────────────────────────

export function createWalkthroughArtifact(args: {
  owner: OwnerKey
  sessionId: string
  agentId?: string
  laneId?: string
  cwd?: string
  title?: string
  visualRefs?: string[]
  reviewDecisions?: string[]
  limitations?: string[]
  treeDigest?: string
}): ReviewWriteResult<{ id: string; version: number }> {
  const inputs = gatherWalkthroughInputs(args)
  const { markdown, claims } = composeWalkthroughBody(inputs)
  const evidenceRefs = [...new Set(claims.flatMap(c => c.evidenceRefs))].slice(0, 100)
  return createReviewArtifact({
    kind: 'walkthrough',
    title: inputs.title,
    producer: {
      sessionId: args.sessionId,
      ...(args.agentId !== undefined && { agentId: args.agentId }),
      ...(args.laneId !== undefined && { laneId: args.laneId }),
    },
    workspace: {
      roots: [args.cwd ?? getCwd()],
      ...(args.treeDigest !== undefined && { treeDigest: args.treeDigest }),
    },
    body: { kind: 'walkthrough', markdown, claims },
    evidenceRefs,
    initialStatus: 'ready-for-review',
  })
}

// ── the structured visual journey (brief's browser evidence) ─────────────

export function createVisualJourneyArtifact(args: {
  owner: OwnerKey
  journeyId: string
  sessionId: string
  captures?: Array<{
    stepId: string
    beforeRef?: string
    afterRef?: string
    targetRef?: string
    delta?: string
  }>
  cwd?: string
  treeDigest?: string
}): ReviewWriteResult<{ id: string; version: number }> {
  const record = getJourney(args.owner, args.journeyId)
  if (!record) {
    return { ok: false, reason: `no journey '${args.journeyId}' for this owner` }
  }
  const byStep = new Map((args.captures ?? []).map(c => [c.stepId, c]))
  const steps: JourneyBodyStep[] = record.steps.map(s => {
    const cap = byStep.get(`${s.index}`) ?? byStep.get(s.label)
    return {
      id: `${s.index}`,
      title: s.label,
      result: `${s.state}${s.detail ? ` — ${s.detail}` : ''}`,
      ...(cap?.beforeRef !== undefined && { beforeRef: cap.beforeRef }),
      ...(cap?.afterRef !== undefined && { afterRef: cap.afterRef }),
      ...(cap?.targetRef !== undefined && { targetRef: cap.targetRef }),
      ...(cap?.delta !== undefined && { delta: cap.delta }),
    }
  })
  return createReviewArtifact({
    kind: 'journey',
    title: record.objective || record.id,
    producer: { sessionId: args.sessionId },
    workspace: {
      roots: [args.cwd ?? getCwd()],
      ...(args.treeDigest !== undefined && { treeDigest: args.treeDigest }),
    },
    body: { kind: 'journey', steps },
    evidenceRefs: [`mercury://journey/${record.id}`],
    initialStatus: 'ready-for-review',
  })
}
