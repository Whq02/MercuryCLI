// `mercury health --json` — the machine seam of the health certificate
// (docs/HEALTH-CERTIFICATE.md). Contract (cli-design-system): stdout carries
// ONLY the JSON record (no brand chrome, no ANSI, ISO-8601 stamps, frozen
// field names — the HealthCertificate shape in healthCertCore.ts); under
// --json even errors are JSON on stdout. Exit codes: 0 = certificate
// produced with a non-FAULT verdict; 3 = certificate produced and the
// verdict is FAULT (FC-044: doctor-or-die shell guards must fire on the
// certificate's own worst state — exit 0 there defeated them; scripts still
// read .verdict for detail); 1 = the certificate could not be produced
// (unavailable here, stalled, or the run threw). Usage errors (unknown
// flags) stay commander's exit-2 problem. Every path exits — never fall
// through to the REPL.
//
// THE SILENCE LAW: a
// bundle copied outside its repo would otherwise exit 0 with EMPTY stdout — the
// certificate runner's per-check deadline timers are all unref'd by design
// (the interactive panel must never be held open by them), so when a probe
// parks on a promise backed by no live libuv handle, the event loop drains
// and node performs a NORMAL exit before any record is written. This seam
// therefore guarantees: a certificate, or a LOUD TYPED FAILURE — never
// silence. Two guards, both scoped to this CLI seam (the panel keeps its
// unref'd timers):
//   · a REF'D run deadline for --json (generous: no honest run approaches
//     it) — it keeps the loop alive so every per-check deadline actually
//     fires, and if the run is truly parked it emits `cert-stalled` naming
//     the last settled check;
//   · a `beforeExit` tripwire on every path (--fix has legitimately long
//     remedies, so it carries no total deadline) — a drained loop before the
//     record is written becomes the same typed failure instead of silence.

import { jsonStringify } from '../utils/slowOperations.js'
import { writeOutAndExit } from './healthPresentation.js'

/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

/** Every emission here is TERMINAL — the record is written and the process
 *  ends via the shared drain-aware exit (EPIPE settles quietly per the
 *  SIGPIPE contract); a slow pipe still receives the complete record. */
function emitAndExit(value: unknown, code: number): never {
  let text = '{}\n'
  try {
    text = jsonStringify(value, null, 2) + '\n'
  } catch {
    /* unserializable — the empty record still exits with the honest code */
  }
  writeOutAndExit(text, code)
  // writeOutAndExit exits on every path; this throw is typing-only.
  throw new Error('unreachable')
}

/** Progress bookkeeping for the stall record — which check settled last is
 *  exactly the lead a parked run needs. Never printed on the happy path
 *  (JSON-only stdout; no stderr chatter — scripts read one record). */
interface RunTrace {
  settled: number
  total: number
  lastSettled: string | null
}

/** Arm the silence guards. Returns the disarm — call it before every emit.
 *  `deadlineMs` null ⇒ tripwire only (the --fix path). The deadline timer is
 *  deliberately REF'D: it is the one live handle that keeps a drained loop
 *  from exiting silently while unref'd per-check deadlines still owe fires. */
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
    // The loop drained with no record written — the silent-exit-0 shape.
    emitAndExit(stallRecord('drained its event loop'), 1)
  }
  process.on('beforeExit', onBeforeExit)
  const deadline =
    deadlineMs !== null
      ? setTimeout(() => {
          if (!armed) return
          armed = false
          process.removeListener('beforeExit', onBeforeExit)
          emitAndExit(stallRecord(`exceeded its ${Math.round(deadlineMs / 1000)}s bound`), 1)
        }, deadlineMs)
      : null
  return () => {
    armed = false
    process.removeListener('beforeExit', onBeforeExit)
    if (deadline !== null) clearTimeout(deadline)
  }
}

