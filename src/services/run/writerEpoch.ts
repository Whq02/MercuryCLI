import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { join } from 'path'

interface EpochRecord {
  epoch: number
}

const epochStore = defineStore<EpochRecord, []>({
  name: 'writer-epoch',
  path: () => join(getMercuryHome(), 'writer-epoch.json'),
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as { epoch?: unknown }).epoch === 'number'
      ? { epoch: (raw as { epoch: number }).epoch }
      : null,
  empty: () => ({ epoch: 0 }),
  onReadFailure: 'throw',
})()

export const FALLBACK_EPOCH: number = Date.now()

let claimed: Promise<number> | null = null
let resolved: number = FALLBACK_EPOCH

export function writerEpoch(): Promise<number> {
  claimed ??= epochStore
    .mutate(current => ({ epoch: current.epoch + 1 }))
    .then(async () => {
      const next = (await epochStore.read()).epoch
      resolved = next
      return next
    })
    .catch(() => {
      resolved = FALLBACK_EPOCH
      return FALLBACK_EPOCH
    })
  return claimed
}

export function currentWriterEpoch(): number {
  return resolved
}

export function _resetWriterEpochForTesting(): void {
  claimed = null
  resolved = FALLBACK_EPOCH
}
