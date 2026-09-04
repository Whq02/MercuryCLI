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
  freshTail: Message[],
  sigOf: (record: unknown) => string = record => JSON.stringify(record),
  since = 0,
): RecordMergeResult {
  const keep = Math.max(0, Math.min(since, prevRecords.length, prevSigs.length, raw.length))
  const sigs = new Array<string>(raw.length)
  const records = new Array<Message>(raw.length)
  for (let i = 0; i < keep; i++) {
    records[i] = prevRecords[i] as Message
    sigs[i] = prevSigs[i] as string
  }
  let reusedAll = raw.length === prevRecords.length
  for (let i = keep; i < raw.length; i++) {
    const sig = sigOf(raw[i])
    sigs[i] = sig
    const prev = prevRecords[i]
    const fresh = freshTail[i - keep]
    if (prev !== undefined && sig === prevSigs[i]) records[i] = prev as Message
    else {
      records[i] = fresh as Message
      reusedAll = false
    }
  }
  return { records, sigs, reusedAll }
}