/**
 * `mercury health --fix [--only <id>] [--yes]` — the headless fix engine (W8).
 * Diagnose → apply each fixable check's remedy (destructive requires --yes) →
 * RE-ISSUE the certificate → print `{before, fixes, skipped, after}` JSON.
 * Exit 0 when the certificate was produced and every attempted fix verified;
 * 1 when unavailable/stalled/threw; 2 when a fix was attempted but failed
 * verify. No total deadline — remedies (the gate re-run) are legitimately
 * long; the beforeExit tripwire alone converts silence into a typed failure.
 */
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
      emitAndExit({ error: 'health --fix requires MERCURY_DOCTOR_CERT enabled', code: 'cert-unavailable' }, 1)
    }
    if (!fixMod.healthFixEnabled()) {
      disarm()
      emitAndExit({ error: 'MERCURY_DOCTOR_FIX=0 — diagnose-only; no remedies applied', code: 'fix-disabled' }, 1)
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
    emitAndExit({
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
    emitAndExit({ error: e instanceof Error && e.message ? e.message : 'health --fix threw', code: 'fix-failed' }, 1)
  }
}

/** The run deadline per depth — generous bounds no honest run approaches
 *  (fast certificates settle in seconds; a deep run in a couple of minutes).
 *  Their purpose is anti-silence, not latency policing. */
const JSON_RUN_DEADLINE_MS = { fast: 300_000, deep: 900_000 } as const

export async function runHealthJsonCli(opts?: { deep?: boolean; only?: string }): Promise<never> {
  const depth: 'fast' | 'deep' = opts?.deep ? 'deep' : 'fast'
  const trace: RunTrace = { settled: 0, total: 0, lastSettled: null }
  const disarm = armSilenceGuards('health --json', trace, JSON_RUN_DEADLINE_MS[depth])
  try {
    const { healthCertEnabled, runAndRecordHealthReport } = await import('../utils/healthReport.js')
    if (!healthCertEnabled()) {
      disarm()
      emitAndExit({
        error: 'the health certificate requires MERCURY_DOCTOR_CERT enabled',
        code: 'cert-unavailable',
      }, 1)
    }
    // Deep mode: the isolated FUNCTIONAL probes join the report.
    // Progress stays OFF stdout and stderr entirely (JSON-only contract) —
    // the onProgress hook below only feeds the stall record's bookkeeping.
    let cert = await runAndRecordHealthReport({
      depth,
      onProgress: ev => {
        trace.settled = ev.done
        trace.total = ev.total
        trace.lastSettled = ev.check.id
      },
    })
    // `--only <id>`: the record narrows to the ONE check (verdict recomputed
    // over what remains). An unknown id is an honest typed refusal naming
    // the known ids — never a silently unfiltered record. The one-check
    // record also skips the readiness enrichment below: `--only` asked for
    // one check, not the estate dump.
    if (opts?.only !== undefined) {
      const { filterCertificateToCheck, flattenChecks } = await import('../utils/healthCertCore.js')
      const filtered = filterCertificateToCheck(cert, opts.only)
      if (filtered === null) {
        disarm()
        emitAndExit({
          error: `no health check has id '${opts.only}'`,
          code: 'unknown-check-id',
          knownIds: flattenChecks(cert).map(c => c.id),
        }, 1)
      }
      disarm()
      emitAndExit({ certSchema: 2, ...filtered }, (filtered as { verdict?: string }).verdict === 'fault' ? 3 : 0)
    }
    // The same readiness records the /capabilities center shows ride the
    // JSON seam so scripts read ONE truth: tools, MCP (config + this
    // process's connection states — headless runs that never connected
    // honestly read `configured`), lanes, engines, extensions, skills. Env rows
    // are omitted here (the flag registry module is the env catalog);
    // enrichment failure degrades to a `readinessError`, never a lost
    // certificate.
    let readiness: unknown
    let readinessError: string | undefined
    try {
      const { collectReadiness } = await import('../utils/readiness.js')
      readiness = collectReadiness({ includeEnv: false }).records
    } catch (e) {
      readinessError = e instanceof Error ? e.message : String(e)
    }
    disarm()
    // certSchema: 2 = per-check probe/depth/duration
    // fields + the cert-level depth + deep functional sections. Every
    // schema-1 field is unchanged; scripts keying on .verdict keep working.
    emitAndExit(
      { certSchema: 2, ...cert, ...(readiness ? { readiness } : {}), ...(readinessError ? { readinessError } : {}) },
      (cert as { verdict?: string }).verdict === 'fault' ? 3 : 0,
    )
  } catch (e: unknown) {
    disarm()
    emitAndExit({
      error: e instanceof Error && e.message ? e.message : 'the certificate run threw',
      code: 'cert-failed',
    }, 1)
  }
}
