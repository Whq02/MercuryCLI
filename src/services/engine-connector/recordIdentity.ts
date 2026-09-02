// ============================================================================
//  engine-connector/recordIdentity — the transcript calm law's CONTENT-KEYED
//  merge as pure math (the provable-without-a-live-file doctrine): every
//  daemon tick re-reads the whole transcript file and re-mints every record;
//  this seam decides, per index, whether the previous tick's OBJECT stands
//  in for the fresh one.
//
//  BOTH DIRECTIONS ARE THE LAW (lead ruling, the pool pin drives
//  each):
//   · unchanged bytes at an index ⇒ the SAME object the last parse minted —
//     MessageRow's identity memo bails and only moved rows reconcile (the
//     churn kill);
//   · changed bytes at an index ⇒ the FRESH object carrying the new content
//     — reuse here would paint a stale row forever (the stale-paint kill,
//     the worse bug than the churn);
//   · a shifted/compacted file falls out conservatively: signatures are
//     positional, so every index from the shift on takes fresh identity;
//   · a byte-identical whole read reports `reusedAll` so the caller keeps
//     its ARRAY identity and wakes no listener at all.
// ============================================================================
import type { Message } from '../../types/message.js'

export interface RecordMergeResult {
  /** The merged records — the `fresh` array, reused objects written in. */
  records: Message[]
  /** The signatures of THIS parse — the caller carries them to the next. */
  sigs: string[]
  /** Every index reused AND the length held: the caller keeps its previous
   *  array and repaints nothing. */
  reusedAll: boolean
}

/**
 * Merge freshly-deserialized records against the previous tick's objects.
 * `raw` is the parsed transcript the fresh records were deserialized from
 * 1:1 (index-aligned — deserializeLiveMessages is a per-record map; the
 * pool pin drives that alignment); each raw record's serialization is its
 * content signature — or, when the caller hands a signer, whatever that
 * signer answers (the transcript reader signs a row by the identity token
 * it minted for the record's bytes, so an unchanged record costs no
 * re-serialization). Mutates `fresh` in place (the caller owns it) and
 * returns it as `records`.
 */
export function mergeRecordsContentKeyed(
  prevRecords: readonly Message[],
  prevSigs: readonly string[],
  raw: readonly unknown[],
  fresh: Message[],
  sigOf: (record: unknown) => string = record => JSON.stringify(record),
): RecordMergeResult {
  const sigs = new Array<string>(raw.length)
  let reusedAll = fresh.length === prevRecords.length
  for (let i = 0; i < fresh.length; i++) {
    const sig = sigOf(raw[i])
    sigs[i] = sig
    const prev = prevRecords[i]
    if (prev !== undefined && sig === prevSigs[i]) fresh[i] = prev as Message
    else reusedAll = false
  }
  return { records: fresh, sigs, reusedAll }
}
