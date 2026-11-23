import type { ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { recordSpawnExit } from './spawnLedger.js'
import { flagPair } from '../../platform/substrate/flagRegistry.js'
import {
  decideRespawn,
  keepStderrTail,
  lastStderrLine,
  DEFAULT_HEALTHY_RESET_MS,
} from './longLivedRespawn.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import type { LongLivedSeat, RosterOptions, WorkerHandle } from './types.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const EXIT_DRAIN_BACKSTOP_MS = 2_000

interface LifeNeeds {
  spawnLongLived(short: string): number | undefined
  notifyExit(short: string): void
}

export class LifePart {
  constructor(
    private readonly opts: RosterOptions,
    private readonly degradedSeats: Map<string, string>,
    private readonly needs: LifeNeeds,
  ) {}

  keepChildStderr(short: string, child: ChildProcess, ll: LongLivedSeat): void {
    const generation = ll.spawnGeneration
    ll.stderrTail = undefined
    child.stderr?.on('error', error => {
      logForDebugging(`[daemon] ${short}: error stream closed: ${error}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        process.stderr.write(chunk)
      } catch {
        logForDebugging(`[daemon] ${short}: stderr write-through failed`)
      }
      if (ll.spawnGeneration === generation) ll.stderrTail = keepStderrTail(ll.stderrTail, chunk)
    })
  }

  completeIntentionalStop(short: string): void {
    if (!short.startsWith('concourse-w')) return
    void import('../concourse-workers/concourseWorkers.js')
      .then(async sup => {
        sup.completeRequestedStop(short)
        await sup.completeFencedRetirement(short)
      })
      .catch(e => console.error(`[daemon] ${short}: the stop was not stamped on its session record, which still reads stopping: ${errorMessage(e)}`))
  }

  superviseChildLife(
    short: string,
    h: WorkerHandle,
    ll: LongLivedSeat,
    child: ChildProcess,
  ): void {
    let lifeSettled = false
    const generation = ll.spawnGeneration
    const handleCrash = (code: number | null, signal: NodeJS.Signals | null) => {
      if (lifeSettled) return
      lifeSettled = true
      if (ll.spawnGeneration === generation) {
        ll.connection?.close('the runner exited')
        ll.connection = undefined
      }
      if (ll.turnActive && short.startsWith('concourse-w')) {
        void import('../concourse-workers/concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(passedOver)
      }
      const ledgerExit = (outcome: string, reason?: string): void =>
        recordSpawnExit({
          kind: 'long-lived',
          event: 'exit',
          id: ll.spec.agentId,
          pid: h.entry.pid,
          code,
          signal,
          outcome,
          ...(reason ? { reason } : {}),
        })
      const keptText = ll.lastErrorText || lastStderrLine(ll.stderrTail)
      const tellCrashed = (): void => {
        try {
          this.opts.onChildCrashed?.(short)
        } catch (e) {
          logForDebugging(`[daemon] onChildCrashed(${short}) hook threw (ignored): ${e}`)
        }
      }
      const stampCrash = (respawning: boolean, detail?: string): void => {
        if (!short.startsWith('concourse-w')) return
        const exitWords = `exit ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''}`
        const reason =
          detail ??
          `crashed mid-run (${exitWords})${keptText ? ` — ${keptText}` : ''}${respawning ? ' · resumed — the interrupted ask needs a re-send' : ''}`
        void import('../concourse-workers/concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerCrash(short, { reason, respawning }))
          .catch(passedOver)
      }
      const degrade = (reason: string): void => {
        this.degradedSeats.set(short, reason)
        const degradedReason = `${short}: ${reason}`
        h.entry.state = 'crashed'
        h.entry.outcome = 'degraded'
        this.needs.notifyExit(short)
        ledgerExit('degraded', reason)
        stampCrash(false, `crashed — respawns exhausted (${reason})`)
        logForDebugging(`[daemon] ${GLYPH.warn} DEGRADED — ${degradedReason}`)
        tellCrashed()
        try {
          this.opts.onDegraded?.(degradedReason, short)
        } catch (error) {
          passedOver(error)
        }
      }
      const respawn = (): void => {
        if (this.needs.spawnLongLived(short) === undefined && h.entry.outcome === undefined && h.entry.state === 'spawning') degrade('spawn failed (no pid)')
      }
      if (ll.intentionalStop) {
        h.entry.state = 'settled'
        h.entry.outcome = 'killed'
        this.needs.notifyExit(short)
        ledgerExit('killed')
        this.completeIntentionalStop(short)
        return
      }
      if (ll.reconfiguring) {
        ll.reconfiguring = false
        ll.spec = { ...ll.spec, extraEnv: { ...(ll.spec.extraEnv ?? {}), ...flagPair('MERCURY_RUNNER_RESTART_REASON', 'settings') } }
        logForDebugging(
          `[daemon] long-lived ${short} reconfiguring → immediate respawn (${ll.spec.model}@${ll.spec.effort}, no ceiling increment)`,
        )
        ledgerExit('reconfigure-respawn')
        h.entry.state = 'spawning'
        ll.respawnTimer = startTimeout(respawn, 0)
        ll.respawnTimer.unref?.()
        return
      }
      if (
        Date.now() - ll.lastSpawnAt >
        (ll.cfg.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS)
      ) {
        ll.respawns = 0
        ll.stormNotified = false
      }
      ll.respawns++
      ll.lifetimeCrashes++
      ll.ready = false
      ll.crashedAt = Date.now()
      const decision = decideRespawn(ll.respawns, ll.cfg, ll.lifetimeCrashes)
      logForDebugging(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})`,
      )
      console.error(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})${keptText ? ` — ${keptText}` : ''}`,
      )
      if (decision.action === 'degrade') {
        degrade(decision.reason)
        return
      }
      if (ll.respawns === 2 && !ll.stormNotified) {
        ll.stormNotified = true
      }
      ledgerExit('crash-respawn')
      stampCrash(true)
      ll.spec = { ...ll.spec, extraEnv: { ...(ll.spec.extraEnv ?? {}), ...flagPair('MERCURY_RUNNER_RESTART_REASON', 'crash') } }
      h.entry.state = 'spawning'
      tellCrashed()
      ll.respawnTimer = startTimeout(respawn, decision.delayMs)
      ll.respawnTimer.unref?.()
    }
    let drainBackstop: ReturnType<typeof setTimeout> | undefined
    child.on('exit', (code, signal) => {
      if (ll.intentionalStop || ll.reconfiguring) {
        handleCrash(code, signal)
        return
      }
      drainBackstop = startTimeout(() => handleCrash(code, signal), EXIT_DRAIN_BACKSTOP_MS)
      drainBackstop.unref?.()
    })
    child.on('close', (code, signal) => {
      if (drainBackstop !== undefined) stopTimeout(drainBackstop)
      handleCrash(code, signal)
    })
    child.on('error', e => {
      logForDebugging(`[daemon] long-lived ${short} spawn/runtime error: ${e}`)
      handleCrash(null, null)
    })
  }
}
