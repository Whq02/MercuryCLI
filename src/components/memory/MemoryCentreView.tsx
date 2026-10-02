import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from '../mercury-ui/components.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useFlatList } from '../mercury-ui/useFlatList.js'
import { collectMemoryRefs, type MemoryRef } from '../../memdir/memoryRefs.js'
import { correctFact, retireFact } from '../../memdir/mnemeCorrect.js'
import { mnemeEnabled } from '../../memdir/mnemeGates.js'
import {
  mnemeStatus,
  readMaintenanceReceipts,
  runDueMaintenance,
} from '../../memdir/mnemeMaintenance.js'
import { readDocLines } from '../../memdir/mnemeRetrieval.js'
import { readPinnedStatus } from '../../memdir/mnemeFrontPage.js'
import { handoverDue, handoverIfDue, readHandoverReceipt, renderHandoverReceipt } from '../../memdir/mnemeHandover.js'
import { formatTextSize, pinFact, pinnedTextLimit, readPins, unpinFact } from '../../memdir/mnemeUsage.js'
import { getAutoMemPath } from '../../memdir/paths.js'


const MAX_ROWS = 10

const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

const STATUS_TONE: Record<MemoryRef['status'], { glyph: string; color: string; label: string }> = {
  current: { glyph: '●', color: TEAL, label: 'current' },
  unconsolidated: { glyph: '◌', color: SECOND, label: 'recent, unconsolidated' },
  'needs-review': { glyph: '▲', color: AMBER, label: 'needs review — cited path moved' },
}

interface CentreRow {
  id: string
  kind: 'ref' | 'action' | 'info'
  label: string
  ref?: MemoryRef
  run?: () => void
}

function seqOf(ref: MemoryRef): number | null {
  const m = /^mneme:(\d+)$/.exec(ref.refId)
  return m ? Number(m[1]) : null
}

function refDetail(ref: MemoryRef): string[] {
  const lines: string[] = []
  if (ref.kind === 'mneme-topic' || ref.kind === 'mneme-fact') {
    const slug = ref.kind === 'mneme-topic' ? ref.refId.slice('mneme-topic:'.length) : ref.deref.replace(/^Recall read:"doc:/, '').replace(/"$/, '')
    const r = readDocLines(slug, {})
    if (r) {
      lines.push(...r.content.split('\n').slice(0, 14))
      if (r.recent.length > 0) lines.push(`(+${r.recent.length} recent unconsolidated)`)
    } else lines.push('(topic page unavailable)')
  } else {
    lines.push(ref.summary, '(unconsolidated — consolidates at the next maintenance pass)')
  }
  return lines
}

export function pinnedShelfWords(status: { pinned: number; used: number; limit: number; over: boolean } | null): string {
  const limit = status?.limit ?? pinnedTextLimit()
  if (!status || status.pinned === 0) return `pinned rules: none — ${formatTextSize(limit)} of room; search a fact and press p to pin it, word for word`
  const fill = `${formatTextSize(status.used)} of ${formatTextSize(limit)}`
  return status.over
    ? `pinned rules: ${status.pinned} · ${fill} — over the limit, all still loaded; press u on a rule to unpin, or raise the limit in /config`
    : `pinned rules: ${status.pinned} · ${fill} — loaded word for word every session`
}

