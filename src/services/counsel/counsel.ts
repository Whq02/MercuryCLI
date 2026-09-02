
import { createHash } from 'node:crypto'
import { receiptCursor, receiptsSince } from '../changeTransaction/receipts.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { evidenceRecordsFor } from '../../utils/verification/verificationState.js'
import { logForDebugging } from '../../utils/debug.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export type CounselMode = 'off' | 'manual' | 'auto'

export function counselMode(): CounselMode {
  const raw = (flagEnv('MERCURY_COUNSEL') ?? '').trim().toLowerCase()
  if (raw === 'auto' || raw === 'after-change-batch') return 'auto'
  if (raw === 'manual' || isEnvTruthy(raw)) return 'manual'
  return 'off'
}

export function counselConfigProblem(): string | null {
  const raw = (flagEnv('MERCURY_COUNSEL') ?? '').trim()
  if (raw === '') return null
  if (counselMode() !== 'off') return null
  return `MERCURY_COUNSEL is set to '${raw}', which is not a recognised mode — use =manual or =auto (counsel stays off)`
}

export function counselEnabled(): boolean {
  return counselMode() !== 'off'
}

export const COUNSEL_BATCH_SIZE = 5

export interface CounselFinding {
  summary: string
  path?: string
  refs?: string[]
}

export interface CounselResult {
  disposition: 'approve' | 'concerns' | 'block' | 'no-new-evidence' | 'unavailable'
  findings: CounselFinding[]
  missingEvidence: string[]
  recommendedNextAction?: string
  reviewedSeqs: number[]
  duplicatesDropped: number
  model?: string
  durationMs: number
  at: number
}

export type CounselRunner = (prompt: string) => Promise<{ text: string; model?: string }>

interface CounselState {
  lastReviewedSeq: number
  seenFindings: Set<string>
  lastResult: CounselResult | null
  inFlight: boolean
}

const store = new OwnerScopedStore<CounselState>({
  name: 'counsel',
  create: () => ({
    lastReviewedSeq: 0,
    seenFindings: new Set(),
    lastResult: null,
    inFlight: false,
  }),
  cap: 32,
})
registerOwnerScopedStore(store)

export function counselStatus(owner: OwnerKey): {
  mode: CounselMode
  lastResult: CounselResult | null
  pendingReceipts: number
} {
  const state = store.peek(owner)
  return {
    mode: counselMode(),
    lastResult: state?.lastResult ?? null,
    pendingReceipts: receiptCursor(owner) - (state?.lastReviewedSeq ?? 0),
  }
}

function findingKey(f: CounselFinding): string {
  const normalized = `${f.summary.toLowerCase().replace(/\s+/g, ' ').trim()}::${f.path ?? ''}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function buildReviewPrompt(owner: OwnerKey, cwd: string): {
  prompt: string
  reviewedSeqs: number[]
} | null {
  const state = store.get(owner)
  const window = receiptsSince(owner, state.lastReviewedSeq)
  if (window.length === 0) return null
  const run = getRunSnapshot(owner)
  const evidence = evidenceRecordsFor(owner)
  const lines: string[] = [
    'You are Mercury Counsel — a bounded second look over OBSERVED changes. Review the evidence below and answer with ONE JSON object only (no prose): {"disposition":"approve"|"concerns"|"block","findings":[{"summary":"…","path":"…"}],"missingEvidence":["…"],"recommendedNextAction":"…"}. Block ONLY for likely-broken or unsafe changes. Do not restate the changes; findings must be concrete and actionable. An empty findings list with approve is a fine answer.',
    '',
    run ? `objective: ${run.objective || '(none recorded)'}` : 'objective: (no active run)',
    '',
    `observed change receipts (${window.length}, seqs ${window[0]!.seq}–${window[window.length - 1]!.seq}):`,
    ...window.map(
      r =>
        `  #${r.seq} ${r.effect.operation} ${r.effect.outcome} — ${r.effect.changedPaths.join(', ') || '(no paths)'} · ${r.effect.evidence.slice(0, 120)}`,
    ),
    '',
    evidence.length > 0
      ? `verification evidence:\n${evidence
          .slice(-5)
          .map(e => `  ${e.ok ? 'PASS' : 'FAIL'} ${e.coverage} (${e.command.slice(0, 80)})`)
          .join('\n')}`
      : 'verification evidence: none recorded in this window',
  ]
  return { prompt: lines.join('\n'), reviewedSeqs: window.map(r => r.seq) }
}

