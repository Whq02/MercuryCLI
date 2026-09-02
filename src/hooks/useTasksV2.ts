
import { watch, type FSWatcher } from 'node:fs'
import { resolveWatchRoot } from '../utils/watchRoot.js'
import { useEffect, useSyncExternalStore } from 'react'
import {
  getTaskListId,
  getTasksDir,
  listTasks,
  onTasksUpdated,
  resetTaskList,
  type Task,
} from '../utils/tasks.js'
import { syncDeliverablesFromTasks } from '../services/run/runCoordinator.js'
import { makeOwnerKey } from '../services/run/ownerKey.js'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { getGlobalConfig } from '../utils/config.js'
import { getTeammateContext } from '../utils/teammateContext.js'
import { useNotifications } from '../context/notifications.js'
import { useAppState, useSetAppState, type AppState } from '../state/AppState.js'
import { logForDebugging } from '../utils/debug.js'

const DEBOUNCE_MS = 50
const HIDE_DELAY_MS = 5000
const FALLBACK_POLL_MS = 5000

type ListFn = (taskListId: string) => Promise<Task[]>
type ResetFn = (
  taskListId: string,
  opts?: { onlyIfAllCompleted?: boolean },
) => Promise<boolean>
type SyncFn = () => Promise<void>

function visibleOf(tasks: Task[]): Task[] {
  return tasks.filter(
    task =>
      (task.metadata as { _internal?: boolean } | undefined)?._internal !== true,
  )
}

export class TasksV2Store {
  #listFn: ListFn
  #resetFn: ResetFn
  #syncFn: SyncFn
  #hideDelayMs: number

  #subscribers = new Set<() => void>()
  #started = false
  #generation = 0
  #hidden = true
  #snapshotCache: Task[] | undefined = undefined

  #watcher: FSWatcher | null = null
  #watchedDir: string | null = null
  #unsubscribeSignal: (() => void) | null = null
  #debounceTimer: NodeJS.Timeout | null = null
  #hideTimer: NodeJS.Timeout | null = null
  #pollTimer: NodeJS.Timeout | null = null
  #fetchRunning = false
  #fetchDirty = false

  constructor(injected?: {
    listTasksImpl?: ListFn
    resetTaskListImpl?: ResetFn
    syncDeliverablesImpl?: SyncFn
    hideDelayMs?: number
  }) {
    this.#listFn = injected?.listTasksImpl ?? listTasks
    this.#resetFn = injected?.resetTaskListImpl ?? resetTaskList
    this.#syncFn =
      injected?.syncDeliverablesImpl ??
      (async () => {
        await syncDeliverablesFromTasks(
          makeOwnerKey({
            workspace: getOriginalCwd(),
            sessionId: getSessionId(),
            lane: 'main',
          }),
        )
      })
    this.#hideDelayMs = injected?.hideDelayMs ?? HIDE_DELAY_MS
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#subscribers.add(listener)
    if (!this.#started) this.#start()
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.#subscribers.delete(listener)
      if (this.#subscribers.size === 0) this.#stop()
    }
  }

  getSnapshot = (): Task[] | undefined => {
    return this.#hidden ? undefined : this.#snapshotCache
  }

  #notify(): void {
    for (const listener of this.#subscribers) listener()
  }

  #publish(tasks: Task[], hidden: boolean): void {
    this.#hidden = hidden
    this.#snapshotCache = hidden ? undefined : tasks
    this.#notify()
  }

