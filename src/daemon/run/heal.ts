import { existsSync, watch as watchDir, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { controlKeyPath, controlSockPath, daemonStatePath, reassertControlKey } from '../controlSocket.js'
import { daemonHomeStands } from '../daemonHome.js'
import { deployedRuntime, predecessorSockPath, releaseVersionsDir } from '../handover.js'
import { sameBuildTree } from '../planeBoot.js'
import { readPlaneOwnerSync } from '../planeRecords.js'
import type { periodicArmer } from './periodic.js'
import type { DaemonRunState } from './state.js'

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
  const ownSockPath = process.platform === 'win32' ? null : predecessorSockPath(process.pid)
  const healCheck = async (): Promise<void> => {
    if (healInflight) {
      healQueued = true
      return
    }
    healInflight = true
    try {
      if (!daemonHomeStands('the plane heal')) return
      const sockMissing = process.platform === 'win32' ? false : !existsSync(controlSockPath())
      const keyMissing = !existsSync(controlKeyPath())
      let foreignOwner = false
      let stateMissing = false
      let takeBack = false
      const foreign = readPlaneOwnerSync()
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
      if (healSignal !== undefined) clearTimeout(healSignal)
      if (installedSignal !== undefined) clearTimeout(installedSignal)
      for (const watcher of planeWatchers) watcher.close()
      for (const watcher of installedWatchers) watcher.close()
    },
  )
  const planeNames = new Set([
    basename(controlKeyPath()),
    basename(daemonStatePath()),
    ...(process.platform === 'win32' ? [] : [basename(controlSockPath())]),
    ...(ownSockPath === null ? [] : [basename(ownSockPath)]),
  ])
  const planeDirs = new Set([dirname(controlKeyPath()), ...(process.platform === 'win32' ? [] : [dirname(controlSockPath())]), ...(ownSockPath === null ? [] : [dirname(ownSockPath)])])
  let healSignal: ReturnType<typeof setTimeout> | undefined
  const planeWatchers: FSWatcher[] = []
  for (const planeDir of planeDirs) {
    try {
      const watcher = watchDir(planeDir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && !planeNames.has(String(name))) return
        if (healSignal !== undefined) return
        healSignal = setTimeout(() => {
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
  for (const pointerDir of new Set([join(getMercuryHome(), 'runtime'), releaseVersionsDir()])) {
    try {
      const watcher = watchDir(pointerDir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && !INSTALLED_POINTER_NAMES.has(String(name))) return
        if (installedSignal !== undefined) return
        installedSignal = setTimeout(() => {
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
