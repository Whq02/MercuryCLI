
export type HealthStatus = 'ok' | 'warn' | 'fail' | 'stale' | 'unknown' | 'off' | 'info'

export type CertVerdict = 'certified' | 'caution' | 'fault'

export type RemedyClass = 'safe' | 'destructive'

export interface RemedyOutcome {
  ok: boolean
  note: string
}

export interface HealthRemedy {
  plan: string
  class: RemedyClass
  apply: () => Promise<RemedyOutcome>
  verify: () => Promise<RemedyOutcome>
}

export type HealthProbeKind = 'functional' | 'configuration'
export type HealthDepth = 'fast' | 'deep'

export interface HealthCheck {
  id: string
  label: string
  status: HealthStatus
  evidence: string
  detail?: string
  fix?: string
  link?: string
  remedy?: HealthRemedy
  probe?: HealthProbeKind
  depth?: HealthDepth
  durationMs?: number
  evidenceAt?: number
}

export interface HealthSection {
  id: string
  title: string
  checks: HealthCheck[]
}

export interface CertHead {
  sha: string | null
  branch: string | null
  dirty: boolean | null
}

export interface NodeRuntimeFacts {
  observed: string | null
  label: string
  range: string
  verdict: 'supported' | 'too-old' | 'unqualified-major' | 'prerelease' | 'invalid'
}

export interface HealthCertificate {
  verdict: CertVerdict
  sections: HealthSection[]
  ranAt: string
  head: CertHead
  version: string
  durationMs: number
  depth?: HealthDepth
  nodeRuntime?: NodeRuntimeFacts
}


export function verdictFromStatuses(statuses: readonly HealthStatus[]): CertVerdict {
  if (statuses.includes('fail')) return 'fault'
  if (statuses.some(s => s === 'warn' || s === 'stale' || s === 'unknown')) return 'caution'
  return 'certified'
}

export function flattenChecks(cert: Pick<HealthCertificate, 'sections'>): HealthCheck[] {
  return cert.sections.flatMap(s => s.checks)
}

export function filterCertificateToCheck<
  T extends Pick<HealthCertificate, 'sections' | 'verdict'>,
>(cert: T, checkId: string): T | null {
  const sections = cert.sections
    .map(section => ({ ...section, checks: section.checks.filter(c => c.id === checkId) }))
    .filter(section => section.checks.length > 0)
  if (sections.length === 0) return null
  return {
    ...cert,
    sections,
    verdict: verdictFromStatuses(sections.flatMap(s => s.checks.map(c => c.status))),
  }
}

export function countByStatus(checks: readonly HealthCheck[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = {
    ok: 0,
    warn: 0,
    fail: 0,
    stale: 0,
    unknown: 0,
    off: 0,
    info: 0,
  }
  for (const c of checks) counts[c.status]++
  return counts
}

export function isFixable(check: Pick<HealthCheck, 'status' | 'remedy'>): boolean {
  return (
    check.remedy !== undefined &&
    (check.status === 'fail' || check.status === 'warn' || check.status === 'stale')
  )
}

export function remedyPermitted(remedy: Pick<HealthRemedy, 'class'>, opts: { yes: boolean }): boolean {
  return remedy.class === 'safe' || opts.yes
}

const ACTION_SEVERITY: readonly HealthStatus[] = ['fail', 'stale', 'warn', 'unknown']

export function nextActions(
  checks: readonly HealthCheck[],
  max = 3,
): Array<Pick<HealthCheck, 'label' | 'fix' | 'status'>> {
  const ranked: HealthCheck[] = []
  for (const sev of ACTION_SEVERITY) {
    for (const c of checks) if (c.status === sev && c.fix) ranked.push(c)
  }
  return ranked.slice(0, max).map(({ label, fix, status }) => ({ label, fix, status }))
}


export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'clock skew'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function sha7(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '???????'
}


export interface GateVerdict {
  ok: boolean
  pass: string[]
  fail: string[]
  ranAt: string
  headSha: string | null
  dirty: boolean
  durationS: number
  treeSha: string | null
}

export function decodeGateVerdict(raw: unknown): GateVerdict | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.ok !== 'boolean') return null
  if (typeof o.ranAt !== 'string' || Number.isNaN(Date.parse(o.ranAt))) return null
  const strArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(x => typeof x === 'string')
  if (!strArr(o.pass) || !strArr(o.fail)) return null
  return {
    ok: o.ok,
    pass: o.pass,
    fail: o.fail,
    ranAt: o.ranAt,
    headSha: typeof o.headSha === 'string' && o.headSha.length > 0 ? o.headSha : null,
    dirty: o.dirty === true,
    durationS: typeof o.durationS === 'number' && Number.isFinite(o.durationS) ? o.durationS : 0,
    treeSha: typeof o.treeSha === 'string' && o.treeSha.length > 0 ? o.treeSha : null,
  }
}