export function MemoryCentreView({ onClose, onOpenFiles }: { onClose: () => void; onOpenFiles?: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const [query, setQuery] = React.useState('')
  const [detail, setDetail] = React.useState<MemoryRef | null>(null)
  const detailLines = React.useMemo(() => (detail ? refDetail(detail) : []), [detail])
  const [correcting, setCorrecting] = React.useState<{ seq: number; buffer: string } | null>(null)

  const buildRows = React.useCallback(async (): Promise<CentreRow[]> => {
    if (query.trim().length > 0) {
      const pins = new Set(readPins().map(p => p.seq))
      const refs = collectMemoryRefs(query, { maxRefs: 12 })
      return refs.map(r => {
        const seq = seqOf(r)
        return { id: r.refId, kind: 'ref' as const, label: `${seq !== null && pins.has(seq) ? 'pinned · ' : ''}${r.summary}`, ref: r }
      })
    }
    const rows: CentreRow[] = []
    const st = mnemeStatus()
    rows.push({
      id: 'facts',
      kind: 'info',
      label: st.enabled
        ? `project facts & decisions: ${st.entryCount} current · ${st.buffered + st.pendingConsuming} recent · ${st.historyCount} history · ${st.topicCount} topics`
        : 'project facts & decisions: off — memory is disabled in settings (memory.enabled)',
    })
    if (st.enabled) {
      rows.push({ id: 'pinned', kind: 'info', label: pinnedShelfWords(readPinnedStatus()) })
      const intake = readHandoverReceipt()
      if (intake) {
        const [first, pages] = renderHandoverReceipt(intake)
        rows.push({ id: 'intake', kind: 'info', label: `notes taken in: ${first} · ${pages}` })
      } else if (handoverDue(getAutoMemPath())) {
        rows.push({ id: 'intake', kind: 'action', label: 'notes to take in: the existing notes are not in memory yet — ↵ take them in now', run: () => {} })
      }
      const due = st.due ? `DUE — ${st.dueReason}` : st.running ? 'running' : 'idle'
      const degraded = st.degraded.length > 0 ? ` · ${GLYPH.fail} ${st.degraded[0]}` : ''
      rows.push({
        id: 'maintenance',
        kind: 'action',
        label: `maintenance: ${due} · last ${st.lastConsolidatedAt ? st.lastConsolidatedAt.slice(0, 16) : 'never'}${degraded} — ↵ run now`,
        run: () => {},
      })
      for (const r of readMaintenanceReceipts(undefined, 3).reverse()) {
        rows.push({
          id: `act-${r.ts}`,
          kind: 'info',
          label: `  ${r.ts.slice(5, 16)} ${r.trigger}: ${r.reason}${r.entries ? ` (${r.entries} entries)` : ''}`,
        })
      }
    }
    rows.push({ id: 'files', kind: 'action', label: 'instruction files (MERCURY.md, editor, the memory switch) — ↵ open picker', run: onOpenFiles })
    return rows
  }, [query, onOpenFiles])

  const fl = useFlatList<CentreRow>({
    load: buildRows,
    maxRows: MAX_ROWS,
    charKeys: false,
    onClose: () => {
      if (correcting) setCorrecting(null)
      else if (detail) setDetail(null)
      else if (query) {
        setQuery('')
      } else onClose()
    },
    onPrimary: row => {
      if (row.kind === 'ref' && row.ref) setDetail(row.ref)
      else if (row.id === 'maintenance') runMaintenance()
      else if (row.id === 'intake' && row.kind === 'action') runIntake()
      else if (row.id === 'files' && onOpenFiles) onOpenFiles()
    },
    reloadNote: 're-read memory stores',
    rowId: r => r.id,
  })

  const reloadRef = React.useRef(fl.reload)
  reloadRef.current = fl.reload
  React.useEffect(() => {
    reloadRef.current()
  }, [query])

  function runMaintenance(): void {
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

  function runIntake(): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    fl.setNote({ text: 'taking the existing notes into memory …', kind: 'pending' })
    try {
      const receipt = handoverIfDue(getAutoMemPath())
      fl.setNote(receipt ? { text: `${GLYPH.check} ${renderHandoverReceipt(receipt)[0]}`, kind: 'ok' } : { text: 'nothing to take in', kind: 'warn' })
    } catch (e) {
      fl.setNote({ text: `${GLYPH.fail} intake failed: ${String(e)}`, kind: 'fail' })
    } finally {
      fl.busyRef.current = false
      fl.reload()
    }
  }

  function togglePin(seq: number, pin: boolean): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    if (pin) pinFact(seq, undefined, undefined, { asked: true })
    else unpinFact(seq)
    fl.setNote({ text: pin ? 'pinning — republishing the front page …' : 'unpinning — republishing the front page …', kind: 'pending' })
    void runDueMaintenance('operator', { force: true })
      .then(() => {
        const status = readPinnedStatus()
        const over = status?.over ? ` — the shelf is over its limit (${formatTextSize(status.used)} of ${formatTextSize(status.limit)}); every rule still loads` : ''
        fl.setNote({ text: `${GLYPH.check} seq ${seq} ${pin ? 'pinned word for word, marked as asked for by you' : 'unpinned'}${over}`, kind: over ? 'warn' : 'ok' })
      })
      .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} pin failed: ${String(e)}`, kind: 'fail' }))
      .finally(() => {
        fl.busyRef.current = false
        fl.reload()
      })
  }

  function commitCorrection(): void {
    if (!correcting || !detail) return
    const text = correcting.buffer.trim()
    if (!text) {
      fl.setNote({ text: 'correction text is empty — nothing changed', kind: 'warn' })
      setCorrecting(null)
      return
    }
    const r = correctFact({ targetSeq: correcting.seq, text, source: 'operator' })
    if (r.ok) {
      fl.setNote({ text: `${GLYPH.check} corrected seq ${r.targetSeq} → ${r.seq} (old kept as history)`, kind: 'ok' })
      setDetail(null)
    } else {
      fl.setNote({ text: `${GLYPH.fail} correction ${r.code}: ${truncateToWidth(r.message, 48)}`, kind: 'fail' })
    }
    setCorrecting(null)
    fl.reload()
  }

  function retireSelected(seq: number): void {
    const r = retireFact({ targetSeq: seq, reason: 'operator marked no longer current', source: 'operator' })
    fl.setNote(
      r.ok
        ? { text: `${GLYPH.check} retired seq ${r.targetSeq} — kept in history`, kind: 'ok' }
        : { text: `${GLYPH.fail} retire ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
    )
    if (r.ok) setDetail(null)
    fl.reload()
  }

  const detailSeq = detail ? seqOf(detail) : null
  const detailPinned = detailSeq !== null && readPins().some(p => p.seq === detailSeq)
  useInput(
    (input, key) => {
      if (correcting) {
        if (key.return) commitCorrection()
        else if (key.backspace || key.delete) setCorrecting({ ...correcting, buffer: correcting.buffer.slice(0, -1) })
        else if (input && !key.ctrl && !key.meta) setCorrecting({ ...correcting, buffer: correcting.buffer + input })
        return
      }
      if (detail) {
        if (input === 'c' && !key.ctrl && !key.meta && detailSeq !== null && mnemeEnabled()) setCorrecting({ seq: detailSeq, buffer: '' })
        else if (input === 'x' && detailSeq !== null && mnemeEnabled()) retireSelected(detailSeq)
        else if (input === 'p' && detailSeq !== null && mnemeEnabled() && !detailPinned) togglePin(detailSeq, true)
        else if (input === 'u' && detailSeq !== null && mnemeEnabled() && detailPinned) togglePin(detailSeq, false)
        return
      }
      if (loadError && input === 'r' && !key.ctrl && !key.meta) {
        fl.reload()
        return
      }
      if (key.backspace || key.delete) {
        if (query.length > 0) setQuery(q => q.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.tab && !key.escape && !key.leftArrow && !key.rightArrow) {
        setQuery(q => q + input)
      }
    },
    { isActive: true },
  )

  const { visible, above, below, clampedSel, note, loadError, list } = fl

  const footer = correcting
    ? '↵ save correction · esc cancel'
    : detail
      ? `${detailSeq !== null && mnemeEnabled() ? `c correct · x retire · ${detailPinned ? 'u unpin' : 'p pin'} · ` : ''}esc back`
      : query
        ? '↑↓ move · ↵ inspect · esc clear'
        : 'type to search · ↑↓ move · ↵ act · esc close'

  return (
    <CommandCenter view="memory" subtitle="memory centre" onClose={onClose} captureInput={false} footer={footer}>
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text color={FAINT}>{'search: '}</Text>
          <Text color={query ? IVORY : FAINT}>{query || '(type to search facts and rules)'}</Text>
          <Text color={accent}>{correcting ? '' : '▁'}</Text>
        </Box>

        {correcting && detail ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={AMBER}>{`correcting seq ${correcting.seq} — the old fact moves to history:`}</Text>
            <Text color={IVORY}>{`> ${correcting.buffer}`}<Text color={accent}>▁</Text></Text>
          </Box>
        ) : detail ? (
          <Box marginTop={1} flexDirection="column">
            <Box>
              <StateBadge state={detail.status === 'current' ? 'live' : 'gated'} label={STATUS_TONE[detail.status].label} />
              <Text color={FAINT}>{`  ${detail.refId}${detailPinned ? ' · pinned' : ''}`}</Text>
            </Box>
            <Text color={FAINT}>{truncateToWidth(`why recalled: ${detail.why}${detail.capturedAt ? ` · captured ${detail.capturedAt.slice(0, 16)}` : ''}${detail.source ? ` · source ${detail.source}` : ''}`, 76)}</Text>
            <Box marginTop={1} flexDirection="column">
              {detailLines.map((l, i) => (
                <Text key={i} color={SECOND}>{truncateToWidth(`  ${l}`, 78)}</Text>
              ))}
            </Box>
          </Box>
        ) : fl.raw === null ? (
          <Box marginTop={1}>
            <Text color={FAINT}>◓ reading memory stores …</Text>
          </Box>
        ) : loadError ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={AMBER}>{`▲ memory unreadable — ${truncateToWidth(loadError, 56)}`}</Text>
            <Text color={FAINT}>the stores are unknown, not empty · r retries</Text>
          </Box>
        ) : list.length === 0 ? (
          <Box marginTop={1}>
            <EmptyState glyph="○" title="nothing matches" hint="different words, or esc to clear the search" />
          </Box>
        ) : (
          <Box flexDirection="column">
            <SectionHeader count={list.length}>{query ? 'Matches' : 'Memory'}</SectionHeader>
            {above > 0 ? <Text color={FAINT}>{`  +${above} above`}</Text> : null}
            {visible.map((row, i) => {
              const active = i === clampedSel
              const tone = row.ref ? STATUS_TONE[row.ref.status] : null
              return (
                <Text key={row.id}>
                  <Text color={active ? accent : FAINT}>{active ? '▸ ' : '  '}</Text>
                  {tone ? <Text color={tone.color}>{`${tone.glyph} `}</Text> : <Text color={FAINT}>{row.kind === 'action' ? `${GLYPH.chevronRight} ` : '· '}</Text>}
                  <Text color={row.kind === 'info' ? SECOND : IVORY}>{truncateToWidth(row.label, 70)}</Text>
                </Text>
              )
            })}
            {below > 0 ? <Text color={FAINT}>{`  +${below} more below`}</Text> : null}
            {query && fl.selected?.ref ? (
              <Box marginTop={1}>
                <Text color={FAINT}>{truncateToWidth(`  ${fl.selected.ref.why} · ${STATUS_TONE[fl.selected.ref.status].label}`, 76)}</Text>
              </Box>
            ) : null}
          </Box>
        )}

        {note ? (
          <Box marginTop={1}>
            <Text color={NOTE_COLOR[note.kind]}>{truncateToWidth(note.text, 72)}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text color={FAINT}>facts live in topic pages; corrections keep history · pinned rules load every session · the model saves with Retain</Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}
