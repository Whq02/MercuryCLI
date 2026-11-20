import type { ChildProcess } from 'node:child_process'
import { logForDebugging } from '../../utils/debug.js'
import { recordSpawnExit } from '../../utils/spawnLedger.js'
import { flagPair } from '../../substrate/flagRegistry.js'
import {
  decideRespawn,
  keepStderrTail,
  lastStderrLine,
  DEFAULT_HEALTHY_RESET_MS,
} from '../longLivedRespawn.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import type { LongLivedSeat, RosterOptions, WorkerHandle } from './types.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'

const EXIT_DRAIN_BACKSTOP_MS = 2_000

interface LifeNeeds {
  spawnLongLived(short: string): number | undefined
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
    void import('../concourseWorkers.js')
      .then(async sup => {
        sup.completeRequestedStop(short)
        await sup.completeFencedRetirement(short)
      })
      .catch(passedOver)
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
        void import('../concourseWorkers.js')
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
      if (ll.intentionalStop) {
        h.entry.state = 'settled'
        h.entry.outcome = 'killed'
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
        ll.respawnTimer = startTimeout(() => this.needs.spawnLongLived(short), 0)
        ll.respawnTimer.unref?.()
        return
      }
      const keptText = ll.lastErrorText || lastStderrLine(ll.stderrTail)
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
      const tellCrashed = (): void => {
        try {
          this.opts.onChildCrashed?.(short)
        } catch (e) {
          logForDebugging(`[daemon] onChildCrashed(${short}) hook threw (ignored): ${e}`)
        }
      }
      logForDebugging(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})`,
      )
      console.error(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})${keptText ? ` — ${keptText}` : ''}`,
      )
      const stampCrash = (respawning: boolean, detail?: string): void => {
        if (!short.startsWith('concourse-w')) return
        const exitWords = `exit ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''}`
        const reason =
          detail ??
          `crashed mid-run (${exitWords})${keptText ? ` — ${keptText}` : ''}${respawning ? ' · resumed — the interrupted ask needs a re-send' : ''}`
        void import('../concourseWorkers.js')
          .then(sup => sup.markConcourseWorkerCrash(short, { reason, respawning }))
          .catch(passedOver)
      }
      if (decision.action === 'degrade') {
        this.degradedSeats.set(short, decision.reason)
        const degradedReason = `${short}: ${decision.reason}`
        h.entry.state = 'crashed'
        h.entry.outcome = 'degraded'
        ledgerExit('degraded', decision.reason)
        stampCrash(false, `crashed — respawns exhausted (${decision.reason})`)
        logForDebugging(`[daemon] ${GLYPH.warn} DEGRADED — ${degradedReason}`)
        tellCrashed()
        try {
          this.opts.onDegraded?.(degradedReason, short)
        } catch (error) {
          passedOver(error)
        }
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
      ll.respawnTimer = startTimeout(() => this.needs.spawnLongLived(short), decision.delayMs)
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