  #start(): void {
    this.#started = true
    this.#unsubscribeSignal = onTasksUpdated(() => this.#scheduleRead())
    void this.#fetch()
  }

  #stop(): void {
    this.#started = false
    this.#generation++
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = null
    this.#unsubscribeSignal?.()
    this.#unsubscribeSignal = null
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer)
    this.#debounceTimer = null
    if (this.#hideTimer !== null) clearTimeout(this.#hideTimer)
    this.#hideTimer = null
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer)
    this.#pollTimer = null
    this.#fetchRunning = false
    this.#fetchDirty = false
  }

  #dead(generation: number): boolean {
    return !this.#started || generation !== this.#generation
  }

  #scheduleRead(): void {
    if (!this.#started) return
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer)
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null
      void this.#fetch()
    }, DEBOUNCE_MS)
  }

  #repointWatcher(): void {
    if (!this.#started) return
    const dir = getTasksDir(getTaskListId())
    if (this.#watcher !== null && this.#watchedDir === dir) return
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = null
    try {
      const watcher = watch(resolveWatchRoot(dir), () => this.#scheduleRead())
      watcher.on('error', error =>
        logForDebugging(`tasks watcher error: ${error}`),
      )
      watcher.unref?.()
      this.#watcher = watcher
      this.#watchedDir = dir
    } catch (error) {
      logForDebugging(`tasks watcher failed for ${dir}: ${error}`)
    }
  }

  async #fetch(): Promise<void> {
    const generation = this.#generation
    if (this.#dead(generation)) return
    if (this.#fetchRunning) {
      this.#fetchDirty = true
      return
    }
    this.#fetchRunning = true
    try {
      do {
        this.#fetchDirty = false
        const listId = getTaskListId()
        this.#repointWatcher()
        let tasks: Task[]
        try {
          tasks = await this.#listFn(listId)
        } catch (error) {
          logForDebugging(`tasks read failed: ${error}`)
          tasks = []
        }
        if (this.#dead(generation)) return
        const visible = visibleOf(tasks)
        const anyIncomplete = visible.some(task => task.status !== 'completed')
        if (anyIncomplete || visible.length === 0) {
          if (this.#hideTimer !== null) {
            clearTimeout(this.#hideTimer)
            this.#hideTimer = null
          }
          this.#publish(visible, visible.length === 0)
        } else {
          this.#publish(visible, false)
          if (this.#hideTimer === null) this.#armHideTimer(generation, listId)
        }
        this.#schedulePoll(anyIncomplete)
      } while (this.#fetchDirty && !this.#dead(generation))
    } finally {
      this.#fetchRunning = false
    }
  }

  #armHideTimer(generation: number, scheduledListId: string): void {
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = null
      void (async () => {
        if (this.#dead(generation)) return
        if (getTaskListId() !== scheduledListId) return
        let tasks: Task[]
        try {
          tasks = await this.#listFn(scheduledListId)
        } catch {
          return
        }
        if (this.#dead(generation)) return
        const visible = visibleOf(tasks)
        if (visible.length === 0) return
        if (!visible.every(task => task.status === 'completed')) return
        try {
          await this.#syncFn()
        } catch (error) {
          logForDebugging(`deliverable sync failed (non-fatal): ${error}`)
        }
        if (this.#dead(generation)) return
        let wiped = false
        try {
          wiped = await this.#resetFn(scheduledListId, {
            onlyIfAllCompleted: true,
          })
        } catch (error) {
          logForDebugging(`task reset failed: ${error}`)
        }
        if (this.#dead(generation)) return
        if (wiped) {
          this.#publish([], true)
        } else {
          void this.#fetch()
        }
      })()
    }, this.#hideDelayMs)
  }

  #schedulePoll(anyIncomplete: boolean): void {
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    if (!anyIncomplete || !this.#started) return
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null
      this.#scheduleRead()
    }, FALLBACK_POLL_MS)
    this.#pollTimer.unref?.()
  }

  _statsForProofs(): {
    started: boolean
    subscribers: number
    generation: number
    fetchRunning: boolean
    watcher: boolean
    debounceTimer: boolean
    hideTimer: boolean
    pollTimer: boolean
  } {
    return {
      started: this.#started,
      subscribers: this.#subscribers.size,
      generation: this.#generation,
      fetchRunning: this.#fetchRunning,
      watcher: this.#watcher !== null,
      debounceTimer: this.#debounceTimer !== null,
      hideTimer: this.#hideTimer !== null,
      pollTimer: this.#pollTimer !== null,
    }
  }
}

const sharedStore = new TasksV2Store()

const noopSubscribe = (): (() => void) => () => {}
const undefinedSnapshot = (): undefined => undefined

function useTasksEnabled(): boolean {
  const teamContext = useAppState((s: AppState) => s.teamContext)
  if (getGlobalConfig().todoFeatureEnabled === false) return false
  if (teamContext === undefined) return true
  if (teamContext.isLeader === true) return true
  return getTeammateContext() === null && teamContext.selfAgentId === undefined
}

export function useTasksV2(): Task[] | undefined {
  const enabled = useTasksEnabled()
  return useSyncExternalStore(
    enabled ? sharedStore.subscribe : noopSubscribe,
    enabled ? sharedStore.getSnapshot : undefinedSnapshot,
    enabled ? sharedStore.getSnapshot : undefinedSnapshot,
  )
}

export function useTasksV2WithCollapseEffect(): Task[] | undefined {
  const tasks = useTasksV2()
  const setAppState = useSetAppState()
  useNotifications()
  useEffect(() => {
    if (tasks !== undefined) return
    setAppState(prev =>
      prev.expandedView === 'tasks'
        ? { ...prev, expandedView: 'none' as const }
        : prev,
    )
  }, [tasks, setAppState])
  return tasks
}
