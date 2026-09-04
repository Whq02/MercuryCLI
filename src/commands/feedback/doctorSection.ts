import { readFileSync } from 'node:fs'
import {
  decodeLastCertSummary,
  flattenChecks,
  countByStatus,
  type HealthCertificate,
  type HealthCheck,
  type HealthStatus,
  type LastCertSummary,
} from '../../utils/healthCertCore.js'
import { lastCertPath, runHealthReport } from '../../utils/healthReport.js'

export const DOCTOR_DEADLINE_MS = 20_000
export const FRESH_CERT_MS = 10 * 60_000

const ATTENTION: readonly HealthStatus[] = ['fail', 'stale', 'warn']

export interface DoctorSectionOptions {
  deadlineMs?: number
  nowMs?: number
  signal?: AbortSignal
}

function summaryLine(counts: Record<HealthStatus, number>, verdict: string, source: string): string {
  return `verdict ${verdict} · ok ${counts.ok} · warn ${counts.warn} · fail ${counts.fail} · stale ${counts.stale} · unknown ${counts.unknown} · ${source}`
}

function attentionRows(rows: Array<{ label: string; status: HealthStatus; evidence: string; fix?: string }>): string[] {
  if (rows.length === 0) return ['- no failing or warning rows']
  return rows.map(r => `- ${r.label}: ${r.status} — ${r.evidence}${r.fix ? ` · fix: ${r.fix}` : ''}`)
}

export function renderLastCertSection(summary: LastCertSummary): string {
  const line = summaryLine(summary.counts, summary.verdict, `certificate recorded ${summary.ranAt} (v${summary.version})`)
  return [line, ...attentionRows(summary.attention)].join('\n')
}

export function renderCertSection(cert: HealthCertificate): string {
  const checks = flattenChecks(cert)
  const rows: HealthCheck[] = []
  for (const sev of ATTENTION) for (const c of checks) if (c.status === sev) rows.push(c)
  const line = summaryLine(
    countByStatus(checks),
    cert.verdict,
    `fast run ${cert.ranAt} in ${cert.durationMs} ms (v${cert.version})`,
  )
  return [line, ...attentionRows(rows)].join('\n')
}

export function readFreshLastCert(nowMs: number, freshMs = FRESH_CERT_MS): LastCertSummary | null {
  try {
    const summary = decodeLastCertSummary(JSON.parse(readFileSync(lastCertPath(), 'utf8')))
    if (summary === null) return null
    const age = nowMs - Date.parse(summary.ranAt)
    return age >= 0 && age <= freshMs ? summary : null
  } catch {
    return null
  }
}

function reasonText(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : String(reason ?? 'aborted')
}

export async function runDoctorBounded(deadlineMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return `doctor: not run — ${reasonText(signal.reason)}`
  const controller = new AbortController()
  const onOuter = (): void => controller.abort(signal?.reason ?? new Error('the report was cancelled'))
  signal?.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`the fast doctor run passed its ${deadlineMs} ms deadline`)),
    deadlineMs,
  )
  try {
    const cert = await Promise.race([
      runHealthReport({ depth: 'fast', signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      }),
    ])
    return renderCertSection(cert)
  } catch (error) {
    return `doctor: not run — ${reasonText(error)}`
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuter)
    if (!controller.signal.aborted) controller.abort(new Error('doctor section settled'))
  }
}

export async function gatherDoctorSection(opts: DoctorSectionOptions = {}): Promise<string> {
  const fresh = readFreshLastCert(opts.nowMs ?? Date.now())
  if (fresh !== null) return renderLastCertSection(fresh)
  return runDoctorBounded(opts.deadlineMs ?? DOCTOR_DEADLINE_MS, opts.signal)
}