export function interpretGateVerdict(
  v: GateVerdict | null,
  head: Pick<CertHead, 'sha' | 'dirty'> & { treeSha?: string | null },
  nowMs: number,
): Pick<HealthCheck, 'status' | 'evidence' | 'fix'> {
  if (v === null) {
    return {
      status: 'info',
      evidence: 'no gate verdict recorded — the proof suite (a developer instrument) has not been run here',
      fix: 'Optional: `bash scripts/run-all-suites.sh` records a gate verdict for this checkout.',
    }
  }
  const total = v.pass.length + v.fail.length
  const age = formatAge(nowMs - Date.parse(v.ranAt))
  const at = `@ ${sha7(v.headSha)} · ${age}`
  if (!v.ok) {
    const redHeadMoved = v.headSha !== null && head.sha !== null && v.headSha !== head.sha
    const redTreeMoved =
      v.treeSha !== null && head.treeSha != null && v.treeSha !== head.treeSha
    if (redHeadMoved || redTreeMoved) {
      return {
        status: 'stale',
        evidence: `verdict.json: ${v.fail.length}/${total} suites were RED (${v.fail.join(', ')}) ${at} — recorded against a superseded ${redHeadMoved ? `commit (now ${sha7(head.sha)})` : 'working tree'}`,
        fix: 'Re-run `bash scripts/run-all-suites.sh` against the current state.',
      }
    }
    return {
      status: 'fail',
      evidence: `verdict.json: ${v.fail.length}/${total} suites RED (${v.fail.join(', ')}) ${at}`,
      fix: 'Fix the red suites, then re-run `bash scripts/run-all-suites.sh`.',
    }
  }
  if (v.treeSha !== null && head.treeSha != null && v.treeSha === head.treeSha) {
    return {
      status: 'ok',
      evidence: `verdict.json: ${total} suites green ${at} · content-bound — the gated tree is exactly this working tree (${sha7(v.treeSha)})`,
    }
  }
  const headMoved = v.headSha !== null && head.sha !== null && v.headSha !== head.sha
  if (headMoved) {
    return {
      status: 'stale',
      evidence: `verdict.json: ${total} suites green ${at} — but HEAD has moved to ${sha7(head.sha)}`,
      fix: 'Re-run `bash scripts/run-all-suites.sh` to certify the current commit.',
    }
  }
  const dirtiness = v.dirty || head.dirty === true
  if (dirtiness) {
    const which =
      v.dirty && head.dirty ? 'the tree was and is dirty' : v.dirty ? 'the tree was dirty at run time' : 'the tree has changed since'
    return {
      status: 'stale',
      evidence: `verdict.json: ${total} suites green ${at} — ${which}: uncommitted edits are not covered`,
      fix: 'Re-run `bash scripts/run-all-suites.sh` to cover the working-tree edits.',
    }
  }
  const shaNote = v.headSha === null || head.sha === null ? ' (no commit recorded — sha comparison skipped)' : ''
  return {
    status: 'ok',
    evidence: `verdict.json: ${total} suites green ${at} · tree clean${shaNote}`,
  }
}


export interface LastCertSummary {
  verdict: CertVerdict
  ranAt: string
  head: CertHead
  version: string
  counts: Record<HealthStatus, number>
  attention: Array<{ id: string; label: string; status: HealthStatus; evidence: string }>
}

export const ATTENTION_ROWS_MAX = 12
const ATTENTION_SEVERITY: readonly HealthStatus[] = ['fail', 'stale', 'warn']

export function attentionRows(
  checks: readonly HealthCheck[],
): LastCertSummary['attention'] {
  const rows: LastCertSummary['attention'] = []
  for (const sev of ATTENTION_SEVERITY) {
    for (const c of checks) {
      if (c.status === sev) rows.push({ id: c.id, label: c.label, status: c.status, evidence: c.evidence })
    }
  }
  return rows.slice(0, ATTENTION_ROWS_MAX)
}

export function summarizeCert(cert: HealthCertificate): LastCertSummary {
  const checks = flattenChecks(cert)
  return {
    verdict: cert.verdict,
    ranAt: cert.ranAt,
    head: cert.head,
    version: cert.version,
    counts: countByStatus(checks),
    attention: attentionRows(checks),
  }
}

export function decodeLastCertSummary(raw: unknown): LastCertSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.verdict !== 'certified' && o.verdict !== 'caution' && o.verdict !== 'fault') return null
  if (typeof o.ranAt !== 'string' || Number.isNaN(Date.parse(o.ranAt))) return null
  const head =
    o.head && typeof o.head === 'object'
      ? (o.head as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  const counts =
    o.counts && typeof o.counts === 'object' ? (o.counts as Record<string, unknown>) : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const isStatus = (v: unknown): v is HealthStatus =>
    v === 'ok' || v === 'warn' || v === 'fail' || v === 'stale' || v === 'unknown' || v === 'off' || v === 'info'
  const attention = Array.isArray(o.attention)
    ? o.attention.flatMap(row => {
        const r = row as Record<string, unknown>
        return r &&
          typeof r === 'object' &&
          typeof r.id === 'string' &&
          typeof r.label === 'string' &&
          isStatus(r.status) &&
          typeof r.evidence === 'string'
          ? [{ id: r.id, label: r.label, status: r.status, evidence: r.evidence }]
          : []
      })
    : []
  return {
    verdict: o.verdict,
    ranAt: o.ranAt,
    head: {
      sha: typeof head.sha === 'string' ? head.sha : null,
      branch: typeof head.branch === 'string' ? head.branch : null,
      dirty: typeof head.dirty === 'boolean' ? head.dirty : null,
    },
    version: typeof o.version === 'string' ? o.version : '?',
    counts: {
      ok: num(counts.ok),
      warn: num(counts.warn),
      fail: num(counts.fail),
      stale: num(counts.stale),
      unknown: num(counts.unknown),
      off: num(counts.off),
      info: num(counts.info),
    },
    attention,
  }
}

