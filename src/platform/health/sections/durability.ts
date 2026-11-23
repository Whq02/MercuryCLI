import type { CheckSpec } from '../healthReport.js'
import { getErrnoCode } from '../../errors/errors.js'

export function durabilityChecks(): CheckSpec[] {
  const scanJournals = async () => {
    const { listJournalOperations } = await import('../../substrate/operationJournal.js')
    const { changeSetJournalDir } = await import('../../../tools/engines/change-transaction/changeSetContracts.js')
    return Promise.all([changeSetJournalDir()].map(dir => listJournalOperations(dir, { strict: true })))
  }
  let scanning: ReturnType<typeof scanJournals> | null = null
  const journalScan = (): ReturnType<typeof scanJournals> =>
    (scanning ??= scanJournals().finally(() => {
      scanning = null
    }))
  return [
    {
      id: 'durable-journals',
      label: 'Operation journals',
      run: async () => {
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0)
            return true
          } catch (error) {
            const code = getErrnoCode(error)
            if (code === 'EPERM') return true
            if (code === 'ESRCH') return false
            throw error
          }
        }
        let terminal = 0
        let inFlight = 0
        let awaitingRecovery = 0
        for (const operations of await journalScan()) {
          for (const op of operations) {
            if (op.state === 'committed' || op.state === 'aborted') terminal++
            else if (alive(op.writerPid)) inFlight++
            else awaitingRecovery++
          }
        }
        const evidence = `${terminal} terminal · ${inFlight} in flight (live writers) · ${awaitingRecovery} interrupted awaiting recovery (the change-set journal)`
        if (awaitingRecovery > 0) {
          return {
            status: 'warn' as const,
            evidence,
            fix: 'A process died mid-operation. The next Mercury boot reconciles it; the journal files are the evidence.',
          }
        }
        return { status: 'ok' as const, evidence }
      },
    },
    {
      id: 'store-quarantines',
      label: 'Store quarantines',
      run: async () => {
        await journalScan()
        const { readStoreRecoveryEvents } = await import('../../substrate/storeRecovery.js')
        const events = await readStoreRecoveryEvents()
        const dayAgo = Date.now() - 24 * 60 * 60_000
        const recent = events.filter(e => {
          const t = Date.parse(e.ts)
          return Number.isFinite(t) && t >= dayAgo
        })
        if (recent.length > 0) {
          const last = recent[recent.length - 1]!
          const preservation =
            last.kind === 'read-degrade'
              ? ', bytes left in place (read-path degrade; the next mutation quarantines them)'
              : last.kind === 'refused'
                ? ', bytes left in place'
                : last.quarantinePath
                  ? `, bytes preserved at ${last.quarantinePath}`
                  : ', preservation FAILED (recorded)'
          return {
            status: 'warn' as const,
            evidence: `${recent.length} damaged-store event(s) in the last 24h (${events.length} on the ledger) — latest: ${last.store} (${last.reason})${preservation}`,
            fix:
              last.kind === 'refused'
                ? 'A durable file did not read as what it should be; the runtime left its bytes in place and read on without it. Repair or remove the file; recurring events point at disk or crash-loop trouble.'
                : 'A store held unreadable bytes; the runtime kept a quarantined copy and moved on. Recurring events point at disk or crash-loop trouble.',
          }
        }
        return {
          status: 'ok' as const,
          evidence:
            events.length === 0
              ? 'no damaged-store recoveries on the ledger'
              : `no events in the last 24h (${events.length} historical on the ledger)`,
        }
      },
    },
    {
      id: 'interview-persistence',
      label: 'Interview settlement',
      run: async () => {
        const { interviewPersistenceHealth } = await import('../../../tools/engines/interview/store.js')
        const h = interviewPersistenceHealth()
        if (h.degradedIdentities > 0 && h.lastDegraded) {
          return {
            status: 'warn' as const,
            evidence: `${h.degradedIdentities} identit${h.degradedIdentities === 1 ? 'y' : 'ies'} with a DEGRADED last settlement (retained for retry) — latest ${h.lastDegraded.sessionId}@g${h.lastDegraded.generation}: ${h.lastDegraded.error}`,
            fix: 'A durable write failed and is retained for retry. Recurring failures point at the config-home filesystem.',
          }
        }
        if (h.pendingIdentities > 0) {
          return {
            status: 'info' as const,
            evidence: `${h.pendingIdentities} identit${h.pendingIdentities === 1 ? 'y has' : 'ies have'} a pending debounced write (≤150 ms tail — normal during activity)`,
          }
        }
        return { status: 'ok' as const, evidence: 'every interview identity settled (no pending, no degraded)' }
      },
    },
    {
      id: 'publish-retry-budget',
      label: 'Publish retry budget',
      run: async () => {
        const { durablePublishHealth } = await import('../../substrate/durablePublish.js')
        const h = durablePublishHealth()
        if (h.budgetExhausted.count > 0 && h.budgetExhausted.last) {
          const l = h.budgetExhausted.last
          return {
            status: 'warn' as const,
            evidence: `${h.budgetExhausted.count} publication(s) exhausted the win32 transient-retry ladder — latest ${l.path} (${l.fsCode ?? 'transient'} through ${l.attempts} attempts over ${l.elapsedMs}ms)`,
            fix: 'Another program held the destination past the retry budget (an antivirus scanner, a search indexer, an open handle). Exclude the config home from scanners if it recurs.',
          }
        }
        if (h.retriedSuccesses.count > 0 && h.retriedSuccesses.last) {
          return {
            status: 'info' as const,
            evidence: `the transient-retry ladder saved ${h.retriedSuccesses.count} publication(s) — latest ${h.retriedSuccesses.last.path} on attempt ${h.retriedSuccesses.last.attempts}`,
          }
        }
        return { status: 'ok' as const, evidence: 'no transient rename contention observed this session' }
      },
    },
    {
      id: 'orphan-temps',
      label: 'Orphan publish temps',
      run: async () => {
        const { countOrphanDurableTemps } = await import('../../substrate/recoveryOrchestrator.js')
        const { dirs, stale } = await countOrphanDurableTemps()
        if (stale > 0) {
          return {
            status: 'info' as const,
            evidence: `${stale} stale temp(s) across ${dirs} durable dir(s) — self-healing (swept at next boot / next publish into the dir)`,
          }
        }
        return { status: 'ok' as const, evidence: `no stale publish temps across ${dirs} durable dir(s)` }
      },
    },
    {
      id: 'boot-recovery',
      label: 'Boot reconciliation',
      run: async () => {
        const { getBootRecovery, bootRecoveryStatusLine } = await import(
          '../../substrate/recoveryOrchestrator.js'
        )
        const s = getBootRecovery()
        if (s.phase === 'pending') {
          return {
            status: 'info' as const,
            evidence:
              'not run in this process — the pass runs at interactive and daemon boot, before any projection is built',
          }
        }
        if (s.phase === 'running') {
          return { status: 'info' as const, evidence: 'reconciliation in flight right now' }
        }
        const r = s.report!
        const line = bootRecoveryStatusLine(s)
        const notes = r.notes.length > 0 ? ` — ${r.notes.join('; ')}` : ''
        return {
          status: line?.tone === 'warn' ? ('warn' as const) : ('ok' as const),
          evidence: line
            ? `${line.text} (${r.durationMs}ms)${notes}`
            : `clean boot — nothing to reconcile (${r.orphanTemps.dirsSwept} dir(s) swept, ${r.changeSetJournal?.scanned ?? 0} journal op(s) scanned, ${r.durationMs}ms)${notes}`,
        }
      },
    },
    {
      id: 'durable-transaction',
      label: 'Durable transaction',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 30_000,
      run: async () => {
        const probes = await import('../healthDeepProbes.js')
        return probes.probeDurableTransaction()
      },
    },
  ]
}