function parseRunnerOutput(text: string): {
  disposition: 'approve' | 'concerns' | 'block'
  findings: CounselFinding[]
  missingEvidence: string[]
  recommendedNextAction?: string
} | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const disposition = raw.disposition
    if (disposition !== 'approve' && disposition !== 'concerns' && disposition !== 'block') {
      return null
    }
    const findings = Array.isArray(raw.findings)
      ? (raw.findings as Record<string, unknown>[])
          .filter(f => typeof f?.summary === 'string')
          .slice(0, 10)
          .map(f => ({
            summary: String(f.summary).slice(0, 300),
            ...(typeof f.path === 'string' ? { path: f.path } : {}),
            ...(Array.isArray(f.refs) ? { refs: (f.refs as string[]).slice(0, 5) } : {}),
          }))
      : []
    const missingEvidence = Array.isArray(raw.missingEvidence)
      ? (raw.missingEvidence as unknown[]).filter((m): m is string => typeof m === 'string').slice(0, 5)
      : []
    return {
      disposition,
      findings,
      missingEvidence,
      ...(typeof raw.recommendedNextAction === 'string'
        ? { recommendedNextAction: raw.recommendedNextAction.slice(0, 300) }
        : {}),
    }
  } catch {
    return null
  }
}

export async function runCounsel(
  owner: OwnerKey,
  cwd: string,
  runner: CounselRunner,
): Promise<CounselResult> {
  const startedAt = Date.now()
  const state = store.get(owner)
  const built = buildReviewPrompt(owner, cwd)
  if (!built) {
    const result: CounselResult = {
      disposition: 'no-new-evidence',
      findings: [],
      missingEvidence: [],
      reviewedSeqs: [],
      duplicatesDropped: 0,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    }
    state.lastResult = result
    return result
  }
  let text: string
  let model: string | undefined
  try {
    const out = await runner(built.prompt)
    text = out.text
    model = out.model
  } catch (e) {
    const result: CounselResult = {
      disposition: 'unavailable',
      findings: [],
      missingEvidence: [`counsel runner failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`],
      reviewedSeqs: [],
      duplicatesDropped: 0,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    }
    state.lastResult = result
    return result
  }
  const parsed = parseRunnerOutput(text)
  if (!parsed) {
    const result: CounselResult = {
      disposition: 'unavailable',
      findings: [],
      missingEvidence: ['counsel output was not parseable — the window stays un-reviewed'],
      reviewedSeqs: [],
      duplicatesDropped: 0,
      ...(model ? { model } : {}),
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    }
    state.lastResult = result
    return result
  }
  const fresh: CounselFinding[] = []
  let dropped = 0
  for (const finding of parsed.findings) {
    const key = findingKey(finding)
    if (state.seenFindings.has(key)) {
      dropped++
      continue
    }
    state.seenFindings.add(key)
    fresh.push(finding)
  }
  state.lastReviewedSeq = built.reviewedSeqs[built.reviewedSeqs.length - 1]!
  const result: CounselResult = {
    disposition: parsed.disposition,
    findings: fresh,
    missingEvidence: parsed.missingEvidence,
    ...(parsed.recommendedNextAction
      ? { recommendedNextAction: parsed.recommendedNextAction }
      : {}),
    reviewedSeqs: built.reviewedSeqs,
    duplicatesDropped: dropped,
    ...(model ? { model } : {}),
    durationMs: Date.now() - startedAt,
    at: Date.now(),
  }
  state.lastResult = result
  return result
}

