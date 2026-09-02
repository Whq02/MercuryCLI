import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { DOMElement } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import {
  CommandCenter,
  SectionHeader,
  StateBadge,
} from '../../components/mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { CursorCell } from '../../components/mercury-ui/LiveGlyphs.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { LAYOUT_BREAKPOINTS } from '../../hooks/useLayoutTier.js'
import {
  HEALTH_STATUS_META,
  countByStatus,
  flattenChecks,
  nextActions,
  runAndRecordHealthReport,
  type HealthCertificate as Cert,
  type HealthCheck,
  type HealthSection,
  type HealthStatus,
} from '../../utils/healthReport.js'
import { formatAge, isFixable, sha7 } from '../../utils/healthCertCore.js'
import { applyRemedy, healthFixEnabled, type AppliedFix } from '../../utils/healthFix.js'

// ============================================================================
//  /health — the Mercury harness HEALTH CERTIFICATE panel
//  (docs/HEALTH-CERTIFICATE.md; fresh Mercury code, the
// behaviour contract carried, no legacy blocks).
//
//  One question, answered with evidence: "is Mercury safe to trust right now,
//  why, and what should I do next?" — a verdict banner (CERTIFIED / CAUTION /
//  FAULT), the ranked next actions, then every check with the evidence that
//  backs it. Honesty chrome: `stale` and `unknown` are first-class states,
//  `off` (a deliberate gate) is neutral, and a claim is only ever green with
//  evidence behind it.
//
//  Interaction (ink-component-patterns): ↑↓ moves the cursor over check rows
//  (clamp, never wrap), ⇞⇟ pages, ↵ expands the selected row (full evidence ·
//  detail · fix · linked surface), f opens the fix consent card on a fixable
//  row, d re-runs deep, r re-runs fresh, esc closes. Arrows and esc act
//  immediately; action keys (↵ d r f) wait out a 150ms wall-clock mount
//  buffer read from a timestamp ref — never a setTimeout ready-flag (the
//  STALE-PAINT class), so the launching keystroke can neither act on row 0
//  nor be swallowed. The input path reads REF MIRRORS written the moment data
//  exists; committed state renders only.
//
//  Layout: one column under LAYOUT_BREAKPOINTS.deckTwoColMin, two balanced
//  section columns at or above it. The check estate scrolls inside a bounded
//  ScrollBox whose viewport follows the cursor row; the banner, fix card,
//  legend, and footer stay on screen at every size. Colours are the brand
//  status spine (TEAL ok · AMBER warn/stale · CRIMSON fail · SECOND unknown ·
//  FAINT neutral) via HEALTH_STATUS_META tones — status never wears the
//  session accent, and no new hex enters here.
// ============================================================================

const TONE_COLOR: Record<(typeof HEALTH_STATUS_META)[HealthStatus]['tone'], string> = {
  ok: TEAL,
  warn: AMBER,
  fail: CRIMSON,
  stale: AMBER,
  unknown: SECOND,
  neutral: FAINT,
}

const statusColor = (status: HealthStatus): string => TONE_COLOR[HEALTH_STATUS_META[status].tone]

/** Verdict → badge state + the trust sentence under it. */
const VERDICT_META: Record<
  Cert['verdict'],
  { state: 'live' | 'gated' | 'failed'; label: string; line: string }
> = {
  certified: {
    state: 'live',
    label: 'CERTIFIED',
    line: 'every check is backed by fresh evidence — safe to trust',
  },
  caution: {
    state: 'gated',
    label: 'CAUTION',
    line: 'trust with care — stale, unknown, or warning rows below',
  },
  fault: {
    state: 'failed',
    label: 'FAULT',
    line: 'do not trust until the failing checks are fixed',
  },
}

const LABEL_W = 18
/** The label column cell — ONE rule for every row (round-2 capture defect:
 *  "Install provenancedevelopment …"): truncate the label to LABEL_W, then pad
 *  to LABEL_W + 1, so the label/value gap SURVIVES the exact-fit case (an
 *  18-wide label keeps all its characters + one space) and the truncated case
 *  (ellipsis at 18 + one space). `padTo` alone truncates TO the width and
 *  leaves no gap. evidenceW below already budgets the +1 column. */
const labelCell = (label: string): string => padTo(truncateToWidth(label, LABEL_W), LABEL_W + 1)
/** Fixed chrome outside the scroll estate: frame + header + footer + the
 *  transcript prompt line under an inline surface (banner/fix-card/legend
 *  rows are added per-render). */
const CHROME_RESERVE = 8
/** Wall-clock action-key buffer after mount (timestamp ref, no state). */
const ENTER_BUFFER_MS = 150

