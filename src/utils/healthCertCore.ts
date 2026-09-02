// ============================================================================
//  healthCertCore — the PURE certificate logic behind /health.
//
//  The health certificate's trust rules (verdict roll-up, gate-verdict
//  interpretation, freshness/staleness math, the persisted last-cert summary
//  and its Helm-chip reading) live here with ZERO harness imports — no config,
//  no snapshots, no Ink — so `bun run` proof scripts can load and table-test
//  every decision (scripts/health/prove-cert-core.ts). healthReport.ts owns the
//  I/O checks and feeds this module; the panel renders what it returns.
//
//  Doctrine (docs/HEALTH-CERTIFICATE.md):
//    · a claim with no evidence must say `unknown`, never `ok`
//    · evidence that predates what it certifies degrades to `stale`
//    · `off` (deliberately disabled) is neutral — never raises the verdict
// ============================================================================

/** A single check's honest state. ok/warn/fail mirror the old report; stale =
 *  evidence exists but predates what it certifies; unknown = no evidence either
 *  way; off = deliberately disabled (a gate/flag choice, never a fault); info =
 *  neutral observation. */
export type HealthStatus = 'ok' | 'warn' | 'fail' | 'stale' | 'unknown' | 'off' | 'info'

/** The certificate roll-up — the trust statement the operator reads first. */
export type CertVerdict = 'certified' | 'caution' | 'fault'

/** How risky applying a remedy is. `safe` = additive/recomputable (rebuild,
 *  re-run, prune of derived state); `destructive` = discards or rewrites
 *  something not mechanically recoverable — headless requires --yes,
 *  interactive renders the warning register. */
export type RemedyClass = 'safe' | 'destructive'

export interface RemedyOutcome {
  ok: boolean
  note: string
}

/**
 * An EXECUTABLE fix attached to a check (the W8 fix engine). `fix` stays the
 * human advice line; a remedy is the machine that does it:
 *   plan    — one honest sentence of what apply() will do (the consent card
 *             shows this verbatim; include duration when it is long);
 *   apply   — perform the fix, return an outcome (throwing counts as failure);
 *   verify  — RE-PROBE the concern after apply; never trust apply's own claim.
 */
export interface HealthRemedy {
  plan: string
  class: RemedyClass
  apply: () => Promise<RemedyOutcome>
  verify: () => Promise<RemedyOutcome>
}

/** How a check earned its verdict: a FUNCTIONAL probe completed a
 *  real operation; a CONFIGURATION probe read evidence/config state. A green
 *  functional claim must never come from configuration-only evidence. */
export type HealthProbeKind = 'functional' | 'configuration'
export type HealthDepth = 'fast' | 'deep'

