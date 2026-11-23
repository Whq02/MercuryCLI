import { readBootAttemptResidue } from '../../../substrate/bootBeacon.js'
import { statSync } from 'node:fs'
import { errorMessage, isENOENT } from '../../../errors/errors.js'
import { formatAge } from '../../healthCertCore.js'
import type { CheckSpec } from '../../healthReport.js'

export function bootBeaconCheck(): CheckSpec {
  return {
    id: 'boot-beacon',
    label: 'Boots complete',
    run: () => {
      const residue = readBootAttemptResidue()
      if (residue && residue.count >= 3) {
        return {
          status: 'warn',
          evidence: `${residue.count} enter-screen handoff(s) since the last completed boot — latest ${formatAge(Date.now() - residue.lastTs)}`,
          fix: '`mercury update --rollback` returns to the previous version; `MERCURY_SPLASH=off mercury` boots without the enter screen. Include `mercury health --json` when reporting.',
        }
      }
      return {
        status: 'ok',
        evidence: residue
          ? `${residue.count} pending attempt(s) (a boot may be in flight or was cancelled mid-handoff)`
          : 'no pending attempts',
      }
    },
  }
}

export function launchSpineCheck(): CheckSpec {
  return {
    id: 'launch-spine',
    label: 'Boot milestones',
    run: async () => {
      const { lastBootReachedInputLive, lastInteractiveBootSpine } = await import(
        '../../../substrate/launchMilestones.js'
      )
      const reached = lastBootReachedInputLive({ strict: true })
      if (reached === null) return { status: 'off', evidence: 'no interactive boot recorded yet' }
      const RANK: Record<string, number> = { 'runtime-entry': 0, 'route-ready': 1, 'first-frame': 2, 'input-live': 3 }
      const rungRows = lastInteractiveBootSpine({ strict: true }).filter(r => r.milestone in RANK)
      const lastRungs = rungRows.map(r => r.milestone)
      const spine = lastRungs.join(' → ')
      const setupScreenFirst = rungRows.some(r => r.milestone === 'first-frame' && r.beforeLaunch === true)
      const routeAt = lastRungs.indexOf('route-ready')
      const setupRoute = setupScreenFirst && lastRungs[0] === 'runtime-entry' && routeAt > 0 && routeAt === lastRungs.lastIndexOf('route-ready')
      const ranks = lastRungs.filter((_, i) => !setupRoute || i !== routeAt).map(m => RANK[m] ?? -1)
      const inOrder = ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1]!))
      if (reached && !inOrder) {
        return {
          status: 'warn',
          evidence: `last boot's spine fired OUT OF ORDER: ${spine}`,
          fix: 'The rungs must fire runtime-entry → route-ready → first-frame → input-live; an inverted spine means a stamp moved — include `mercury health --json` when reporting.',
        }
      }
      return reached
        ? { status: 'ok', evidence: `last boot: ${spine}` }
        : {
            status: 'warn',
            evidence: `last boot's spine truncated: ${spine || '(empty)'} — the process never reached input-live`,
            fix: 'A boot that exits 0 before input is live is a launcher defect — include `mercury health --json` when reporting.',
          }
    },
  }
}

export function invocationRecordCheck(): CheckSpec {
  return {
    id: 'invocation-record',
    label: 'Invocation record',
    run: async () => {
      const { readInvocationRecords } = await import('../../../substrate/invocationRecord.js')
      const rows = readInvocationRecords()
      const last = rows[rows.length - 1]
      if (!last) return { status: 'off', evidence: 'no invocation recorded yet' }
      return {
        status: 'ok',
        evidence: `${last.platform} · ${last.shellHint} · tty in/out/err ${last.stdinTTY ? 'y' : 'n'}/${last.stdoutTTY ? 'y' : 'n'}/${last.stderrTTY ? 'y' : 'n'}${last.termProgram ? ` · ${last.termProgram}` : ''} (${rows.length} recorded)`,
      }
    },
  }
}

export function invocationTraceCheck(): CheckSpec {
  return {
    id: 'invocation-trace',
    label: 'Trace appends',
    run: async () => {
      const { getTraceFlushHealth, getInvocationTracePath, isInvocationTraceEnabled } =
        await import('../../../observability/invocationTrace.js')
      if (!isInvocationTraceEnabled()) {
        return { status: 'off', evidence: 'tracing off (MERCURY_TRACE/substrate profile)' }
      }
      const t = getTraceFlushHealth()
      if (t.streak >= 3) {
        return {
          status: 'warn',
          evidence: `mercury-trace.jsonl flush failing — streak ${t.streak}, ${t.pending} pending${t.dropped > 0 ? `, ${t.dropped} dropped at the buffer cap` : ''}: ${t.lastFailure?.message ?? 'unknown'}`,
          fix: 'Check permissions/AV holds on <config-home>/mercury-trace.jsonl; records keep buffering (bounded) until appends recover.',
        }
      }
      let ageNote = 'no records this session yet'
      if (t.lastWriteOkAt !== null) {
        ageNote = `last write ${Math.max(0, Math.round((Date.now() - t.lastWriteOkAt) / 1000))}s ago`
      } else {
        try {
          const mtime = statSync(getInvocationTracePath()).mtimeMs
          ageNote = `last write ${Math.max(0, Math.round((Date.now() - mtime) / 1000))}s ago (prior session)`
        } catch (error) {
          if (!isENOENT(error)) ageNote = `prior trace unreadable (${errorMessage(error)})`
        }
      }
      return {
        status: 'ok',
        evidence:
          t.pending === 0
            ? `appends healthy · ${ageNote}`
            : `${t.pending} pending (flush scheduled) · ${ageNote}`,
      }
    },
  }
}

export function activityCheck(): CheckSpec {
  return {
    id: 'activity',
    label: 'Activity counts',
    run: async () => {
      const { getHeadlessActivity } = await import('../../../logs/activityLedger.js')
      const { getGlobalConfig } = await import('../../../config/globalConfig.js')
      const a = getHeadlessActivity()
      const startups = getGlobalConfig().numStartups ?? 0
      const last = a.lastAt > 0 ? `last headless ${new Date(a.lastAt).toISOString()} (${a.lastKind})` : 'no headless activity recorded'
      const verbs = Object.values(a.verbs ?? {}).reduce((sum, n) => sum + n, 0)
      return {
        status: 'ok',
        evidence: `interactive boots ${startups} · print ${a.print} · sdk ${a.sdk} · verbs ${verbs} · ${last}`,
      }
    },
  }
}
