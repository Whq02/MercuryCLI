// crashReport — on-disk render-crash forensics (post-FLUX crash fix,
// The operator's React #300 session kill left NO component
// name anywhere: the app-root boundary dropped errorInfo and the
// per-message boundary's logError is in-memory telemetry. Both boundaries
// now persist {error, componentStack} here, sync + best-effort — a crash
// report must never itself crash or block the teardown.
//
// Note: shipping builds minify identifiers, so componentStack frames may
// carry short names — the STACK SHAPE plus file/line from error.stack still
// localizes the component (the #300 hunt cost hours without it).

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MERCURY_VERSION } from '../constants/product.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'

const KEEP = 20

/** The retained-record location every crash surface references (the law:
 *  a displayed reference must resolve to a real retained record — this
 *  directory is where persistCrashReport writes, derived identically).
 * rides the ONE config-home resolver — the old
 *  inline env-fallback derivation sent env-less runs' crash reports into
 *  an external harness home. */
export function crashReportDir(): string {
  return join(getMercuryHome(), 'crashes')
}

/** crashReportDir with the home prefix collapsed to `~` for display. */
export function crashReportDirDisplay(): string {
  const dir = crashReportDir()
  const home = homedir()
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}

/** The exact path of the report THIS process last persisted, or null.
 * The loud exit line may reference a report only when one truly
 *  exists — this latch is how the launch-failure catch knows. */
let lastReportPath: string | null = null
export function lastCrashReportPath(): string | null {
  return lastReportPath
}

/** Why the newest persist attempt wrote NOTHING — the loud exit's honest
 *  next-step names it (the Windows field's TASK-018 wave 5, first-run-cold-
 *  box: an unwritable config home is the one failure class that most
 *  reliably kills the report, and the card still promised "the report below
 *  carries it" there). Null after a landed write. */
let lastReportRefusal: string | null = null
export function lastCrashReportRefusal(): string | null {
  return lastReportRefusal
}

/** The failing component's display name — the componentStack's TOP frame
 *  ('in X' / 'at X' shapes; minified builds may carry short names, still a
 *  locator). Best-effort; null when unparseable. The report carries it so
 *  the forensics are self-sufficient (B20: the app-root #300 hunt needed
 *  the component name and the report held only raw stacks). */
export function failingComponentOf(componentStack: string | null | undefined): string | null {
  if (!componentStack) return null
  for (const line of componentStack.split('\n')) {
    const m = line.trim().match(/^(?:in|at)\s+([A-Za-z0-9_$.]+)/)
    if (m?.[1]) return m[1]
  }
  return null
}

/** Best-effort identity reads (B20): a crash report must localize itself —
 *  version, platform, session, project, surface — without the session that
 *  died. Every read is fenced: a broken owner never blocks the report. */
function crashIdentity(): {
  version: string | null
  platform: string
  sessionId: string | null
  cwd: string | null
  surface: string | null
} {
  let sessionId: string | null = null
  try {
    const { getSessionId } = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
    sessionId = String(getSessionId())
  } catch {
    /* pre-bootstrap or headless — absent honestly */
  }
  // The project identity (FN-013 CRASH-03): without it a recovered session
  // id cannot be LOCATED across projects — the notice could name a session
  // nobody could find. The product's cwd owner first (it tracks worktree
  // moves), the process cwd as the fence's fence.
  let cwd: string | null = null
  try {
    const { getCwd } = require('./cwd.js') as typeof import('./cwd.js')
    cwd = getCwd()
  } catch {
    try {
      cwd = process.cwd()
    } catch {
      /* teardown-time cwd loss — absent honestly */
    }
  }
  let surface: string | null = null
  try {
    const { currentSurfaceRoute, surfaceRouteId } =
      require('../context/surfaceRoute.js') as typeof import('../context/surfaceRoute.js')
    surface = surfaceRouteId(currentSurfaceRoute())
  } catch {
    /* no route estate in this process shape */
  }
  return {
    version: MERCURY_VERSION ?? null,
    platform: `${process.platform}-${process.arch} node ${process.versions.node}`,
    sessionId,
    cwd,
    surface,
  }
}

