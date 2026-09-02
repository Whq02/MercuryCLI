import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../envUtils.js'
import type { RawReadResult } from './rawRead.js'

/**
 * FN-020 row 4 — the Windows policy-probe memo.
 *
 * Every win32 boot fires four `reg query` spawns at module evaluation and
 * awaited them in the commander preAction before the settings merge — on an
 * unmanaged machine (the bulk of a public launch audience) four process
 * creations per boot, forever, for an always-empty answer, with the
 * observed multi-second tail under an inspecting AV. macOS skips the spawn
 * when no plist exists; the registry has no spawn-free probe, so the memo IS
 * the probe: the outcome of the last COMPLETED read persists in the config
 * home ({present, checkedAt}). When it says absent the boot does not await
 * the read — the merge proceeds with no policy tier exactly as it does on
 * that machine today — while the read still fires in the background,
 * fills the tier caches when it lands, and rewrites the record. A read that
 * ever finds a value records present, so the next boot awaits again.
 * Present-or-no-record keeps the awaiting boot byte-for-byte.
 *
 * The named trade: a machine that has JUST received policy runs one boot
 * without the tier at the barrier; the tier still lands in that boot when
 * the background read completes (the poll's own apply shape), and the next
 * boot awaits. The memo is a speed hint, never a policy input: a torn,
 * missing or malformed record reads as "await".
 */
export interface MdmProbeMemoV1 {
  schema: 1
  present: boolean
  checkedAt: number
}

export function mdmProbeMemoPath(home: string = getMercuryHome()): string {
  return join(home, 'mdm-probe.json')
}

export function readMdmProbeMemo(home?: string): MdmProbeMemoV1 | null {
  try {
    const raw = JSON.parse(readFileSync(mdmProbeMemoPath(home), 'utf8')) as Partial<MdmProbeMemoV1> | null
    if (!raw || raw.schema !== 1 || typeof raw.present !== 'boolean' || typeof raw.checkedAt !== 'number') return null
    return { schema: 1, present: raw.present, checkedAt: raw.checkedAt }
  } catch {
    return null
  }
}

/** Best-effort: a failed write leaves no record (or the old one), which awaits. */
export function writeMdmProbeMemo(present: boolean, home?: string): void {
  try {
    const path = mdmProbeMemoPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ schema: 1, present, checkedAt: Date.now() } satisfies MdmProbeMemoV1)}\n`)
  } catch {
    /* the memo is a speed hint, never a policy input */
  }
}

/** Record a completed raw read's outcome — win32 only (the plist road has
 *  its own spawn-free existence check). A registry value in EITHER hive is
 *  "present" (a successful `reg query` exit), so an empty-payload value
 *  still awaits next boot: conservative by construction. */
export function recordMdmProbeOutcome(raw: RawReadResult, platform: string = process.platform, home?: string): void {
  if (platform !== 'win32') return
  writeMdmProbeMemo(raw.hklmStdout !== null || raw.hkcuStdout !== null, home)
}

/** Whether the boot barrier awaits the raw policy read: always, except on
 *  win32 when the memo says the last completed read found no registry value. */
export function mdmBootAwaitsRawRead(platform: string = process.platform, home?: string): boolean {
  if (platform !== 'win32') return true
  const memo = readMdmProbeMemo(home)
  return memo === null || memo.present !== false
}