export interface HealthCheck {
  id: string
  label: string
  status: HealthStatus
  /** REQUIRED: what backs this claim — the artifact/probe/value consulted.
   *  A check that cannot name its evidence must report `unknown`. */
  evidence: string
  /** Optional longer human detail (expanded row). */
  detail?: string
  /** An actionable fix when the status warrants one. */
  fix?: string
  /** A related operator surface (`/trace`, `/workflows`, …) for drill-down. */
  link?: string
  /** Executable remedy (W8) — present only when the check knows HOW to fix
   *  itself with an on-box action. */
  remedy?: HealthRemedy
  /** Probe kind: functional vs configuration evidence. */
  probe?: HealthProbeKind
  /** The depth tier this check runs at (fast checks run in both). */
  depth?: HealthDepth
  /** Wall-clock of the check's run. */
  durationMs?: number
  /** When the evidence was gathered. */
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

/** The Node runtime contract facts (additive — projected from
 *  src/utils/runtime/nodePolicy.ts; `verdict` is the pure evaluateNodeRuntime
 *  decision over the observed runtime). */
export interface NodeRuntimeFacts {
  observed: string | null
  label: string
  range: string
  verdict: 'supported' | 'too-old' | 'unqualified-major' | 'prerelease' | 'invalid'
}

export interface HealthCertificate {
  verdict: CertVerdict
  sections: HealthSection[]
  /** ISO instant the certificate was issued. */
  ranAt: string
  /** Repo state at issue time (null fields = not a git repo / unreadable). */
  head: CertHead
  /** The harness version string (self-recognition). */
  version: string
  durationMs: number
  /** The depth this certificate ran at. */
  depth?: HealthDepth
  /** Node runtime contract at issue time. */
  nodeRuntime?: NodeRuntimeFacts
}

// --- roll-up -----------------------------------------------------------------

/** fail ⇒ fault · warn/stale/unknown ⇒ caution · else certified.
 *  off/info are neutral by doctrine and never raise the verdict. */
export function verdictFromStatuses(statuses: readonly HealthStatus[]): CertVerdict {
  if (statuses.includes('fail')) return 'fault'
  if (statuses.some(s => s === 'warn' || s === 'stale' || s === 'unknown')) return 'caution'
  return 'certified'
}

export function flattenChecks(cert: Pick<HealthCertificate, 'sections'>): HealthCheck[] {
  return cert.sections.flatMap(s => s.checks)
}

/**
 * Narrow a certificate to ONE check (`--only <id>`): sections keep only the
 * named check (empty sections drop), and the verdict is recomputed over what
 * REMAINS — the narrowed record describes exactly what it contains, never a
 * verdict inherited from checks it no longer carries. Null when no check has
 * that id (the caller owns the honest unknown-id refusal).
 */
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

/** A remedy is offered only for statuses that assert something is WRONG —
 *  ok/info/off/unknown rows never expose apply (nothing proven to fix). */
export function isFixable(check: Pick<HealthCheck, 'status' | 'remedy'>): boolean {
  return (
    check.remedy !== undefined &&
    (check.status === 'fail' || check.status === 'warn' || check.status === 'stale')
  )
}

/** Headless consent rule: destructive remedies require an explicit --yes. */
export function remedyPermitted(remedy: Pick<HealthRemedy, 'class'>, opts: { yes: boolean }): boolean {
  return remedy.class === 'safe' || opts.yes
}

/** Severity order for ranking fixes (worst first). */
const ACTION_SEVERITY: readonly HealthStatus[] = ['fail', 'stale', 'warn', 'unknown']

/** The "what should I do next" list: checks carrying a fix, worst-first, capped. */
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

// --- freshness ---------------------------------------------------------------

/** Human age: seconds under 90s, minutes under 90m, hours under 36h, else days.
 *  Negative/NaN input (clock skew, corrupt stamp) reads honestly as "clock skew". */
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

// --- gate verdict (.mercury/gate/verdict.json) -------------------------------

/** What scripts/run-all-suites.sh leaves behind (best-effort, both colors). */
export interface GateVerdict {
  ok: boolean
  pass: string[]
  fail: string[]
  /** ISO instant of the run. */
  ranAt: string
  headSha: string | null
  /** Tree had uncommitted changes when the gate ran. */
  dirty: boolean
  durationS: number
  /**
   * CONTENT BINDING: the git
   * tree sha of the tracked WORKING-TREE content at run time (temp-index
   * `add -A` + `write-tree`). The gate habitually runs on a dirty tree that is
   * committed moments later — sha/dirty comparison then reads every
   * post-commit boot as stale until the next 7-minute gate run, keeping the
   * health chip amber for hours. If this tree sha equals the CURRENT tree's,
   * the gate certified exactly this content, whatever the commit graph did.
   * Absent (legacy verdicts) ⇒ the sha/dirty rules stand unchanged.
   */
  treeSha: string | null
}

/** Defensive decode of raw parsed JSON — null on any shape violation. */
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

/** The gate decision table (docs/HEALTH-CERTIFICATE.md §Mechanics):
 *    absent          ⇒ unknown (no evidence — never assumed green)
 *    red             ⇒ fail
 *    green, HEAD moved since the run        ⇒ stale
 *    green, uncommitted changes (either the run's tree or the current one)
 *                                           ⇒ stale (edits the gate hasn't seen)
 *    green @ current HEAD, both trees clean ⇒ ok
 *  `head` is the CURRENT repo state; sha null on either side skips the sha
 *  comparison honestly (evidence says so). */
export function interpretGateVerdict(
  v: GateVerdict | null,
  head: Pick<CertHead, 'sha' | 'dirty'> & { treeSha?: string | null },
  nowMs: number,
): Pick<HealthCheck, 'status' | 'evidence' | 'fix'> {
  if (v === null) {
    // THE NEVER-RUN ARM (first-contact law, prove-cert-core): the proof
    // suite is a Mercury-developer instrument — an install that never asked
    // for a gate verdict has not failed a check, and the first doctor a
    // fresh clone runs must be able to certify. 'info' is neutral by the
    // verdict doctrine; a RECORDED verdict that is red, moved or stale
    // still cautions exactly as before (this arm never weakens staleness —
    // absent evidence is no claim, in either direction).
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
    // Inventory S3: a RED verdict ages exactly like a green
    // one — a red recorded against a SUPERSEDED commit/tree is stale
    // evidence of a PAST failure, not a present-tense assertion (the
    // operator's 3-day-old health chip asserted a long-fixed red). A red
    // whose state still matches stays a live `fail`.
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
  // Content binding beats graph position: if the gated tree IS the current
  // tree, the run certifies exactly this content — committing it (which moves
  // HEAD and clears dirtiness) changes nothing the gate saw. Red never gets
  // here (checked above); a MISMATCHED treeSha falls through to the honest
  // sha/dirty staleness below.
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

// --- persisted last-cert summary (<state-root>/doctor/last-cert.json) --------

/** The summary each run persists — enough for the Helm chip + resume honesty,
 *  deliberately NOT the full check list (re-run /health for live truth).
 *  `attention` carries the verdict-DRIVING rows themselves
 *  (fail/warn/stale — capped). The audit machine's artifact read
 *  `verdict: caution · warn: 1` and named nothing — the very file README
 *  tells operators to attach when reporting a problem could not say WHICH
 *  row warned. */
export interface LastCertSummary {
  verdict: CertVerdict
  ranAt: string
  head: CertHead
  version: string
  counts: Record<HealthStatus, number>
  /** fail/warn/stale rows, worst-first, capped at ATTENTION_ROWS_MAX. */
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
  // Additive decode: an older summary has no attention
  // rows — decode to [] rather than refusing the whole summary.
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

/** The Helm telemetry chip's reading of the persisted summary. Age is the
 *  honesty signal (rendered next to the verdict); a summary older than
 *  CERT_CHIP_STALE_MS additionally reads `stale: true` so the rail can tone it
 *  amber without re-deriving policy. No sha comparison here — the chip path is
 *  a per-render sync read and must not spawn git; /health re-verifies. */
export const CERT_CHIP_STALE_MS = 24 * 60 * 60 * 1000

export interface CertChip {
  verdict: CertVerdict | null
  /** null when no certificate has ever been issued. */
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

// --- boot preflight (<state-root>/doctor/last-preflight.json) -----------------

/** What the boot preflight persists — a cheap SUBSET probe, never a
 *  certificate. Doctrine: a preflight may only DOWNGRADE/annotate the chip; it
 *  never refreshes the certificate's age and never upgrades its verdict (the
 *  full /health run stays the assurance signal). */
export interface PreflightSummary {
  verdict: CertVerdict
  ranAt: string
  /** The failing checks (fail only — the notify-worthy set). */
  failing: Array<{ id: string; evidence: string }>
  /** The caution-DRIVING rows (warn/stale/unknown) — a
   *  five-second probe ending on `caution` with an empty `failing` array
   *  would otherwise name nothing at all. */
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
  // Additive: older artifacts carry no degraded rows.
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

/** One calm alert line under the chip — the worst NEWER-than-cert evidence. */
export interface CertChipAlert {
  source: 'preflight' | 'gate'
  /** 'fault' tones CRIMSON; 'ok' is a FAINT annotation. */
  tone: 'fault' | 'ok'
  text: string
}

export interface ComposedCertChip extends CertChip {
  alert?: CertChipAlert
}

/**
 * Fold newer evidence into the chip WITHOUT re-issuing anything:
 *   · a preflight FAULT newer than the cert ⇒ CRIMSON alert;
 *   · a gate verdict newer than the cert ⇒ red = CRIMSON alert, green = a
 *     FAINT `gate ✓` annotation (fresh evidence exists — go re-certify);
 *   · never an upgrade: verdict/age come from the cert alone.
 * When BOTH are newer than the cert, the NEWER of the two speaks (a green
 * gate run supersedes an older preflight whose fault WAS the red gate);
 * a non-fault preflight never alerts. One alert, calm.
 */
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