export function persistCrashReport(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
  origin: 'app-root' | 'message-boundary' | 'boot' | 'surface' | 'uncaught-exception' | 'unhandled-rejection' = 'app-root',
): void {
  try {
    const dir = crashReportDir()
    mkdirSync(dir, { recursive: true })
    const err = error instanceof Error ? error : new Error(String(error))
    const file = join(dir, `crash-${Date.now()}-${origin}.json`)
    writeFileSync(
      file,
      JSON.stringify(
        {
          origin,
          at: new Date().toISOString(),
          message: err.message,
          stack: err.stack ?? null,
          componentStack: errorInfo?.componentStack ?? null,
          component: failingComponentOf(errorInfo?.componentStack),
          ...crashIdentity(),
          pid: process.pid,
          argv1: process.argv[1] ?? null,
        },
        null,
        2,
      ),
    )
    // Latched AFTER the write lands — the old order latched first, so a
    // creatable-but-unwritable dir (a redirected profile, an ACL) made the
    // loud exit cite a report file that never existed (TASK-017 S2,
    // crash-report-path-latched-before-write).
    lastReportPath = file
    lastReportRefusal = null
    // best-effort prune: keep the newest KEEP reports. (H-17): the
    // prune's failures are LOGGED — the truthful-receipts law reaches this
    // bare-catch's prune member specifically (a silently failing prune reads
    // as bounded history while the directory grows without bound).
    try {
      const all = readdirSync(dir)
        .filter(f => f.startsWith('crash-'))
        .sort()
      for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
        try {
          rmSync(join(dir, stale), { force: true })
        } catch (pruneErr) {
          logForDebugging(`[crashReport] prune failed for ${stale}: ${pruneErr}`)
        }
      }
    } catch (listErr) {
      logForDebugging(`[crashReport] prune listing failed: ${listErr}`)
    }
  } catch (writeErr) {
    // never let forensics interfere with the crash path — but remember why
    // nothing landed, so the loud exit can say so instead of promising it.
    lastReportRefusal = writeErr instanceof Error ? writeErr.message : String(writeErr)
  }
}

// ── the readers (B20: the archive was write-only — nothing ever read it) ────

export type CrashReportSummary = {
  file: string
  origin: string
  at: string
  message: string
  component: string | null
  /** The identity that was always written and then dropped at this read
   *  boundary (FN-013 CRASH-03): the session the report belongs to and the
   *  project it ran in — what a notice needs to offer re-entry. Reports
   *  from builds predating the fields answer null, never a throw. */
  sessionId: string | null
  cwd: string | null
}

/** Newest-first summaries of the retained reports. Best-effort per file: an
 *  unparseable report still appears (its message says so) — the archive
 *  must never look empty because one record rotted. */
export function listCrashReports(limit = KEEP): CrashReportSummary[] {
  try {
    const dir = crashReportDir()
    const names = readdirSync(dir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
    return names.map(name => {
      const file = join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          origin?: string
          at?: string
          message?: string
          component?: string | null
          sessionId?: string | null
          cwd?: string | null
        }
        return {
          file,
          origin: parsed.origin ?? 'unknown',
          at: parsed.at ?? 'unknown',
          message: parsed.message ?? '(no message)',
          component: parsed.component ?? null,
          sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null,
          cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : null,
        }
      } catch {
        return {
          file,
          origin: 'unknown',
          at: 'unknown',
          message: '(unreadable report)',
          component: null,
          sessionId: null,
          cwd: null,
        }
      }
    })
  } catch {
    return []
  }
}

// ── the boot notice (B20: one word at the NEXT interactive boot) ────────────

const NOTICE_MARKER = '.boot-noticed'

/** Reports persisted since the last boot notice (marker mtime), newest
 *  first. An absent marker means every retained report is unnoticed. */
export function unnoticedCrashReports(): CrashReportSummary[] {
  try {
    const dir = crashReportDir()
    let noticedAt = 0
    try {
      noticedAt = statSync(join(dir, NOTICE_MARKER)).mtimeMs
    } catch {
      /* never noticed */
    }
    return listCrashReports().filter(report => {
      try {
        return statSync(report.file).mtimeMs > noticedAt
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** Latch the notice: reports up to NOW are spoken for. */
export function markCrashReportsNoticed(): void {
  try {
    const dir = crashReportDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, NOTICE_MARKER), new Date().toISOString())
  } catch {
    /* the notice may repeat — better twice than never */
  }
}
