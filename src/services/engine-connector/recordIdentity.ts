import type { Message } from '../../types/message.js'

export interface RecordMergeResult {
  records: Message[]
  sigs: string[]
  reusedAll: boolean
}

export function mergeRecordsContentKeyed(
  prevRecords: readonly Message[],
  prevSigs: readonly string[],
  raw: readonly unknown[],
  fresh: Message[],
): RecordMergeResult {
  const sigs = new Array<string>(raw.length)
  let reusedAll = fresh.length === prevRecords.length
  for (let i = 0; i < fresh.length; i++) {
    const sig = JSON.stringify(raw[i])
    sigs[i] = sig
    const prev = prevRecords[i]
    if (prev !== undefined && sig === prevSigs[i]) fresh[i] = prev as Message
    else reusedAll = false
  }
  return { records: fresh, sigs, reusedAll }
}
