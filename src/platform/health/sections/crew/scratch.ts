import { binaryName } from '../../../settings/config.js'
import { errorMessage, isENOENT } from '../../../errors/errors.js'
import type { CheckSpec } from '../../healthReport.js'

export function scratchLeasesCheck(): CheckSpec {
  return {
    id: 'scratch-leases',
    label: 'Scratch leases',
    run: async () => {
      const { listScratchLeftovers } = await import('../../../files/scratchLeases.js')
      const leftovers = listScratchLeftovers()
      if (leftovers.length === 0) {
        return { status: 'ok', evidence: 'no leftover scratch leases for this project' }
      }
      const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`
      const total = leftovers.reduce((a, l) => a + l.sizeBytes, 0)
      const rows = leftovers
        .slice(0, 5)
        .map(l => `${l.owner.kind}:${l.owner.id.slice(0, 12)} ${mb(l.sizeBytes)} ${l.root} (${l.recovery})`)
      return {
        status: 'warn',
        evidence: `${leftovers.length} leftover lease(s), ${mb(total)} total · ${rows.join(' · ')}`,
        fix: 'Delete only the named lease paths, not all of /tmp.',
      }
    },
  }
}

export function sessionScratchCheck(): CheckSpec {
  return {
    id: 'session-scratch',
    label: 'Session scratchpads',
    run: async () => {
      const { idleScratchpads, scratchpadFootprint, sweepIdleScratchpads, SCRATCHPAD_WALK_ENTRIES } = await import('../../../../daemon/control/scratchpadRetention.js')
      const { retentionCutoffMs, retentionWindowDays } = await import('../../../../sessions/transcripts/retentionSweep.js')
      const { formatFileSize } = await import('../../../text/format.js')
      const none = 'only running sessions hold scratch'
      const idle = await idleScratchpads()
      let bytes = 0
      let unread = 0
      for (const dir of idle) {
        const seen = await scratchpadFootprint(dir, SCRATCHPAD_WALK_ENTRIES)
        bytes += seen.bytes
        if (!seen.whole) unread++
      }
      if (bytes === 0 && unread === 0) return { status: 'ok', evidence: none }
      const one = idle.length === 1
      const held = `${unread > 0 ? 'at least ' : ''}${formatFileSize(bytes)}`
      const aged = retentionCutoffMs() === null || unread === idle.length ? '' : ` · removed ${retentionWindowDays()} days after ${one ? 'its' : 'their'} last write`
      const large = unread === 0 ? '' : ` · ${unread} too large to scan ${unread === 1 ? 'stays' : 'stay'} until removed here`
      const evidence = `${one ? '1 session that is not running holds' : `${idle.length} sessions that are not running hold`} ${held} of scratch${aged}${large}`
      if (bytes < 1024 ** 3 && unread === 0) return { status: 'info', evidence }
      return {
        status: 'warn',
        evidence,
        fix: `Remove them (the chats stay resumable, their scratch files are deleted): press f here, or run \`${binaryName()} health --fix --only session-scratch --yes\`.`,
        remedy: {
          plan: `remove the ${one ? 'scratchpad of 1 session that is' : `scratchpads of ${idle.length} sessions that are`} not running (${held}); ${one ? 'its chat stays' : 'their chats stay'} resumable`,
          class: 'destructive' as const,
          apply: async () => {
            const { swept, kept } = await sweepIdleScratchpads()
            return { ok: kept.length === 0, note: `removed ${swept.length} scratchpad${swept.length === 1 ? '' : 's'}${kept.length === 0 ? '' : ` · ${kept.length} could not be removed`}` }
          },
          verify: async () => {
            const left = (await idleScratchpads()).length
            return { ok: left === 0, note: left === 0 ? none : `${left} still held` }
          },
        },
      }
    },
  }
}

export function lifecycleCollectionCheck(): CheckSpec {
  return {
    id: 'lifecycle-collection',
    label: 'State cleanup',
    run: async () => {
      const { getLifecycleHealth } = await import('../../../substrate/stateLifecycle.js')
      const { statSync: statSentinel } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      const { getMercuryHome: homeDir } = await import('../../../environment/envUtils.js')
      let sentinelAge: string
      try {
        const mtime = statSentinel(joinPath(homeDir(), '.last-cleanup')).mtimeMs
        const days = (Date.now() - mtime) / 86_400_000
        sentinelAge = days < 2 ? `last complete sweep ${Math.round(days * 24)}h ago` : `last complete sweep ${Math.round(days)}d ago`
      } catch (error) {
        sentinelAge = isENOENT(error) ? 'no complete sweep recorded yet' : `last sweep unreadable (${errorMessage(error)})`
      }
      const { fileHistoryStorage } = await import('../../../../sessions/transcripts/retentionSweep.js')
      const history = await fileHistoryStorage()
      sentinelAge += ` · file history ${(history.bytes / (1024 * 1024)).toFixed(1)} MB / ${history.limit / (1024 * 1024)} MB`
      if (history.bytes > history.limit) return { status: 'warn', evidence: `${sentinelAge} · cleanup pending` }
      const pass = getLifecycleHealth()
      if (pass && pass.cycleFailures > 0) {
        const firstFailure = pass.receipts.flatMap(r => r.failures.map(f => `${r.id}: ${f.path}${f.code ? ` (${f.code})` : ''}`))[0]
        return {
          status: 'warn',
          evidence: `collection failing — ${pass.cycleFailures} failure(s) this cycle${firstFailure ? `; first: ${firstFailure}` : ''} · ${sentinelAge}`,
          fix: 'Check permissions/AV holds on the named path; the sentinel is withheld until a cycle completes clean, so the sweep keeps retrying on its cadence.',
        }
      }
      const passNote = pass
        ? `last pass removed ${pass.removed}, ${pass.cycleComplete ? 'cycle complete' : 'cursor mid-cycle'}`
        : 'no pass this session'
      return { status: 'ok', evidence: `${passNote} · ${sentinelAge}` }
    },
  }
}
