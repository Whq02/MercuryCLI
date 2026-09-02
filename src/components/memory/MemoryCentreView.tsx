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
import { listExperienceCards } from '../../memdir/experienceCards.js'
import {
  applyCurationProposals,
  proposeCuration,
  readCurationReceipts,
  readCurationSweep,
  writeCurationSweep,
} from '../../memdir/curationLoop.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { isAutoDreamEnabled } from '../../services/autoDream/config.js'

// ============================================================================
//  MemoryCentreView — the ONE practical memory front door (/memory).
//
//  The centre
//  makes every operator memory journey completable IN-HARNESS: find a memory
//  (type to search), see WHY it matched, inspect it, correct/supersede it,
//  retire it, run maintenance, and read recent activity — in plain language
//  ("project facts & decisions", "reusable lessons"), with internal names
//  (MNEME, cards) kept as secondary identity.
//
//  Grammar: the shared mercury-ui useFlatList engine (CardsView idiom) —
//  STALE-PAINT discipline, ↵-primary, error ≠ empty, actions settle in
//  place. Type-to-search filters live; ESC backs out of search → overview →
//  close. External editing stays available (o) but is never the only way.
// ============================================================================

const MAX_ROWS = 10

const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

const STATUS_TONE: Record<MemoryRef['status'], { glyph: string; color: string; label: string }> = {
  current: { glyph: '●', color: TEAL, label: 'current' },
  candidate: { glyph: '○', color: AMBER, label: 'candidate — unverified' },
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

function refDetail(ref: MemoryRef): string[] {
  const lines: string[] = []
  if (ref.kind === 'mneme-topic' || ref.kind === 'mneme-fact') {
    const slug = ref.kind === 'mneme-topic' ? ref.refId.slice('mneme-topic:'.length) : ref.deref.replace(/^mneme_read slug=/, '')
    const r = readDocLines(slug, {})
    if (r) {
      lines.push(...r.content.split('\n').slice(0, 14))
      if (r.recent.length > 0) lines.push(`(+${r.recent.length} recent unconsolidated)`)
    } else lines.push('(topic document unavailable)')
  } else if (ref.kind === 'mneme-pending') {
    lines.push(ref.summary, '(unconsolidated — consolidates at the next maintenance pass)')
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      lines.push(...readFileSync(ref.deref, 'utf8').split('\n').slice(0, 14))
    } catch {
      lines.push('(file unreadable)')
    }
  }
  return lines
}

