
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

export function healthFixEnabled(): boolean {
  return flagEnv('MERCURY_DOCTOR_FIX') !== '0'
}

export interface AppliedFix {
  id: string
  label: string
  plan: string
  remedyClass: 'safe' | 'destructive'
  applied: RemedyOutcome
  verified: RemedyOutcome | null
}

async function settle(run: () => Promise<RemedyOutcome>): Promise<RemedyOutcome> {
  try {
    return await run()
  } catch (e) {
    return { ok: false, note: `threw: ${e instanceof Error ? e.message.slice(0, 140) : String(e).slice(0, 140)}` }
  }
}

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
