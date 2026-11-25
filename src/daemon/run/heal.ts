import { existsSync, watch as watchDir, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'path'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { programHome } from '../../platform/profiles/profiles.js'
import { localIpcDoorKind } from '../../platform/host-os/files.js'
import { controlKeyPath, controlSockPath, daemonStatePath, reassertControlKey } from '../control/controlSocket.js'
import { daemonHomeStands } from '../control/daemonHome.js'
import { deployedRuntime, predecessorSockPath, releaseVersionsDir } from '../control/handover.js'
import { sameBuildTree } from '../control/planeBoot.js'
import { readPlaneOwnerSync, readPlaneRecordSync } from '../control/planeRecords.js'
import type { periodicArmer } from './periodic.js'
import type { DaemonRunState } from './state.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const PLANE_HEAL_COALESCE_MS = 250

interface HealNeeds {
  controlKey: string
  persistDaemonRecord: (owner: number | null) => Promise<void>
  askLiveSessionsForFacts: () => number
  armPeriodic: ReturnType<typeof periodicArmer>
}

export function armPlaneHeal(state: DaemonRunState, { controlKey, persistDaemonRecord, askLiveSessionsForFacts, armPeriodic }: HealNeeds): void {
  const { bootBuildTree } = state
  const INSTALLED_POINTER_NAMES = new Set(['current', 'dist', 'current.txt'])
  let healInflight = false
  let healQueued = false
  let recordUnreadSaid: string | undefined
  const ownSockPath = localIpcDoorKind() === 'named-pipe' ? null : predecessorSockPath(process.pid)
  const healCheck = async (): Promise<void> => {
    if (healInflight) {
      healQueued = true
      return
    }
    healInflight = true
    try {
      if (!daemonHomeStands('the plane heal')) return
      const sockMissing = localIpcDoorKind() === 'named-pipe' ? false : !existsSync(controlSockPath())
      const keyMissing = !existsSync(controlKeyPath())
      let foreignOwner = false
      let stateMissing = false
      let takeBack = false
      const named = readPlaneOwnerSync()
      const record = named === null ? readPlaneRecordSync() : undefined
      if (record?.state === 'unreadable') {
        if (record.why !== recordUnreadSaid) {
          recordUnreadSaid = record.why
          console.error(`[daemon] the daemon record ${daemonStatePath()} is there and could not be read (${record.why}), so a live owner of the plane cannot be ruled out: the key, the record and the socket are left as they stand — the next beat reads it again; if it stays so, move it away`)
        }
        return
      }
      recordUnreadSaid = undefined
      const foreign = named ?? (record?.state === 'read' ? record.owner : null)
      if (foreign === null) stateMissing = true
      else if (foreign.pid !== process.pid) {
        foreignOwner = foreign.alive
        stateMissing = !foreignOwner
        if (foreignOwner) {
          const deployed = deployedRuntime()?.buildTree ?? null
          takeBack = sameBuildTree(deployed, bootBuildTree) && !sameBuildTree(deployed, foreign.buildTree)
        }
      }
      state.planeServedByOther = foreignOwner && !takeBack ? foreign : null
      const ownDoorOnly = foreignOwner && !takeBack
      const ownSockMissing = ownDoorOnly && ownSockPath !== null && !existsSync(ownSockPath)
      if (ownDoorOnly && !ownSockMissing) return
      if (takeBack) {
        console.error(`[daemon] pid ${foreign?.pid} of build ${foreign?.buildTree ?? 'unstamped'} took the plane from the deployed build ${bootBuildTree} — taking it back`)
      } else if (!ownDoorOnly && !sockMissing && !keyMissing && !stateMissing) return
      logForDebugging(
        `[daemon] control plane degraded (sock:${sockMissing} own:${ownSockMissing} key:${keyMissing} state:${stateMissing} takeBack:${takeBack}) — re-asserting`,
      )
      if (!ownDoorOnly) {
        await reassertControlKey(controlKey)
        await persistDaemonRecord(state.currentOwnerPid)
      }
      if ((sockMissing || ownSockMissing || takeBack) && daemonHomeStands('the plane heal')) await state.controlServer?.rebind()
    } catch (e) {
      logForDebugging(`[daemon] plane self-heal failed (the next signal or floor retries): ${e}`)
    } finally {
      healInflight = false
      if (healQueued) {
        healQueued = false
        void healCheck()
      }
    }
  }
  armPeriodic(
    'the plane heal floor',
    () => {
      void healCheck()
    },
    () => {
      if (healSignal !== undefined) stopTimeout(healSignal)
      if (installedSignal !== undefined) stopTimeout(installedSignal)
      for (const watcher of planeWatchers) watcher.close()
      for (const watcher of installedWatchers) watcher.close()
    },
  )
  const planeNames = new Set([
    basename(controlKeyPath()),
    basename(daemonStatePath()),
    ...(localIpcDoorKind() === 'named-pipe' ? [] : [basename(controlSockPath())]),
    ...(ownSockPath === null ? [] : [basename(ownSockPath)]),
  ])
  const planeDirs = new Set([dirname(controlKeyPath()), ...(localIpcDoorKind() === 'named-pipe' ? [] : [dirname(controlSockPath())]), ...(ownSockPath === null ? [] : [dirname(ownSockPath)])])
  let healSignal: ReturnType<typeof setTimeout> | undefined
  const planeWatchers: FSWatcher[] = []
  for (const planeDir of planeDirs) {
    try {
      const watcher = watchDir(planeDir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && !planeNames.has(String(name))) return
        if (healSignal !== undefined) return
        healSignal = startTimeout(() => {
          healSignal = undefined
          void healCheck()
        }, PLANE_HEAL_COALESCE_MS)
        healSignal.unref?.()
      })
      watcher.on('error', e => logForDebugging(`[daemon] plane watch on ${planeDir} failed (the floor keeps the heal): ${e}`))
      planeWatchers.push(watcher)
    } catch (e) {
      logForDebugging(`[daemon] plane watch on ${planeDir} did not arm (the floor keeps the heal): ${e}`)
    }
  }
  let installedTreeSeen = deployedRuntime()?.buildTree ?? null
  let installedSignal: ReturnType<typeof setTimeout> | undefined
  const installedCheck = (): void => {
    const tree = deployedRuntime()?.buildTree ?? null
    if (tree === installedTreeSeen) return
    installedTreeSeen = tree
    if (tree === null) return
    const asked = askLiveSessionsForFacts()
    console.error(`[daemon] the installed build moved to ${tree} — ${asked} live session(s) asked for their facts now`)
  }
  const installedWatchers: FSWatcher[] = []
  for (const pointerDir of new Set([join(programHome(), 'runtime'), releaseVersionsDir()])) {
    try {
      const watcher = watchDir(pointerDir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && !INSTALLED_POINTER_NAMES.has(String(name))) return
        if (installedSignal !== undefined) return
        installedSignal = startTimeout(() => {
          installedSignal = undefined
          installedCheck()
        }, PLANE_HEAL_COALESCE_MS)
        installedSignal.unref?.()
      })
      watcher.on('error', e => logForDebugging(`[daemon] the installed-build watch on ${pointerDir} failed (the floor keeps the check): ${e}`))
      installedWatchers.push(watcher)
    } catch (e) {
      logForDebugging(`[daemon] the installed-build watch on ${pointerDir} did not arm (the floor keeps the check): ${e}`)
    }
  }
}