export function formatCounselCard(result: CounselResult): string {
  if (result.disposition === 'no-new-evidence') {
    return 'counsel: no new evidence since the last review — nothing reviewed.'
  }
  if (result.disposition === 'unavailable') {
    return `counsel: UNAVAILABLE (${result.missingEvidence[0] ?? 'runner failed'}) — execution continues.`
  }
  const head = `counsel: ${result.disposition.toUpperCase()} · reviewed receipts ${result.reviewedSeqs[0]}–${result.reviewedSeqs[result.reviewedSeqs.length - 1]} (${result.reviewedSeqs.length})${result.model ? ` · ${result.model}` : ''} · ${result.durationMs}ms${result.duplicatesDropped > 0 ? ` · ${result.duplicatesDropped} duplicate finding(s) suppressed` : ''}`
  if (result.findings.length === 0 && result.missingEvidence.length === 0) {
    return head
  }
  return [
    `<counsel disposition="${result.disposition}">`,
    head,
    ...result.findings.map(f => `  · ${f.summary}${f.path ? ` (${f.path})` : ''}`),
    ...result.missingEvidence.map(m => `  ? missing evidence: ${m}`),
    ...(result.recommendedNextAction ? [`  → ${result.recommendedNextAction}`] : []),
    '</counsel>',
  ].join('\n')
}


export function maybeAutoCounsel(
  owner: OwnerKey,
  cwd: string,
  runner: CounselRunner,
  deliver: (card: string) => void,
): boolean {
  if (counselMode() !== 'auto') return false
  const state = store.get(owner)
  if (state.inFlight) return false
  const pending = receiptCursor(owner) - state.lastReviewedSeq
  if (pending < COUNSEL_BATCH_SIZE) return false
  state.inFlight = true
  void runCounsel(owner, cwd, runner)
    .then(result => {
      if (
        result.disposition === 'approve' &&
        result.findings.length === 0 &&
        result.missingEvidence.length === 0
      ) {
        return
      }
      if (result.disposition === 'no-new-evidence') return
      deliver(formatCounselCard(result))
    })
    .catch(err => logForDebugging(`counsel auto run failed: ${String(err)}`))
    .finally(() => {
      state.inFlight = false
    })
  return true
}

export async function defaultCounselRunner(
  prompt: string,
): Promise<{ text: string; model?: string }> {
  const { getLastCacheSafeParams } = await import('../../utils/forkedAgent.js')
  const { runSideQuestion } = await import('../../utils/sideQuestion.js')
  const cacheSafeParams = getLastCacheSafeParams()
  if (!cacheSafeParams) {
    throw new Error('no completed model turn yet — counsel has no conversation to fork from')
  }
  const result = await runSideQuestion({ question: prompt, cacheSafeParams })
  if (result.response === null) {
    throw new Error('the counsel side-question returned no response')
  }
  return { text: result.response }
}

let autoRunner: CounselRunner = prompt => defaultCounselRunner(prompt)

export function _setAutoRunnerForTesting(runner: CounselRunner | null): void {
  autoRunner = runner ?? (prompt => defaultCounselRunner(prompt))
}

let observerInstalled = false
export function installCounselObserver(): void {
  if (observerInstalled) return
  observerInstalled = true
  void import('../run/effectObserver.js').then(({ subscribeToolTerminal }) => {
    subscribeToolTerminal(event => {
      if (counselMode() !== 'auto') return
      if (!event.effect || event.effect.changedPaths.length === 0) return
      maybeAutoCounsel(event.owner, event.cwd, autoRunner, card => {
        void import('../../utils/messageQueueManager.js').then(({ enqueuePendingNotification }) => {
          enqueuePendingNotification({ value: card, mode: 'task-notification' } as never)
        })
      })
    })
  })
}
installCounselObserver()

export function _resetCounselForTesting(): void {
  store.clearAllForShutdown()
}