export function MemoryCentreView({ onClose, onOpenFiles }: { onClose: () => void; onOpenFiles?: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const [query, setQuery] = React.useState('')
  const [detail, setDetail] = React.useState<MemoryRef | null>(null)
  // one disk read per SELECTED ref, not per render — the detail
  // pane re-rendered (and re-read the backing file) on every nav keypress.
  const detailLines = React.useMemo(() => (detail ? refDetail(detail) : []), [detail])
  const [correcting, setCorrecting] = React.useState<{ seq: number; buffer: string } | null>(null)

  const buildRows = React.useCallback(async (): Promise<CentreRow[]> => {
    if (query.trim().length > 0) {
      const refs = collectMemoryRefs(query, { maxRefs: 12 })
      return refs.map(r => ({ id: r.refId, kind: 'ref' as const, label: r.summary, ref: r }))
    }
    // Overview rows: status + maintenance + activity; each line plain-language.
    const rows: CentreRow[] = []
    const autoOn = isAutoMemoryEnabled()
    const cards = autoOn ? await listExperienceCards(getAutoMemPath()) : []
    const cand = cards.filter(c => !c.meta.approved).length
    const st = mnemeStatus()
    rows.push({
      id: 'facts',
      kind: 'info',
      label: st.enabled
        ? `project facts & decisions (mneme): ${st.entryCount} current · ${st.buffered + st.pendingConsuming} recent · ${st.historyCount} history · ${st.topicCount} topics`
        : 'project facts & decisions (mneme): off — enable in the boot menu (MERCURY_MNEME)',
    })
    rows.push({
      id: 'lessons',
      kind: 'info',
      label: `reusable lessons (cards): ${cards.length - cand} trusted · ${cand} candidate${cand === 1 ? '' : 's'} — review in /cards`,
    })
    rows.push({
      id: 'notes',
      kind: 'info',
      label: autoOn
        ? `auto-memory notes: on — the agent saves typed notes + MEMORY.md index here`
        : 'auto-memory notes: off (settings autoMemoryEnabled)',
    })
    rows.push({
      id: 'dream',
      kind: 'info',
      label: `nightly notes consolidation (auto-dream): ${isAutoDreamEnabled() ? 'on' : 'off'} — toggle in /memory files`,
    })
    if (autoOn) {
      // The curation engine's consent surface: proposals wait HERE until the
      // operator's ↵ (safe classes) or the consolidation agent's judgment
      // pass — the engine never applies on its own.
      const sweep = readCurationSweep(getAutoMemPath())
      const safe = sweep?.proposals.filter(p => p.safe).length ?? 0
      const judgment = (sweep?.proposals.length ?? 0) - safe
      const receipts = readCurationReceipts(getAutoMemPath()).length
      rows.push({
        id: 'curation',
        kind: 'action',
        label: sweep
          ? `curation: ${safe} safe · ${judgment} judgment proposal${safe + judgment === 1 ? '' : 's'} · ${receipts} receipt${receipts === 1 ? '' : 's'} — ↵ ${safe > 0 ? 'apply safe (audit-copied)' : 're-sweep'}`
          : 'curation: not yet swept — ↵ sweep now',
        run: () => {},
      })
    }
    if (st.enabled) {
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
    rows.push({ id: 'files', kind: 'action', label: 'instruction & note files (MERCURY.md, editor, toggles) — ↵ open picker', run: onOpenFiles })
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
      else if (row.id === 'curation') runCuration()
      else if (row.id === 'files' && onOpenFiles) onOpenFiles()
    },
    reloadNote: 're-read memory stores',
    rowId: r => r.id,
  })

  // Query edits change the row source — bump the engine read. Depend on the
  // QUERY only: fl.reload is a fresh closure every render (over the stable
  // setLoadId), so listing it would loop the effect and pin the view on
  // "reading …" forever (caught by the 80-col render).
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

  function runCuration(): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    const dir = getAutoMemPath()
    const pending = readCurationSweep(dir)
    const safe = pending?.proposals.filter(p => p.safe) ?? []
    const work =
      safe.length > 0
        ? (fl.setNote({ text: `applying ${safe.length} safe proposal${safe.length === 1 ? '' : 's'} …`, kind: 'pending' }),
          applyCurationProposals(dir, safe, { approvedBy: 'operator' }).then(async out => {
            // Re-sweep so the row reflects the store as it now is.
            await writeCurationSweep(dir, await proposeCuration(dir, { projectRoot: getProjectRoot() }))
            fl.setNote({
              text: `${GLYPH.check} applied ${out.applied.length}, refused ${out.refused.length} — audit copies kept, receipts written`,
              kind: out.refused.length === 0 ? 'ok' : 'warn',
            })
          }))
        : (fl.setNote({ text: 'sweeping the store …', kind: 'pending' }),
          proposeCuration(dir, { projectRoot: getProjectRoot() }).then(async sweep => {
            await writeCurationSweep(dir, sweep)
            fl.setNote({
              text: `${GLYPH.check} swept ${sweep.scanned} memories — ${sweep.proposals.length} proposal${sweep.proposals.length === 1 ? '' : 's'}`,
              kind: 'ok',
            })
          }))
    void work
      .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} curation failed: ${String(e)}`, kind: 'fail' }))
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

  const detailSeq = detail && /^mneme:(\d+)$/.exec(detail.refId)
  useInput(
    (input, key) => {
      if (correcting) {
        if (key.return) commitCorrection()
        else if (key.backspace || key.delete) setCorrecting({ ...correcting, buffer: correcting.buffer.slice(0, -1) })
        else if (input && !key.ctrl && !key.meta) setCorrecting({ ...correcting, buffer: correcting.buffer + input })
        return
      }
      if (detail) {
        if (input === 'c' && !key.ctrl && !key.meta && detailSeq && mnemeEnabled()) setCorrecting({ seq: Number(detailSeq[1]), buffer: '' })
        else if (input === 'x' && detailSeq && mnemeEnabled()) retireSelected(Number(detailSeq[1]))
        return
      }
      // Search: printable characters build the query (type-to-search); the
      // list engine keeps ↑↓/↵/esc (charKeys:false frees the letters).
      // The unreadable-store banner advertises `r retries` while charKeys is off
      // (the letters belong to type-to-search): honour the advertised key in
      // exactly that state, before the search branch would swallow it into the
      // query (TASK-017 S2, memory-r-retries-charkeys-off).
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
      ? `${detailSeq && mnemeEnabled() ? 'c correct · x retire · ' : ''}esc back`
      : query
        ? '↑↓ move · ↵ inspect · esc clear'
        : 'type to search · ↑↓ move · ↵ act · esc close'

  return (
    <CommandCenter view="memory" subtitle="memory centre" onClose={onClose} captureInput={false} footer={footer}>
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text color={FAINT}>{'search: '}</Text>
          <Text color={query ? IVORY : FAINT}>{query || '(type to search facts, lessons and notes)'}</Text>
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
              <Text color={FAINT}>{`  ${detail.refId}`}</Text>
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
                  {tone ? <Text color={tone.color}>{`${tone.glyph} `}</Text> : <Text color={FAINT}>{row.kind === 'action' ? '⚙\uFE0E ' : '· '}</Text>}
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
          <Text color={FAINT}>facts & decisions live in topic documents; corrections keep history · lessons: /cards · save: /remember</Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}