export const CERT_CHIP_STALE_MS = 24 * 60 * 60 * 1000

export interface CertChip {
  verdict: CertVerdict | null
  ageMs: number | null
  ageLabel: string
  stale: boolean
}

export function chipFromLastCert(summary: LastCertSummary | null, nowMs: number): CertChip {
  if (summary === null) {
    return { verdict: null, ageMs: null, ageLabel: 'never', stale: false }
  }
  const ageMs = nowMs - Date.parse(summary.ranAt)
  return {
    verdict: summary.verdict,
    ageMs,
    ageLabel: formatAge(ageMs),
    stale: !Number.isFinite(ageMs) || ageMs < 0 || ageMs > CERT_CHIP_STALE_MS,
  }
}


export interface PreflightSummary {
  verdict: CertVerdict
  ranAt: string
  failing: Array<{ id: string; evidence: string }>
  degraded: Array<{ id: string; status: HealthStatus; evidence: string }>
  durationMs: number
  via: 'preflight'
}

export function decodePreflightSummary(raw: unknown): PreflightSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.via !== 'preflight') return null
  if (o.verdict !== 'certified' && o.verdict !== 'caution' && o.verdict !== 'fault') return null
  if (typeof o.ranAt !== 'string' || Number.isNaN(Date.parse(o.ranAt))) return null
  const failing = Array.isArray(o.failing)
    ? o.failing.flatMap(f =>
        f &&
        typeof f === 'object' &&
        typeof (f as Record<string, unknown>).id === 'string' &&
        typeof (f as Record<string, unknown>).evidence === 'string'
          ? [{ id: (f as { id: string }).id, evidence: (f as { evidence: string }).evidence }]
          : [],
      )
    : []
  const isPreStatus = (v: unknown): v is HealthStatus =>
    v === 'ok' || v === 'warn' || v === 'fail' || v === 'stale' || v === 'unknown' || v === 'off' || v === 'info'
  const degraded = Array.isArray(o.degraded)
    ? o.degraded.flatMap(f => {
        const r = f as Record<string, unknown>
        return r &&
          typeof r === 'object' &&
          typeof r.id === 'string' &&
          isPreStatus(r.status) &&
          typeof r.evidence === 'string'
          ? [{ id: r.id, status: r.status, evidence: r.evidence }]
          : []
      })
    : []
  return {
    verdict: o.verdict,
    ranAt: o.ranAt,
    failing,
    degraded,
    durationMs:
      typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) ? o.durationMs : 0,
    via: 'preflight',
  }
}

export interface CertChipAlert {
  source: 'preflight' | 'gate'
  tone: 'fault' | 'ok'
  text: string
}

export interface ComposedCertChip extends CertChip {
  alert?: CertChipAlert
}

export function composeChip(
  summary: LastCertSummary | null,
  preflight: PreflightSummary | null,
  gate: GateVerdict | null,
  nowMs: number,
): ComposedCertChip {
  const base = chipFromLastCert(summary, nowMs)
  const certAt = summary ? Date.parse(summary.ranAt) : Number.NEGATIVE_INFINITY
  const stampOf = (iso: string): number | null => {
    const t = Date.parse(iso)
    return Number.isFinite(t) && t > certAt && t <= nowMs + 60_000 ? t : null
  }
  const pfAt =
    preflight && preflight.verdict === 'fault' ? stampOf(preflight.ranAt) : null
  const gateAt = gate ? stampOf(gate.ranAt) : null
  const pfAlert = (): ComposedCertChip => {
    const first = preflight!.failing[0]
    return {
      ...base,
      alert: {
        source: 'preflight',
        tone: 'fault',
        text: `preflight: ${first ? first.id : 'fault'} — /health`,
      },
    }
  }
  const gateAlert = (): ComposedCertChip =>
    !gate!.ok
      ? {
          ...base,
          alert: {
            source: 'gate',
            tone: 'fault',
            text: `gate RED (${gate!.fail.length} suite${gate!.fail.length === 1 ? '' : 's'}) — /health`,
          },
        }
      : {
          ...base,
          alert: {
            source: 'gate',
            tone: 'ok',
            text: `gate ✓ ${formatAge(nowMs - gateAt!)} — /health re-certifies`,
          },
        }
  if (pfAt !== null && gateAt !== null) return pfAt >= gateAt ? pfAlert() : gateAlert()
  if (pfAt !== null) return pfAlert()
  if (gateAt !== null) return gateAlert()
  return base
}
