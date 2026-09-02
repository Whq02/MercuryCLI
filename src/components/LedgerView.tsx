import * as React from 'react'
import { useEffect, useState } from 'react'
import { join } from 'node:path'
import { Box, Text, useInput } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { getAutoMemPath } from '../memdir/paths.js'
import {
  defaultEvolutionLedgerDir,
  evolutionLedgerEnabled,
  type EvolutionRow,
} from '../utils/evolution/evolutionLedger.js'
import {
  scanEvolutionLedgers,
  type LedgerScanResult,
  type ProgramLedger,
} from '../utils/evolution/ledgerScan.js'
import { FreshnessLine, KeyValueGrid, Sparkline, useNowTick, type KVRow } from './mercury-ui/components.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import {
  NavigablePanes,
  type ColumnDef,
  type SectionDef,
} from './mercury-ui/NavigablePanes.js'

// ============================================================================
//  LedgerView — the /ledger operator reader.
//
//  The evolution-ledger substrate wrote per-program improvement rows into two
//  homes (repo `.mercury/evolution/` + memdir `<autoMem>/evolution/`) and the
//  pure rollups were reader-less beyond one retired board's single program. This
//  binds summarizeEvolution / computeEvolutionFrontier / computeSubjectDrift
//  across ALL programs on the same NavigablePanes grammar as /monitor
//  (arrows/esc instant, drill = KeyValueGrid detail — the healed nav seam).
//
//  HONESTY: read-only and gate-independent (readEvolutionRows doctrine: past
//  ledgers stay inspectable after MERCURY_EVOLUTION_LEDGER=0 — the header says
//  when the WRITER is off). Missing homes/rows → honest empty, never a faked
//  row.
// ============================================================================

type LedgerRow = { ledger: ProgramLedger }

// Semantic token roles: render
// sites resolve them against the live theme family.
type ToneRole = 'success' | 'warning' | 'failure' | 'textMuted' | 'textPrimary'

const OUTCOME_TONE: Record<string, ToneRole> = {
  improved: 'success',
  accepted: 'success',
  baseline: 'textPrimary',
  tie: 'textMuted',
  regressed: 'warning',
  refused: 'warning',
  error: 'failure',
}

// Per-day activity bins over the trailing window — REAL row timestamps only
// (the sideInfo card omits the sparkline entirely under two data points).
export function ledgerActivityBins(
  rows: readonly EvolutionRow[],
  nowMs: number,
  days = 14,
): { perDay: number[]; total: number } {
  const DAY = 86_400_000
  const perDay = new Array<number>(days).fill(0)
  let total = 0
  for (const r of rows) {
    const t = Date.parse(r.ts)
    if (!Number.isFinite(t)) continue
    const age = nowMs - t
    if (age < 0 || age >= days * DAY) continue
    const bin = days - 1 - Math.floor(age / DAY)
    perDay[bin]! += 1
    total += 1
  }
  return { perDay, total }
}

