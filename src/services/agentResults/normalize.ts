
import { receiptsFor } from '../changeTransaction/receipts.js'
import { evidenceFor } from '../primitives/evidencePlane.js'
import { processOwnerForLane } from '../run/resolveOwner.js'
import { storeArtifact } from '../../utils/artifacts/store.js'
import { evidenceRecordsFor } from '../../utils/verification/verificationState.js'
import {
  AGENT_ENVELOPE_VERSION,
  declaredEnvelopeSchema,
  ENVELOPE_TAG,
  type AgentResultEnvelope,
  type DeclaredEnvelope,
  type EnvelopeCheck,
} from './contracts.js'

const SUMMARY_CLIP = 500

export interface NormalizeInput {
  agentId: string
  agentType?: string
  status: 'completed' | 'failed' | 'stopped'
  finalText: string
  usage?: { totalTokens?: number; toolUseCount?: number; durationMs?: number }
}

interface ParsedDeclaration {
  declared: DeclaredEnvelope | null
  malformedRaw: string | null
  prose: string
}

export function parseDeclaration(finalText: string): ParsedDeclaration {
  const open = `<${ENVELOPE_TAG}>`
  const close = `</${ENVELOPE_TAG}>`
  const start = finalText.lastIndexOf(open)
  if (start === -1) return { declared: null, malformedRaw: null, prose: finalText }
  const end = finalText.indexOf(close, start)
  if (end === -1) return { declared: null, malformedRaw: null, prose: finalText }
  const raw = finalText.slice(start + open.length, end).trim()
  const prose = (finalText.slice(0, start) + finalText.slice(end + close.length)).trim()
  try {
    const parsed = declaredEnvelopeSchema.safeParse(JSON.parse(raw))
    if (parsed.success) {
      return { declared: parsed.data, malformedRaw: null, prose }
    }
    return { declared: null, malformedRaw: raw, prose }
  } catch {
    return { declared: null, malformedRaw: raw, prose }
  }
}

function clipSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return '(no output)'
  return collapsed.length > SUMMARY_CLIP ? collapsed.slice(0, SUMMARY_CLIP) + '…' : collapsed
}

export async function buildAgentResultEnvelope(
  input: NormalizeInput,
): Promise<AgentResultEnvelope> {
  const { declared, malformedRaw, prose } = parseDeclaration(input.finalText)

  const owner = processOwnerForLane(input.agentId)
  const receipts = receiptsFor(owner)
  const changedPaths = [
    ...new Set(
      receipts
        .filter(r => r.effect.outcome === 'succeeded')
        .flatMap(r => r.effect.changedPaths),
    ),
  ]
  const failedAttempts = receipts.filter(
    r => r.effect.outcome === 'failed' || r.effect.outcome === 'indeterminate',
  ).length

  const evidence = evidenceRecordsFor(owner)
  const checks: EnvelopeCheck[] = []
  const matched = new Set<number>()
  for (const name of declared?.checks ?? []) {
    const idx = evidence.findIndex(
      (r, i) => !matched.has(i) && (r.command.includes(name) || r.coverage.includes(name)),
    )
    if (idx === -1) {
      checks.push({ name, state: 'unknown', detail: 'declared but not observed' })
    } else {
      matched.add(idx)
      const r = evidence[idx]!
      checks.push({
        name,
        state: r.ok ? 'observed' : 'failed',
        detail: r.coverage,
      })
    }
  }
  evidence.forEach((r, i) => {
    if (!matched.has(i)) {
      checks.push({
        name: r.coverage,
        state: r.ok ? 'observed' : 'failed',
        detail: r.command.slice(0, 120),
      })
    }
  })

  let malformedDeclarationRef: string | undefined
  if (malformedRaw !== null) {
    const { id } = await storeArtifact({
      scope: 'agent-results',
      name: `malformed-envelope-${input.agentId}`,
      content: malformedRaw,
      kind: 'malformed-declaration',
    })
    if (id) malformedDeclarationRef = `mercury://artifact/agent-results/${id}`
  }

  return {
    version: AGENT_ENVELOPE_VERSION,
    agentId: input.agentId,
    ...(input.agentType ? { agentType: input.agentType } : {}),
    status: input.status,
    summary: declared?.summary ?? clipSummary(prose),
    findings: declared?.findings ?? [],
    changedPaths,
    failedAttempts,
    artifacts: malformedDeclarationRef ? [malformedDeclarationRef] : [],
    checks,
    unresolved: declared?.unresolved ?? [],
    ...(declared?.recommendedNextAction
      ? { recommendedNextAction: declared.recommendedNextAction }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    fullOutputRef: `mercury://agent/${input.agentId}`,
    ...(() => {
      const refs = evidenceFor(owner)
        .filter(r => r.origin === 'observed' && r.state === 'present')
        .slice(-16)
        .map(r => `mercury://evidence/${r.id}`)
      return refs.length > 0 ? { evidenceRefs: refs } : {}
    })(),
    ...(malformedDeclarationRef ? { malformedDeclarationRef } : {}),
  }
}

export function formatEnvelopeBlock(envelope: AgentResultEnvelope): string {
  const lines: string[] = [
    `<envelope v="${envelope.version}" status="${envelope.status}">`,
    `summary: ${envelope.summary}`,
  ]
  if (envelope.findings.length > 0) {
    lines.push(`findings: ${envelope.findings.map(f => `· ${f}`).join(' ')}`)
  }
  lines.push(
    envelope.changedPaths.length > 0
      ? `changed (observed): ${envelope.changedPaths.slice(0, 20).join(', ')}${envelope.changedPaths.length > 20 ? ` (+${envelope.changedPaths.length - 20} more)` : ''}`
      : 'changed (observed): none',
  )
  if (envelope.failedAttempts > 0) {
    lines.push(`failed/indeterminate attempts (observed): ${envelope.failedAttempts}`)
  }
  if (envelope.checks.length > 0) {
    lines.push(`checks: ${envelope.checks.map(c => `${c.name}:${c.state}`).join(' · ')}`)
  }
  if (envelope.unresolved.length > 0) {
    lines.push(`unresolved: ${envelope.unresolved.map(u => `· ${u}`).join(' ')}`)
  }
  if (envelope.recommendedNextAction) {
    lines.push(`next: ${envelope.recommendedNextAction}`)
  }
  if (envelope.malformedDeclarationRef) {
    lines.push(`(the agent's structured declaration was malformed — raw preserved at ${envelope.malformedDeclarationRef})`)
  }
  lines.push(
    `full output: ${envelope.fullOutputRef} · final report: Inspect ${envelope.fullOutputRef}?child=report`,
    '</envelope>',
  )
  return lines.join('\n')
}
