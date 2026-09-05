
import { jsonStringify } from '../utils/slowOperations.js'
import { writeOutAndExit } from './healthPresentation.js'

/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

function emitAndExit(value: unknown, code: number): Promise<never> {
  let text = '{}\n'
  try {
    text = jsonStringify(value, null, 2) + '\n'
  } catch {
  }
  return writeOutAndExit(text, code)
}

interface RunTrace {
  settled: number
  total: number
  lastSettled: string | null
}

function armSilenceGuards(
  scope: string,
  trace: RunTrace,
  deadlineMs: number | null,
): () => void {
  let armed = true
  const stallRecord = (why: string): unknown => ({
    error: `${scope} ${why} — the run parked before a certificate could be issued`,
    code: 'cert-stalled',
    lastSettled: trace.lastSettled,
    settled: trace.settled,
    total: trace.total,
  })
  const onBeforeExit = (): void => {
    if (!armed) return
    armed = false
    void emitAndExit(stallRecord('drained its event loop'), 1)
  }
  process.on('beforeExit', onBeforeExit)
  const deadline =
    deadlineMs !== null
      ? setTimeout(() => {
          if (!armed) return
          armed = false
          process.removeListener('beforeExit', onBeforeExit)
          void emitAndExit(stallRecord(`exceeded its ${Math.round(deadlineMs / 1000)}s bound`), 1)
        }, deadlineMs)
      : null
  return () => {
    armed = false
    process.removeListener('beforeExit', onBeforeExit)
    if (deadline !== null) clearTimeout(deadline)
  }
}

export async function runHealthFixCli(opts: { only?: string; yes: boolean }): Promise<never> {
  const trace: RunTrace = { settled: 0, total: 0, lastSettled: null }
  const disarm = armSilenceGuards('health --fix', trace, null)
  try {
    const [{ healthCertEnabled, runAndRecordHealthReport }, fixMod] = await Promise.all([
      import('../utils/healthReport.js'),
      import('../utils/healthFix.js'),
    ])
    if (!healthCertEnabled()) {
      disarm()
      return emitAndExit({ error: 'health --fix requires MERCURY_DOCTOR_CERT enabled', code: 'cert-unavailable' }, 1)
    }
    if (!fixMod.healthFixEnabled()) {
      disarm()
      return emitAndExit({ error: 'MERCURY_DOCTOR_FIX=0 — diagnose-only; no remedies applied', code: 'fix-disabled' }, 1)
    }
    const onProgress = (ev: { check: { id: string }; done: number; total: number }): void => {
      trace.settled = ev.done
      trace.total = ev.total
      trace.lastSettled = ev.check.id
    }
    const before = await runAndRecordHealthReport({ onProgress })
    const { fixes, skipped } = await fixMod.runHeadlessFix(before, opts)
    const after = fixes.length > 0 ? await runAndRecordHealthReport({ onProgress }) : before
    disarm()
    return emitAndExit({
      before: { verdict: before.verdict, ranAt: before.ranAt },
      fixes: fixes.map(f => ({
        id: f.id,
        plan: f.plan,
        class: f.remedyClass,
        applied: f.applied,
        verified: f.verified,
      })),
      skipped,
      after: { verdict: after.verdict, ranAt: after.ranAt },
    }, fixes.some(f => !(f.verified?.ok ?? false)) ? 2 : 0)
  } catch (e: unknown) {
    disarm()
    return emitAndExit({ error: e instanceof Error && e.message ? e.message : 'health --fix threw', code: 'fix-failed' }, 1)
  }
}

const JSON_RUN_DEADLINE_MS = { fast: 300_000, deep: 900_000 } as const

export async function runHealthJsonCli(opts?: { deep?: boolean; only?: string }): Promise<never> {
  const depth: 'fast' | 'deep' = opts?.deep ? 'deep' : 'fast'
  const trace: RunTrace = { settled: 0, total: 0, lastSettled: null }
  const disarm = armSilenceGuards('health --json', trace, JSON_RUN_DEADLINE_MS[depth])
  try {
    const { healthCertEnabled, runAndRecordHealthReport } = await import('../utils/healthReport.js')
    if (!healthCertEnabled()) {
      disarm()
      return emitAndExit({
        error: 'the health certificate requires MERCURY_DOCTOR_CERT enabled',
        code: 'cert-unavailable',
      }, 1)
    }
    let cert = await runAndRecordHealthReport({
      depth,
      onProgress: ev => {
        trace.settled = ev.done
        trace.total = ev.total
        trace.lastSettled = ev.check.id
      },
    })
    if (opts?.only !== undefined) {
      const { filterCertificateToCheck, flattenChecks } = await import('../utils/healthCertCore.js')
      const filtered = filterCertificateToCheck(cert, opts.only)
      if (filtered === null) {
        disarm()
        return emitAndExit({
          error: `no health check has id '${opts.only}'`,
          code: 'unknown-check-id',
          knownIds: flattenChecks(cert).map(c => c.id),
        }, 1)
      }
      disarm()
      return emitAndExit({ certSchema: 2, ...filtered }, (filtered as { verdict?: string }).verdict === 'fault' ? 3 : 0)
    }
    let readiness: unknown
    let readinessError: string | undefined
    try {
      const { collectReadiness } = await import('../utils/readiness.js')
      readiness = collectReadiness({ includeEnv: false }).records
    } catch (e) {
      readinessError = e instanceof Error ? e.message : String(e)
    }
    disarm()
    return emitAndExit(
      { certSchema: 2, ...cert, ...(readiness ? { readiness } : {}), ...(readinessError ? { readinessError } : {}) },
      (cert as { verdict?: string }).verdict === 'fault' ? 3 : 0,
    )
  } catch (e: unknown) {
    disarm()
    return emitAndExit({
      error: e instanceof Error && e.message ? e.message : 'the certificate run threw',
      code: 'cert-failed',
    }, 1)
  }
}
