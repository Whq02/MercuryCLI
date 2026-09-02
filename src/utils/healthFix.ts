/**
 * Health FIX engine (W8, MERCURY_DOCTOR_FIX — the flag spelling is frozen
 * external surface) — executes a check's attached remedy with the honesty
 * contract:
 *
 *   apply, then RE-PROBE with verify() — the outcome the operator sees is the
 *   verification, never apply's self-report. Every applied remedy writes an
 *   evolution-ledger row (program 'health-fix'; rows before carry
 *   the historical id 'doctor-fix') so the improvement history is auditable.
 *   Never throws — a thrown apply/verify becomes an honest failed outcome.
 *
 * Consent model: interactive rows go through the /health consent panel
 * (destructive renders the warning register); headless `health --fix` applies
 * safe remedies and requires --yes for destructive ones (remedyPermitted).
 * `MERCURY_DOCTOR_FIX=0` ⇒ diagnose-only: no remedy is offered anywhere.
 */

import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  isFixable,
  remedyPermitted,
  type HealthCheck,
  type HealthCertificate,
  type RemedyOutcome,
  flattenChecks,
} from './healthCertCore.js'
import {
  defaultEvolutionLedgerDir,
  writeEvolutionRow,
} from './evolution/evolutionLedger.js'

/** Fix engine gate: fork ∧ not explicitly off. OFF ⇒ diagnose-only /health. */
export function healthFixEnabled(): boolean {
  return flagEnv('MERCURY_DOCTOR_FIX') !== '0'
}

export interface AppliedFix {
  id: string
  label: string
  plan: string
  remedyClass: 'safe' | 'destructive'
  applied: RemedyOutcome
  /** null ⇒ apply failed, verification not attempted. */
  verified: RemedyOutcome | null
}

async function settle(run: () => Promise<RemedyOutcome>): Promise<RemedyOutcome> {
  try {
    return await run()
  } catch (e) {
    return { ok: false, note: `threw: ${e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140)}` }
  }
}

/** Apply one check's remedy (apply → verify → ledger row). */
export async function applyRemedy(check: HealthCheck): Promise<AppliedFix> {
  const remedy = check.remedy
  if (!remedy) {
    return {
      id: check.id,
      label: check.label,
      plan: '(no remedy attached)',
      remedyClass: 'safe',
      applied: { ok: false, note: 'check carries no executable remedy' },
      verified: null,
    }
  }
  const applied = await settle(remedy.apply)
  const verified = applied.ok ? await settle(remedy.verify) : null
  const outcome: AppliedFix = {
    id: check.id,
    label: check.label,
    plan: remedy.plan,
    remedyClass: remedy.class,
    applied,
    verified,
  }
  // Auditable improvement history — best-effort, gated inside the ledger.
  try {
    await writeEvolutionRow(defaultEvolutionLedgerDir(getCwd()), {
      program: 'health-fix',
      subject: check.id,
      outcome: verified?.ok ? 'accepted' : 'regressed',
      mechanism: remedy.plan,
      evidenceRefs: [
        `apply: ${applied.note.slice(0, 120)}`,
        ...(verified ? [`verify: ${verified.note.slice(0, 120)}`] : []),
      ],
    })
  } catch (e) {
    logForDebugging(`[health-fix] ledger row skipped (non-fatal): ${e}`)
  }
  return outcome
}

export interface HeadlessFixResult {
  fixes: AppliedFix[]
  skipped: { id: string; reason: string }[]
}

/**
 * Headless `health --fix [--only <id>] [--yes]`: apply every fixable check's
 * remedy (optionally narrowed to one id). Destructive remedies are skipped
 * without --yes — named in `skipped`, never silently dropped.
 */
export async function runHeadlessFix(
  cert: Pick<HealthCertificate, 'sections'>,
  opts: { only?: string; yes: boolean },
): Promise<HeadlessFixResult> {
  const result: HeadlessFixResult = { fixes: [], skipped: [] }
  if (!healthFixEnabled()) {
    result.skipped.push({ id: '*', reason: 'MERCURY_DOCTOR_FIX=0 — diagnose-only' })
    return result
  }
  for (const check of flattenChecks(cert)) {
    if (opts.only && check.id !== opts.only) continue
    if (!isFixable(check)) {
      if (opts.only) result.skipped.push({ id: check.id, reason: `not fixable (status ${check.status}${check.remedy ? '' : ', no remedy'})` })
      continue
    }
    if (!remedyPermitted(check.remedy!, { yes: opts.yes })) {
      result.skipped.push({ id: check.id, reason: 'destructive — requires --yes' })
      continue
    }
    result.fixes.push(await applyRemedy(check))
  }
  return result
}