const pct = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`)
const day = (ts?: string): string => (ts ? ts.slice(0, 10) : '—')

function outcomeMix(byOutcome: Record<string, number>): string {
  return (
    Object.entries(byOutcome)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') || '(none)'
  )
}

function lastEvidence(rows: EvolutionRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const refs = rows[i]?.evidenceRefs
    if (refs && refs.length > 0) return refs[0]
  }
  return undefined
}

export function LedgerView({ onClose }: { onClose: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const [ledgers, setLedgers] = useState<LedgerScanResult | null>(null)
  // scannedAt drives the header FreshnessLine (trust-cockpit W2a): a scan-on-
  // open surface must SAY how old its scan is instead of silently aging.
  // `scanId` bumps re-run the scan effect — the `r` re-scan below.
  const [scannedAt, setScannedAt] = useState(0)
  const [scanId, setScanId] = useState(0)
  const now = useNowTick()
  useEffect(() => {
    let alive = true
    void scanEvolutionLedgers([
      { label: 'repo', dir: defaultEvolutionLedgerDir(getCwd()) },
      { label: 'memdir', dir: join(getAutoMemPath(), 'evolution') },
    ]).then(l => {
      if (alive) {
        setLedgers(l)
        setScannedAt(Date.now())
      }
    })
    return () => {
      alive = false
    }
  }, [scanId])

  // `r` re-scan — a buffered SIBLING useInput (the DaemonSupervisorView idiom):
  // NavigablePanes owns the nav keys; this owns exactly one action key, mount-
  // buffered so the keystroke that launched /ledger can't fire it. A re-scan
  // keeps the current rows painted until the fresh result lands (no flash).
  const pastOpenEvent = useOpenEventGate()
  useInput(input => {
    if (input === 'r' && pastOpenEvent()) setScanId(n => n + 1)
  })

  const all = ledgers ?? []
  const repo = all.filter(l => l.source === 'repo')
  const memdir = all.filter(l => l.source === 'memdir')

  const sections: SectionDef<LedgerRow>[] = [
    {
      id: 'repo',
      label: 'repo programs',
      rows: repo.map(ledger => ({ ledger })),
      emptyHint: 'no program ledgers in .mercury/evolution',
    },
    {
      id: 'memdir',
      label: 'memdir',
      rows: memdir.map(ledger => ({ ledger })),
      emptyHint: 'no card-outcome rows yet (distill/promote decisions land here)',
    },
  ]

  const columns: ColumnDef<LedgerRow>[] = [
    {
      key: 'program',
      header: 'program',
      cell: r => <Text color={tokens.textPrimary}>{r.ledger.program}</Text>,
    },
    {
      key: 'rows',
      header: 'rows',
      width: 5,
      align: 'right',
      cell: r => <Text color={tokens.textPrimary}>{r.ledger.summary.total}</Text>,
    },
    {
      key: 'ok',
      header: 'ok',
      width: 5,
      align: 'right',
      cell: r => {
        const n = (r.ledger.summary.byOutcome['accepted'] ?? 0) + (r.ledger.summary.byOutcome['improved'] ?? 0)
        return <Text color={n > 0 ? tokens.success : tokens.textMuted}>{n}</Text>
      },
    },
    {
      key: 'refused',
      header: 'refused',
      width: 7,
      align: 'right',
      cell: r => {
        const n = r.ledger.summary.byOutcome['refused'] ?? 0
        return <Text color={n > 0 ? tokens.warning : tokens.textMuted}>{n}</Text>
      },
    },
    {
      key: 'dry',
      header: 'dry',
      width: 4,
      align: 'right',
      cell: r => {
        const n = r.ledger.summary.frontier.dryIterations
        return <Text color={n > 1 ? tokens.warning : tokens.textMuted}>{n}</Text>
      },
    },
    {
      key: 'last',
      header: 'last',
      width: 10,
      cell: r => <Text color={tokens.textMuted}>{day(r.ledger.summary.lastTs)}</Text>,
    },
  ]

  const renderDetail = (r: LedgerRow): React.ReactNode => {
    const s = r.ledger.summary
    const f = s.frontier
    const rows: KVRow[] = [
      { k: 'source', v: `${r.ledger.source} · ${r.ledger.path}`, tone: tokens.textMuted },
      { k: 'span', v: s.firstTs ? `${day(s.firstTs)} → ${day(s.lastTs)}` : '—', tone: tokens.textPrimary },
      { k: 'all-time', v: outcomeMix(s.byOutcome), tone: tokens.textPrimary },
      { k: `recent-${s.recentWindow}`, v: outcomeMix(s.recentByOutcome), tone: tokens.textPrimary },
      {
        k: 'frontier',
        v: f.best ? `${f.best.subject} @ ${f.best.score}${f.best.iteration !== undefined ? ` (iter ${f.best.iteration})` : ''}` : '—',
        tone: f.best ? tokens.success : tokens.textMuted,
      },
      { k: 'dry iters', v: String(f.dryIterations), tone: f.dryIterations > 1 ? tokens.warning : tokens.textPrimary },
    ]
    // Top drifting subjects — the AdaptiveHarness recent-vs-prior arithmetic.
    for (const d of r.ledger.drift.slice(0, 3)) {
      rows.push({
        k: 'drift',
        v: `${d.subject} · ${d.total} rows · accept ${pct(d.acceptRate)} (recent ${pct(d.recentAcceptRate)} vs prior ${pct(d.priorAcceptRate)})`,
        tone:
          d.recentAcceptRate !== null && d.priorAcceptRate !== null && d.recentAcceptRate < d.priorAcceptRate
            ? tokens.warning
            : tokens.textPrimary,
      })
    }
    const ev = lastEvidence(r.ledger.rows)
    if (ev) rows.push({ k: 'evidence', v: ev, tone: tokens.textMuted })
    // The last 3 rows verbatim-ish — outcome + subject, newest last.
    for (const row of r.ledger.rows.slice(-3)) {
      rows.push({
        k: row.ts.slice(5, 16),
        v: `${row.outcome}  ${row.subject}`,
        tone: tokens[OUTCOME_TONE[row.outcome] ?? 'textPrimary'],
      })
    }
    return <KeyValueGrid rows={rows} keyWidth={11} />
  }

  // Standing glance card: the
  // un-drilled companion for the selected program — outcome counts, frontier,
  // last row, and a 14-day activity strip from REAL row timestamps (omitted
  // entirely under two rows in the window). Long prose stays in drill-in.
  const sideInfo = (r: LedgerRow): React.ReactNode => {
    const s = r.ledger.summary
    const f = s.frontier
    const ok = (s.byOutcome['accepted'] ?? 0) + (s.byOutcome['improved'] ?? 0)
    const last = r.ledger.rows[r.ledger.rows.length - 1]
    const kv: KVRow[] = [
      { k: 'rows', v: `${s.total} · ok ${ok} · refused ${s.byOutcome['refused'] ?? 0}`, tone: tokens.textPrimary },
      { k: 'span', v: s.firstTs ? `${day(s.firstTs)} → ${day(s.lastTs)}` : '—', tone: tokens.textSecondary },
      {
        k: 'frontier',
        v: f.best ? `${f.best.subject} @ ${f.best.score}` : '—',
        tone: f.best ? tokens.success : tokens.textMuted,
      },
      ...(last
        ? [
            {
              k: 'last',
              v: `${last.outcome} · ${last.subject}`,
              tone: tokens[OUTCOME_TONE[last.outcome] ?? 'textPrimary'],
              note: `· ${day(last.ts)}`,
            } satisfies KVRow,
          ]
        : []),
    ]
    const act = ledgerActivityBins(r.ledger.rows, now)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={tokens.accent} wrap="truncate-end">
            {r.ledger.program}
          </Text>
          <Text color={tokens.textMuted}> · {r.ledger.source}</Text>
        </Box>
        <Box marginTop={1}>
          <KeyValueGrid keyWidth={9} rows={kv} />
        </Box>
        {act.total >= 2 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={tokens.textMuted} wrap="truncate-end">
              activity · 14d · {act.total} rows
            </Text>
            <Sparkline values={act.perDay} />
          </Box>
        ) : null}
      </Box>
    )
  }

  // error ≠ empty: unreadable/parse-failed files are COUNTED by the scan and
  // said out loud here — never a clean empty over a broken home.
  const unreadable = ledgers?.unreadableFiles ?? 0
  const headerLine = (
    <Box flexDirection="column">
      <Text color={tokens.textMuted} wrap="truncate-end">
        {all.length} program{all.length === 1 ? '' : 's'} · improvement rows, frontier + drift
        {evolutionLedgerEnabled() ? '' : ' · writer OFF (MERCURY_EVOLUTION_LEDGER=0) — read-only view'}
      </Text>
      <Box>
        {/* 5m stale bar (not the 60s default): ledgers move at program cadence,
            so a minute-old scan is normal, not suspect — `r` re-scans. */}
        <FreshnessLine at={scannedAt} now={now} source="scan" staleMs={300_000} />
        {unreadable > 0 ? (
          <Text color={tokens.warning}>{`  ${GLYPH.uptri} ${unreadable} unreadable skipped`}</Text>
        ) : null}
      </Box>
    </Box>
  )

  return (
    <NavigablePanes<LedgerRow>
      view="ledger"
      headerLine={headerLine}
      sections={sections}
      columns={columns}
      rowKey={r => `${r.ledger.source}:${r.ledger.program}`}
      renderDetail={renderDetail}
      sideInfo={sideInfo}
      detailTitle={r => `${r.ledger.program} — ${r.ledger.source}`}
      onClose={onClose}
      footerHints="r re-scan"
      loading={ledgers === null}
      maxContentWidth={110}
      emptyState={
        ledgers !== null && all.length === 0
          ? {
              title: 'No evolution-ledger rows yet',
              hint: 'improvement programs (patch-loop, workflow benchmarks, card outcomes) write here as they run',
            }
          : undefined
      }
    />
  )
}
