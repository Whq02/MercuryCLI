import * as React from 'react'
import { GLYPH, truncateToWidth } from '../../theme/glyphs.js'
import { correctFact, pinPendingRow, replacePendingRow, retireFact, strikePendingRow } from '../../../sessions/mneme/mnemeCorrect.js'
import { runDueMaintenance } from '../../../sessions/mneme/mnemeMaintenance.js'
import { readPinnedStatus } from '../../../sessions/mneme/mnemeFrontPage.js'
import { handoverIfDue, renderHandoverReceipt } from '../../../sessions/mneme/mnemeHandover.js'
import { formatTextSize, pinFact, unpinFact } from '../../../sessions/mneme/mnemeUsage.js'
import { getMnemeHome } from '../../../sessions/mneme/paths.js'
import { NEXT_SESSION_WORDS, type Page, type OpenRef, type CentreCorrecting, type CentreFlatList } from './refs.js'

export type CentreActions = {
  fl: CentreFlatList
  setPageOffset: React.Dispatch<React.SetStateAction<number>>
  setPage: React.Dispatch<React.SetStateAction<Page | null>>
  correcting: CentreCorrecting | null
  detail: OpenRef | null
  setCorrecting: React.Dispatch<React.SetStateAction<CentreCorrecting | null>>
  setDetail: React.Dispatch<React.SetStateAction<OpenRef | null>>
}

export function openPageOf({ setPageOffset, setPage }: CentreActions, next: Page): void {
  setPageOffset(next.focus === undefined ? 0 : Math.max(0, next.focus - 2))
  setPage(next)
}

export function runMaintenanceOf({ fl }: CentreActions): void {
  if (fl.busyRef.current) return
  fl.busyRef.current = true
  fl.setNote({ text: 'running memory maintenance …', kind: 'pending' })
  void runDueMaintenance('operator', { force: true })
    .then(out =>
      fl.setNote(
        out.ran
          ? { text: `${GLYPH.check} maintenance: ${out.reason}${out.entries ? ` — ${out.entries} entr${out.entries === 1 ? 'y' : 'ies'} consolidated` : ''}`, kind: 'ok' }
          : { text: `maintenance skipped: ${out.reason}`, kind: 'warn' },
      ),
    )
    .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} maintenance failed: ${String(e)}`, kind: 'fail' }))
    .finally(() => {
      fl.busyRef.current = false
      fl.reload()
    })
}

export function runIntakeOf({ fl }: CentreActions): void {
  if (fl.busyRef.current) return
  fl.busyRef.current = true
  fl.setNote({ text: 'taking the existing notes into memory …', kind: 'pending' })
  try {
    const receipt = handoverIfDue(getMnemeHome())
    fl.setNote(receipt ? { text: `${GLYPH.check} ${renderHandoverReceipt(receipt)[0]}`, kind: 'ok' } : { text: 'nothing to take in', kind: 'warn' })
  } catch (e) {
    fl.setNote({ text: `${GLYPH.fail} intake failed: ${String(e)}`, kind: 'fail' })
  } finally {
    fl.busyRef.current = false
    fl.reload()
  }
}

export function togglePinOf({ fl }: CentreActions, seq: number, pin: boolean): void {
  if (fl.busyRef.current) return
  fl.busyRef.current = true
  try {
    if (pin) pinFact(seq, undefined, undefined, { asked: true })
    else unpinFact(seq)
  } catch (e) {
    fl.setNote({ text: `${GLYPH.fail} pin failed: ${String(e)}`, kind: 'fail' })
    fl.busyRef.current = false
    fl.reload()
    return
  }
  fl.setNote({ text: pin ? 'pinning — republishing the front page …' : 'unpinning — republishing the front page …', kind: 'pending' })
  void runDueMaintenance('operator', { force: true })
    .then(() => {
      const status = readPinnedStatus()
      const over = status?.over ? ` — the shelf is over its limit (${formatTextSize(status.used)} of ${formatTextSize(status.limit)}); every rule still loads` : ''
      const undo = pin ? 'u unpins it again' : 'p pins it again'
      fl.setNote({ text: `${GLYPH.check} seq ${seq} ${pin ? 'pinned word for word, asked for by you' : 'unpinned'} · ${undo} · ${NEXT_SESSION_WORDS}${over}`, kind: over ? 'warn' : 'ok' })
    })
    .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} pin failed: ${String(e)}`, kind: 'fail' }))
    .finally(() => {
      fl.busyRef.current = false
      fl.reload()
    })
}

export function commitCorrectionOf({ fl, correcting, detail, setCorrecting, setDetail }: CentreActions): void {
  if (!correcting || !detail) return
  const text = correcting.buffer.trim()
  if (!text) {
    fl.setNote({ text: 'correction text is empty — nothing changed', kind: 'warn' })
    setCorrecting(null)
    return
  }
  if (correcting.seq === null) {
    const r = correcting.ts === null ? null : replacePendingRow({ ts: correcting.ts, text, source: 'operator', byUser: true })
    if (r !== null && r.ok) {
      fl.setNote({ text: `${GLYPH.check} corrected the pending fact — the old wording is struck, the new one consolidates in its place · ${NEXT_SESSION_WORDS}`, kind: 'ok' })
      setDetail(null)
    } else {
      fl.setNote({ text: `${GLYPH.fail} correction ${r?.code ?? 'invalid'}: ${truncateToWidth(r?.message ?? 'no pending row to correct', 48)}`, kind: 'fail' })
    }
    setCorrecting(null)
    fl.reload()
    return
  }
  const r = correctFact({ targetSeq: correcting.seq, text, source: 'operator', byUser: true })
  if (r.ok) {
    fl.setNote({ text: `${GLYPH.check} corrected seq ${r.targetSeq} → ${r.seq} (old kept as history) · ${NEXT_SESSION_WORDS}`, kind: 'ok' })
    setDetail(null)
  } else {
    fl.setNote({ text: `${GLYPH.fail} correction ${r.code}: ${truncateToWidth(r.message, 48)}`, kind: 'fail' })
  }
  setCorrecting(null)
  fl.reload()
}

export function retirePendingOf({ fl, setDetail }: CentreActions, ts: string): void {
  const r = strikePendingRow({ ts, byUser: true })
  fl.setNote(
    r.ok
      ? { text: `${GLYPH.check} retired the pending fact — struck before it consolidated · ${NEXT_SESSION_WORDS}`, kind: 'ok' }
      : { text: `${GLYPH.fail} retire ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
  )
  if (r.ok) setDetail(null)
  fl.reload()
}

export function pinPendingOf({ fl, setDetail }: CentreActions, ts: string): void {
  const r = pinPendingRow({ ts, byUser: true })
  fl.setNote(
    r.ok
      ? { text: `${GLYPH.check} pinned word for word, asked for by you — it lands pinned when it consolidates · ${NEXT_SESSION_WORDS}`, kind: 'ok' }
      : { text: `${GLYPH.fail} pin ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
  )
  if (r.ok) setDetail(null)
  fl.reload()
}

export function retireSelectedOf({ fl, setDetail }: CentreActions, seq: number): void {
  const r = retireFact({ targetSeq: seq, reason: 'operator marked no longer current', source: 'operator', byUser: true })
  fl.setNote(
    r.ok
      ? { text: `${GLYPH.check} retired seq ${r.targetSeq} — kept in history · ${NEXT_SESSION_WORDS}`, kind: 'ok' }
      : { text: `${GLYPH.fail} retire ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
  )
  if (r.ok) setDetail(null)
  fl.reload()
}