/** The flat cursor order: every check, section by section (headers skip). */
const flatChecks = (sections: HealthSection[]): HealthCheck[] =>
  sections.flatMap(s => s.checks)

/** Balance sections into two columns by row weight (checks + header). */
function balanceColumns(sections: HealthSection[]): [HealthSection[], HealthSection[]] {
  const weight = (s: HealthSection): number => s.checks.length + 1
  const total = sections.reduce((n, s) => n + weight(s), 0)
  const left: HealthSection[] = []
  const right: HealthSection[] = []
  let taken = 0
  for (const s of sections) {
    if (taken < total / 2) {
      left.push(s)
      taken += weight(s)
    } else {
      right.push(s)
    }
  }
  return [left, right]
}

function CheckRow({
  check,
  active,
  open,
  width,
  rowRef,
}: {
  check: HealthCheck
  active: boolean
  open: boolean
  width: number
  /** Attached to the ACTIVE row only — the viewport follows it. */
  rowRef?: React.Ref<DOMElement>
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const meta = HEALTH_STATUS_META[check.status]
  const evidenceW = Math.max(8, width - 2 - 2 - LABEL_W - 1)
  return (
    <Box flexDirection="column" ref={rowRef}>
      <Text wrap="truncate-end">
        <CursorCell focused={active} color={accent} />
        <Text color={statusColor(check.status)}>{meta.glyph} </Text>
        <Text color={meta.tone === 'neutral' ? SECOND : IVORY}>{labelCell(check.label)}</Text>
        {!open ? <Text color={FAINT}>{truncateToWidth(check.evidence, evidenceW)}</Text> : null}
      </Text>
      {open ? (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          <Text color={SECOND} wrap="wrap">
            {check.evidence}
          </Text>
          {check.detail ? (
            <Text color={FAINT} wrap="wrap">
              {check.detail}
            </Text>
          ) : null}
          {check.fix ? (
            <Text wrap="wrap">
              <Text color={accent}>→ </Text>
              <Text color={IVORY}>{check.fix}</Text>
            </Text>
          ) : null}
          {check.link ? <Text color={FAINT}>related surface: {check.link}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}

function SectionColumn({
  sections,
  selId,
  openId,
  width,
  selRowRef,
}: {
  sections: HealthSection[]
  selId: string | null
  openId: string | null
  width: number
  selRowRef: React.Ref<DOMElement>
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={width}>
      {sections.map(section => (
        <Box key={section.id} flexDirection="column">
          <SectionHeader>{section.title}</SectionHeader>
          {section.checks.map(c => (
            <CheckRow
              key={c.id}
              check={c}
              active={selId === c.id}
              open={openId === c.id}
              width={width}
              rowRef={selId === c.id ? selRowRef : undefined}
            />
          ))}
        </Box>
      ))}
    </Box>
  )
}

/** The W8 fix flow's modal card: consent → applying → outcome. */
type FixFlow =
  | { phase: 'confirm'; check: HealthCheck }
  | { phase: 'running'; check: HealthCheck }
  | { phase: 'done'; check: HealthCheck; outcome: AppliedFix }

function FixCard({ flow }: { flow: FixFlow }): React.ReactNode {
  const destructive = flow.check.remedy?.class === 'destructive'
  const register = destructive ? CRIMSON : AMBER
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={register} paddingX={1} marginTop={1}>
      <Text>
        <Text color={register} bold>
          fix · {flow.check.label}
        </Text>
        <Text color={FAINT}> · {flow.check.remedy?.class ?? 'safe'} remedy</Text>
      </Text>
      <Text color={IVORY} wrap="wrap">
        {flow.check.remedy?.plan ?? ''}
      </Text>
      <Text color={FAINT} wrap="truncate-end">
        evidence: {flow.check.evidence}
      </Text>
      {flow.phase === 'confirm' ? (
        <Text color={FAINT}>
          {destructive
            ? 'DESTRUCTIVE — this discards state that cannot be mechanically recovered. '
            : ''}
          ↵ apply · esc cancel
        </Text>
      ) : flow.phase === 'running' ? (
        <Text color={AMBER}>◐ applying… (the panel stays read-only until it settles)</Text>
      ) : (
        <>
          <Text>
            <Text color={flow.outcome.applied.ok ? TEAL : CRIMSON}>
              apply: {flow.outcome.applied.ok ? 'ok' : 'FAILED'}
            </Text>
            <Text color={FAINT}> — {truncateToWidth(flow.outcome.applied.note, 60)}</Text>
          </Text>
          <Text>
            <Text
              color={
                flow.outcome.verified === null
                  ? FAINT
                  : flow.outcome.verified.ok
                    ? TEAL
                    : CRIMSON
              }
            >
              verify:{' '}
              {flow.outcome.verified === null
                ? 'skipped (apply failed)'
                : flow.outcome.verified.ok
                  ? 'ok'
                  : 'STILL FAILING'}
            </Text>
            {flow.outcome.verified ? (
              <Text color={FAINT}> — {truncateToWidth(flow.outcome.verified.note, 58)}</Text>
            ) : null}
          </Text>
          <Text color={FAINT}>
            ↵ {flow.outcome.verified?.ok ? 'dismiss + re-issue the certificate' : 'dismiss'}
          </Text>
        </>
      )}
    </Box>
  )
}

function MercuryHealthCertificate({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const { columns, rows: termRows } = useTerminalSize()

  // The report run: token bumps re-issue; the effect owns one AbortController
  // per run and streams settled rows in as they land.
  const [cert, setCert] = useState<Cert | null>(null)
  const [loading, setLoading] = useState(true)
  // A failed run renders its WHY (never a bare dead end).
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runToken, setRunToken] = useState(0)
  const [liveSections, setLiveSections] = useState<HealthSection[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const depthRef = React.useRef<'fast' | 'deep'>('fast')
  const runStartedAt = React.useRef(Date.now())

  // Cursor + expansion.
  const [sel, setSel] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)

  // Fix flow (modal while present).
  const [fixFlow, setFixFlow] = useState<FixFlow | null>(null)

  // INPUT-PATH REF MIRRORS (STALE-PAINT doctrine): a background-resolved
  // setState may not commit until the next scheduler wake — the very
  // keypress being handled — so the handler reads refs written the moment
  // data exists. State stays the source for RENDERING only.
  const checksRef = React.useRef<HealthCheck[]>([])
  const selRef = React.useRef(0)
  const fixFlowRef = React.useRef<FixFlow | null>(null)
  fixFlowRef.current = fixFlow

  // Mount-TIMESTAMP action buffer: wall-clock compared at keypress time —
  // exact debounce with no commit dependency (a setTimeout ready-flag only
  // commits on the next scheduler flush, which IS the keypress under test).
  const mountedAt = React.useRef(Date.now())
  const pastEnterBuffer = (): boolean => Date.now() - mountedAt.current > ENTER_BUFFER_MS

  const run = useCallback(() => {
    setLoading(true)
    setCert(null)
    setLoadError(null)
    setOpenId(null)
    setLiveSections([])
    setProgress(null)
    runStartedAt.current = Date.now()
    setRunToken(t => t + 1)
  }, [])

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    // Progressive assembly: each settled check lands in its section the
    // moment it exists (final order comes from the finished certificate).
    const acc = new Map<string, HealthSection>()
    runAndRecordHealthReport({
      depth: depthRef.current,
      signal: ac.signal,
      onProgress: ev => {
        if (!alive) return
        const section = acc.get(ev.sectionId) ?? { id: ev.sectionId, title: ev.sectionTitle, checks: [] }
        section.checks = [...section.checks, ev.check]
        acc.set(ev.sectionId, section)
        const sections = [...acc.values()]
        checksRef.current = flatChecks(sections)
        setLiveSections(sections)
        setProgress({ done: ev.done, total: ev.total, current: ev.check.label })
      },
    })
      .then(c => {
        if (!alive) return
        // Refs first: input can act on the certificate even if this commit
        // parks until the next wake.
        checksRef.current = flatChecks(c.sections)
        setCert(c)
        setLoadError(null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setLoadError(String(e))
        setLoading(false)
      })
    return () => {
      alive = false
      ac.abort()
    }
  }, [runToken])

  // THE VISIBLE ROW LIST (round 2): the certificate once it resolves, else
  // the streamed sections — so the footer's nav fragments and the position
  // marker key on what is ON SCREEN and ride the tail from the first
  // streamed row (the viewport harness captures inside the streaming
  // window), and the ref mirror needs no clobber guard.
  const checks = useMemo(
    () => flatChecks(cert ? cert.sections : liveSections),
    [cert, liveSections],
  )
  checksRef.current = checks

  // Bounded viewport: the cursor row is followed by the ScrollBox; ⇞⇟ pages
  // by the live viewport height (ref, not state — the input path reads it).
  const scrollRef = React.useRef<ScrollBoxHandle>(null)
  const selRowRef = React.useRef<DOMElement | null>(null)
  const pageRowsRef = React.useRef(8)
  useLayoutEffect(() => {
    if (selRowRef.current && scrollRef.current) {
      // Negative offset keeps context rows ABOVE the selection.
      scrollRef.current.scrollToElement(selRowRef.current, -2)
    }
  }, [sel, openId, cert])

  useInput(
    (input, key) => {
      // The fix card is modal: it owns every key until resolved.
      const flow = fixFlowRef.current
      if (flow) {
        if (flow.phase === 'confirm') {
          if (key.escape) {
            setFixFlow(null)
            return
          }
          if (key.return) {
            const check = flow.check
            setFixFlow({ phase: 'running', check })
            void applyRemedy(check).then(outcome => {
              // Commit only if this flow is still current (esc-proofing).
              if (fixFlowRef.current?.phase === 'running' && fixFlowRef.current.check.id === check.id) {
                setFixFlow({ phase: 'done', check, outcome })
              }
            })
          }
          return
        }
        if (flow.phase === 'running') return // no interrupts mid-apply
        if (key.return || key.escape) {
          const verified = flow.outcome.verified?.ok === true
          setFixFlow(null)
          if (verified) {
            run()
            selRef.current = 0
            setSel(0)
          }
        }
        return
      }

      // esc + cursor keys act immediately (nav must feel instant and cannot
      // mis-fire on the launching keystroke).
      if (key.escape) {
        onClose()
        return
      }
      if (key.upArrow) {
        selRef.current = Math.max(0, selRef.current - 1)
        setSel(selRef.current)
        return
      }
      if (key.downArrow) {
        selRef.current = Math.min(Math.max(0, checksRef.current.length - 1), selRef.current + 1)
        setSel(selRef.current)
        return
      }
      if (key.pageUp || key.pageDown) {
        const page = Math.max(4, pageRowsRef.current)
        const next = key.pageUp ? selRef.current - page : selRef.current + page
        selRef.current = Math.min(Math.max(0, checksRef.current.length - 1), Math.max(0, next))
        setSel(selRef.current)
        return
      }

      // Action keys wait out the mount buffer.
      if (!pastEnterBuffer()) return
      if (key.return) {
        const c = checksRef.current[selRef.current]
        if (c) setOpenId(o => (o === c.id ? null : c.id))
        return
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        depthRef.current = 'deep'
        run()
        selRef.current = 0
        setSel(0)
        return
      }
      if (input === 'r') {
        run()
        selRef.current = 0
        setSel(0)
        return
      }
      if (input === 'f') {
        const c = checksRef.current[selRef.current]
        if (c && healthFixEnabled() && isFixable(c)) {
          setFixFlow({ phase: 'confirm', check: c })
        }
      }
    },
    { isActive: true },
  )

  const selId = checks[sel]?.id ?? null
  const counts = cert ? countByStatus(checks) : null
  const meta = cert ? VERDICT_META[cert.verdict] : null
  const actions = cert && cert.verdict !== 'certified' ? nextActions(checks, 3) : []

  const twoCol = columns >= LAYOUT_BREAKPOINTS.deckTwoColMin && (cert !== null || liveSections.length > 0)
  const innerW = Math.max(40, columns - 4)
  const colW = twoCol ? Math.floor((innerW - 3) / 2) : innerW

  // Scroll budget: terminal rows minus the fixed chrome around the estate.
  // Content-aware: few rows shrink the box; many pin it at the cap.
  const sections = cert ? cert.sections : liveSections
  const bannerRows = cert ? 4 : loading ? 2 : 3
  const fixRows = fixFlow ? (fixFlow.phase === 'done' ? 10 : 8) : 0
  const showLegend = !!cert && termRows >= 30
  const viewportBudget = Math.max(4, termRows - CHROME_RESERVE - bannerRows - fixRows - (showLegend ? 2 : 0))
  const rowsOf = (list: HealthSection[]): number => list.reduce((n, s) => n + 2 + s.checks.length, 0)
  const estimatedRows = (() => {
    const nextRows = actions.length > 0 ? actions.length + 2 : 0
    const body = twoCol
      ? (() => {
          const [l, r] = balanceColumns(sections)
          return Math.max(rowsOf(l), rowsOf(r))
        })()
      : rowsOf(sections)
    // An open evidence trail wraps to unknowable height — push past the cap
    // so the box pins there and scrolls.
    return nextRows + body + (openId ? viewportBudget : 0)
  })()
  const listHeight = Math.max(4, Math.min(viewportBudget, estimatedRows))
  pageRowsRef.current = listHeight - 1

  const [leftCol, rightCol] = twoCol ? balanceColumns(sections) : [sections, []]

  return (
    <CommandCenter
      view="health"
      subtitle="health certificate"
      onClose={onClose}
      captureInput={false}
      footer={`${checks.length > 0 ? '↑↓ select · ⇞⇟ page · ↵ evidence · ' : ''}${checks[sel] && healthFixEnabled() && isFixable(checks[sel]!) ? 'f fix · ' : ''}d deep · r re-run · esc close${checks.length > 0 ? ` · ${sel + 1}/${checks.length}` : ''}`}
    >
      {/* verdict banner — the trust statement, then its provenance line */}
      <Box marginTop={1} flexDirection="column">
        {cert && meta ? (
          <>
            <Text>
              <StateBadge state={meta.state} label={meta.label} />
              <Text color={FAINT}>  {meta.line}</Text>
            </Text>
            <Text color={FAINT} wrap="truncate-end">
              issued {formatAge(Date.now() - Date.parse(cert.ranAt))} · {cert.version}
              {cert.head.branch ? (
                <>
                  {' '}
                  · {GLYPH.branch} {cert.head.branch} @ {sha7(cert.head.sha)}
                  {cert.head.dirty ? ' (dirty)' : ''}
                </>
              ) : null}{' '}
              · {cert.durationMs}ms · read-only
            </Text>
            {counts ? (
              <Text color={FAINT}>
                {checks.length} checks
                {counts.fail ? <Text color={CRIMSON}> · {counts.fail} fail</Text> : null}
                {counts.stale ? <Text color={AMBER}> · {counts.stale} stale</Text> : null}
                {counts.warn ? <Text color={AMBER}> · {counts.warn} warn</Text> : null}
                {counts.unknown ? <Text color={SECOND}> · {counts.unknown} unknown</Text> : null}
                {counts.ok ? <Text color={TEAL}> · {counts.ok} ok</Text> : null}
                {counts.off ? <Text color={FAINT}> · {counts.off} off</Text> : null}
                {counts.info ? <Text color={FAINT}> · {counts.info} info</Text> : null}
              </Text>
            ) : null}
          </>
        ) : loading ? (
          <Text color={FAINT}>
            ◐ examining the harness ({depthRef.current})…
            {progress
              ? ` ${progress.done}/${progress.total} · ${progress.current} · ${Math.round((Date.now() - runStartedAt.current) / 1000)}s`
              : ''}
          </Text>
        ) : (
          <>
            <Text color={AMBER}>▲ the certificate could not be produced — r re-runs</Text>
            {loadError ? (
              <Text color={FAINT} wrap="truncate-end">
                {loadError}
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {/* fix consent/outcome card — modal while present; destructive wears
          the CRIMSON register, safe wears AMBER */}
      {fixFlow ? <FixCard flow={fixFlow} /> : null}

      {/* THE SCROLL ESTATE — ranked next actions + sectioned checks inside
          one bounded viewport; settled rows stream in while loading */}
      <ScrollBox ref={scrollRef} height={listHeight} flexShrink={0} flexDirection="column">
        {actions.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader>NEXT</SectionHeader>
            {actions.map((a, i) => (
              <Text key={i} wrap="truncate-end">
                <Text color={statusColor(a.status)}>{HEALTH_STATUS_META[a.status].glyph} </Text>
                <Text color={IVORY}>{a.fix}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {sections.length > 0 ? (
          twoCol ? (
            <Box>
              <Box marginRight={3}>
                <SectionColumn sections={leftCol} selId={selId} openId={openId} width={colW} selRowRef={selRowRef} />
              </Box>
              <SectionColumn sections={rightCol} selId={selId} openId={openId} width={colW} selRowRef={selRowRef} />
            </Box>
          ) : (
            <SectionColumn sections={leftCol} selId={selId} openId={openId} width={colW} selRowRef={selRowRef} />
          )
        ) : null}
      </ScrollBox>

      {/* provenance legend — fixed chrome when the window affords it */}
      {showLegend ? (
        <Box marginTop={1}>
          <Text color={FAINT} wrap="truncate-end">
            every claim names its evidence — <Text color={accent}>↵</Text>
            <Text color={FAINT}> opens the full trail · </Text>
            <Text color={SECOND}>{GLYPH.drifting} stale</Text>
            <Text color={FAINT}> = evidence predates what it certifies · </Text>
            <Text color={SECOND}>{GLYPH.read} unknown</Text>
            <Text color={FAINT}> = no evidence either way</Text>
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}

export const call = async (onDone: () => void): Promise<React.ReactNode> => {
  return <MercuryHealthCertificate onClose={onDone} />
}

export { MercuryHealthCertificate }
