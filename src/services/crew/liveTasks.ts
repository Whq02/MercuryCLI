import { LIVE_TASK_STATUSES, liveCommsKey, liveCommsPath, listLiveTasks, subscribeLiveComms, type LiveCommsTaskV1, type LiveTaskStatus } from './liveComms.js'

export { LIVE_TASK_STATUSES }
export type { LiveCommsTaskV1, LiveTaskStatus }

export function liveCommsCrewKey(crew: string): string {
  return liveCommsKey(crew)
}

export function liveCommsTasksPath(crew: string, dir?: string): string {
  return liveCommsPath(crew, dir)
}

export async function listLiveCommsTasks(crew: string, opts: { dir?: string } = {}): Promise<LiveCommsTaskV1[]> {
  return listLiveTasks(crew, opts.dir !== undefined ? { dir: opts.dir } : undefined)
}

export function subscribeLiveCommsTasks(crew: string, listener: () => void, opts: { dir?: string } = {}): () => void {
  return subscribeLiveComms(crew, () => listener(), { immediate: false, ...(opts.dir !== undefined ? { dir: opts.dir } : {}) })
}
