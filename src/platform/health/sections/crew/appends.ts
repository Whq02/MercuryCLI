import { getHistoryFlushHealth, historyEverFlushedThisProcess } from '../../../../sessions/promptHistory.js'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../../environment/envUtils.js'
import { isENOENT } from '../../../errors/errors.js'
import type { CheckSpec } from '../../healthReport.js'

export function historyCheck(): CheckSpec {
  return {
    id: 'history',
    label: 'Prompt history appends',
    run: () => {
      const h = getHistoryFlushHealth()
      const storePath = join(getMercuryHome(), 'history.jsonl')
      try {
        if (statSync(storePath).isDirectory()) {
          return {
            status: 'warn',
            evidence: 'history.jsonl is a DIRECTORY — no append can land; the per-process counters cannot see this from a one-shot run',
            fix: 'Remove the directory at <config-home>/history.jsonl (prompts recorded elsewhere are unaffected).',
          }
        }
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
      if (h.streak >= 3) {
        return {
          status: 'warn',
          evidence: `history.jsonl flush failing — streak ${h.streak}, ${h.pending} pending: ${h.lastFailure?.message ?? 'unknown'}`,
          fix: 'Prompts are safe in memory this session. Check permissions or antivirus holds on <config-home>/history.jsonl.',
        }
      }
      const lockDir = join(getMercuryHome(), 'history.jsonl.lock')
      let ageMs: number | null = null
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
      if (ageMs !== null && ageMs > 30_000) {
        return {
          status: 'warn',
          evidence: `history.jsonl.lock is ${Math.round(ageMs / 1000)}s old — it should have self-cleared by now`,
          fix: 'If it persists with no other Mercury process running, delete the lock dir.',
        }
      }
      return {
        status: 'ok',
        evidence:
          h.pending === 0
            ? h.lastFailure === null && h.streak === 0 && !historyEverFlushedThisProcess()
              ? 'no append attempted this run · store path writable-shaped'
              : 'appends healthy'
            : `${h.pending} pending (flush scheduled)`,
      }
    },
  }
}

export function cacheClockCheck(): CheckSpec {
  return {
    id: 'cache-clock',
    label: 'Usage metering',
    run: async () => {
      const { cacheClockGateWords, cacheClockSnapshot, getCacheClockFlushHealth, NO_REQUEST_YET } = await import(
        '../../../cache-clock/cacheClock.js'
      )
      const snap = cacheClockSnapshot()
      if (!snap.engaged && snap.reason === NO_REQUEST_YET) {
        const { promptCache1hEligibility } = await import('../../../../models/roads/anthropic/requestParams.js')
        return { status: 'off', evidence: `clock not engaged in this process: ${cacheClockGateWords(promptCache1hEligibility())}` }
      }
      if (!snap.engaged) {
        return { status: 'off', evidence: `clock not engaged this session: ${snap.reason ?? 'the session is not eligible for the 1h tier'}` }
      }
      const c = getCacheClockFlushHealth()
      if (c.streak >= 3) {
        return {
          status: 'warn',
          evidence: `session rollup writes failing — streak ${c.streak}: ${c.lastFailure?.message ?? 'unknown'}`,
          fix: 'Check the project store (projects/<key>/cache-clock/sessions) for permissions/AV holds; metering state is safe in memory and rewrites whole on the next flush.',
        }
      }
      const age =
        c.lastRollupOkAt !== null
          ? `last rollup ${Math.max(0, Math.round((Date.now() - c.lastRollupOkAt) / 1000))}s ago`
          : 'no rollup written yet (flushes at 3 requests, then on cadence)'
      return { status: 'ok', evidence: `ttl ${snap.ttl ?? '?'} (${snap.cls ?? '?'}) · ${age}` }
    },
  }
}

export function pidLockReleaseCheck(): CheckSpec {
  return {
    id: 'pid-lock-release',
    label: 'Lock releases',
    run: async () => {
      const { pidLockReleaseHealth } = await import('../../../substrate/pidLock.js')
      const h = pidLockReleaseHealth()
      if (h.notRemoved.count > 0) {
        const last = h.notRemoved.last
        return {
          status: 'warn',
          evidence: `${h.notRemoved.count} lock release(s) settled ${last?.outcome ?? 'non-removed'} this session${last ? ` — last: ${last.path} (${last.fsCode ?? 'unknown'}, ${last.attempts} attempts)` : ''}`,
          fix: 'A deferred lock is reclaimed by the next boot reconcile once its owner dies; persistent failures name a permissions/AV hold on the lock path.',
        }
      }
      const retried =
        h.retriedSuccesses.count > 0
          ? `releases healthy (${h.retriedSuccesses.count} saved by the bounded retry)`
          : 'releases healthy'
      return { status: 'ok', evidence: retried }
    },
  }
}
