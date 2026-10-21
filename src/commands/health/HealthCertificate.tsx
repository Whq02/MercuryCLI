import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Box, Text, useInput, wrapText } from '../../ink.js'
import type { DOMElement } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { PopupScrollViewport } from '../../components/CustomSelect/popup-list.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { ProductLockup, SectionHeader, StateBadge } from '../../components/mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth, branchChip } from '../../components/mercury-ui/glyphs.js'
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js'
import { CursorCell } from '../../components/mercury-ui/LiveGlyphs.js'
import { panelWidth, shedToFit } from '../../components/mercury-ui/geometry.js'
import { decodeNavKey } from '../../components/mercury-ui/navSemantics.js'
import { useElevatedSurface } from '../../components/mercury-ui/useElevatedSurface.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { PopupFrameContext } from '../../components/PopupGutter.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { CommandPopupShape } from '../../utils/cockpit/commandPopup.js'
import { settingsPopupCompact } from '../../utils/cockpit/settingsPopup.js'
import { estateGroundBg } from '../../utils/mercuryTokens.js'
import { MODEL_PICKER_PANEL } from '../../utils/model/modelPickerGroups.js'
import {
  HEALTH_STATUS_META,
  countByStatus,
  nextActions,
  runAndRecordHealthReport,
  type HealthCertificate as Cert,
  type HealthCheck,
  type HealthSection,
  type HealthStatus,
} from '../../utils/healthReport.js'
import { formatAge, isFixable, sha7 } from '../../utils/healthCertCore.js'
import { applyRemedy, healthFixEnabled, type AppliedFix } from '../../utils/healthFix.js'


const TONE_COLOR: Record<(typeof HEALTH_STATUS_META)[HealthStatus]['tone'], string> = {
  ok: TEAL,
  warn: AMBER,
  fail: CRIMSON,
  stale: AMBER,
  unknown: SECOND,
  neutral: FAINT,
}

const statusColor = (status: HealthStatus): string => TONE_COLOR[HEALTH_STATUS_META[status].tone]

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

const HEALTH_POPUP_VIEW = 'health'
const HEALTH_POPUP_MIN_ROWS = 10
const HEALTH_POPUP_SPARE_ROWS = 7
const HEALTH_POPUP_CHROME_ROWS = 7
const HEALTH_POPUP_COMPACT_CHROME_ROWS = 4
export const HEALTH_POPUP_LEGEND_MIN_ROWS = 30
export const HEALTH_POPUP_CLOSE_HINT = 'esc or click outside closes'

export function healthPopupShape(): CommandPopupShape {
  return {
    view: HEALTH_POPUP_VIEW,
    width: columns => panelWidth(columns, MODEL_PICKER_PANEL),
    rows: rows => Math.max(HEALTH_POPUP_MIN_ROWS, rows - HEALTH_POPUP_SPARE_ROWS),
  }
}

export function healthPopupLayout(frameRows: number, fixRows: number, contentRows: number): { compact: boolean; legend: boolean; cardRows: number; listRows: number } {
  const compact = settingsPopupCompact(frameRows - HEALTH_POPUP_CHROME_ROWS - fixRows)
  const legend = !compact && frameRows >= HEALTH_POPUP_LEGEND_MIN_ROWS
  const chrome = compact ? HEALTH_POPUP_COMPACT_CHROME_ROWS : HEALTH_POPUP_CHROME_ROWS + (legend ? 1 : 0)
  const cardRows = Math.min(fixRows, Math.max(0, frameRows - chrome))
  const budget = Math.max(fixRows > 0 ? 0 : 1, frameRows - chrome - cardRows)
  return { compact, legend, cardRows, listRows: Math.max(fixRows > 0 ? 0 : 1, Math.min(budget, contentRows)) }
}

function healthPopupFooter(segments: { rows: number; cursor: number; fixable: boolean }, width: number): string {
  const listed = segments.rows > 0
  const parts = [
    { text: listed ? '↑↓ move' : '', priority: 9 },
    { text: listed ? '↵ unfold' : '', priority: 8 },
    { text: segments.fixable ? 'f fix' : '', priority: 7 },
    { text: HEALTH_POPUP_CLOSE_HINT, priority: 6 },
    { text: listed ? '⇞⇟ page' : '', priority: 4 },
    { text: 'r re-run', priority: 2 },
    { text: 'd deep', priority: 1 },
    { text: listed ? `${segments.cursor + 1}/${segments.rows}` : '', priority: 5 },
  ].filter(part => part.text !== '')
  return shedToFit(parts, width).map(part => part.text).join(' · ')
}

const LABEL_W = 18
const labelCell = (label: string): string => padTo(truncateToWidth(label, LABEL_W), LABEL_W + 1)
const CONTEXT_ROWS_ABOVE = 2

const rowSpanInEstate = (row: DOMElement | null): { top: number; bottom: number } | null => {
  const height = row?.layoutNode?.getComputedHeight()
  if (!row || height === undefined) return null
  let el: DOMElement | undefined = row
  let top = 0
  for (let hops = 0; el && !el.parentNode?.scroll && hops < 100; hops++) {
    const t = el.layoutNode?.getComputedTop()
    if (t === undefined) return null
    top += t
    el = el.parentNode
  }
  if (!el?.parentNode?.scroll) return null
  return { top, bottom: top + Math.ceil(height) }
}

const flatChecks = (sections: HealthSection[]): HealthCheck[] =>
  sections.flatMap(s => s.checks)

function CheckRow({
  check,
  active,
  open,
  width,
  rowRef,
  onSelect,
  onActivate,
}: {
  check: HealthCheck
  active: boolean
  open: boolean
  width: number
  rowRef?: React.Ref<DOMElement>
  onSelect: () => void
  onActivate: () => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const meta = HEALTH_STATUS_META[check.status]
  const evidenceW = Math.max(8, width - 2 - 2 - LABEL_W - 1)
  return (
    <InteractiveRow id={`health:row:${check.id}`} selected={active} onSelect={onSelect} onActivate={onActivate} width={width} flexDirection="column" rowRef={rowRef}>
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
    </InteractiveRow>
  )
}

type FixFlow =
  | { phase: 'confirm'; check: HealthCheck }
  | { phase: 'running'; check: HealthCheck }
  | { phase: 'done'; check: HealthCheck; outcome: AppliedFix }

const FIX_CARD_DESTRUCTIVE_WORDS = 'DESTRUCTIVE — this discards state that cannot be mechanically recovered. '
const FIX_CARD_CONFIRM_WORDS = '↵ apply · esc cancel'
const FIX_CARD_RUNNING_WORDS = '◐ applying… (the panel stays read-only until it settles)'

function fixCardTitle(flow: FixFlow): string {
  return `fix · ${flow.check.label} · ${flow.check.remedy?.class ?? 'safe'} remedy`
}

function fixCardPhaseLines(flow: FixFlow): string[] {
  if (flow.phase === 'confirm') return [`${flow.check.remedy?.class === 'destructive' ? FIX_CARD_DESTRUCTIVE_WORDS : ''}${FIX_CARD_CONFIRM_WORDS}`]
  if (flow.phase === 'running') return [FIX_CARD_RUNNING_WORDS]
  return [
    `apply: ${flow.outcome.applied.ok ? 'ok' : 'FAILED'} — ${truncateToWidth(flow.outcome.applied.note, 60)}`,
    `verify: ${flow.outcome.verified === null ? 'skipped (apply failed)' : flow.outcome.verified.ok ? 'ok' : 'STILL FAILING'}${flow.outcome.verified ? ` — ${truncateToWidth(flow.outcome.verified.note, 58)}` : ''}`,
    `↵ ${flow.outcome.verified?.ok ? 'dismiss + re-issue the certificate' : 'dismiss'}`,
  ]
}

function fixCardRows(flow: FixFlow | null, width: number): number {
  if (flow === null) return 0
  const inner = Math.max(1, width - 4)
  const lines = (text: string): number => wrapText(text, inner, 'wrap').split('\n').length
  const wrapped = [fixCardTitle(flow), flow.check.remedy?.plan ?? '', ...fixCardPhaseLines(flow)]
  return 2 + 1 + wrapped.reduce((n, text) => n + lines(text), 0)
}

function FixCard({ flow }: { flow: FixFlow }): React.ReactNode {
  const destructive = flow.check.remedy?.class === 'destructive'
  const register = destructive ? CRIMSON : AMBER
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={register} paddingX={1}>
      <Text>
        <Text color={register} bold>
          fix · {flow.check.label}
        </Text>
        <Text color={FAINT}>{fixCardTitle(flow).slice(`fix · ${flow.check.label}`.length)}</Text>
      </Text>
      <Text color={IVORY} wrap="wrap">
        {flow.check.remedy?.plan ?? ''}
      </Text>
      <Text color={FAINT} wrap="truncate-end">
        evidence: {flow.check.evidence}
      </Text>
      {flow.phase === 'confirm' ? (
        <Text color={FAINT}>{fixCardPhaseLines(flow)[0]}</Text>
      ) : flow.phase === 'running' ? (
        <Text color={AMBER}>{FIX_CARD_RUNNING_WORDS}</Text>
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

function MercuryHealthCertificate({ onClose, report = runAndRecordHealthReport }: { onClose: () => void; report?: typeof runAndRecordHealthReport }): React.ReactNode {
  const accent = useSessionAccent().accent
  const tok = useMercuryTokens()
  const elevatedRef = useElevatedSurface()
  const { columns, rows: termRows } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns })
  const frame = React.useContext(PopupFrameContext)
  const width = Math.min(frame?.width ?? slot.columns, panelWidth(slot.columns, MODEL_PICKER_PANEL))
  const frameRows = frame?.rows ?? slot.rows
  const innerW = Math.max(8, width - 4)
  const ground = estateGroundBg(tok)

  const [cert, setCert] = useState<Cert | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [runToken, setRunToken] = useState(0)
  const [liveSections, setLiveSections] = useState<HealthSection[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const depthRef = React.useRef<'fast' | 'deep'>('fast')
  const runStartedAt = React.useRef(Date.now())

  const [sel, setSel] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)

  const [fixFlow, setFixFlow] = useState<FixFlow | null>(null)

  const checksRef = React.useRef<HealthCheck[]>([])
  const selRef = React.useRef(0)
  const fixFlowRef = React.useRef<FixFlow | null>(null)
  fixFlowRef.current = fixFlow

  const pastOpenEvent = useOpenEventGate()
  const overlayToken = useRegisterOverlay('health-popup', true, { ownsPageKeys: true })

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
    const acc = new Map<string, HealthSection>()
    report({
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

  const checks = useMemo(
    () => flatChecks(cert ? cert.sections : liveSections),
    [cert, liveSections],
  )
  checksRef.current = checks

  const scrollRef = React.useRef<ScrollBoxHandle>(null)
  const selRowRef = React.useRef<DOMElement | null>(null)
  const pageRowsRef = React.useRef(8)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    if (sel === 0) {
      box.scrollTo(0)
      return
    }
    if (selRowRef.current) {
      box.scrollToElement(selRowRef.current, -CONTEXT_ROWS_ABOVE)
    }
  }, [sel, openId, cert, frameRows, width])
  const openRowScrollStep = (direction: -1 | 1): boolean => {
    const box = scrollRef.current
    const open = openId !== null && openId === checksRef.current[selRef.current]?.id
    const span = open ? rowSpanInEstate(selRowRef.current) : null
    if (!box || !span) return false
    const scrollTop = box.getScrollTop()
    const viewport = box.getViewportHeight()
    const maxScroll = Math.max(0, box.getScrollHeight() - viewport)
    const wants =
      direction > 0
        ? span.bottom > scrollTop + viewport && scrollTop < maxScroll
        : span.top - CONTEXT_ROWS_ABOVE < scrollTop && scrollTop > 0
    if (!wants) return false
    box.scrollTo(scrollTop + direction)
    return true
  }
  const moveTo = (index: number): void => {
    selRef.current = Math.min(Math.max(0, checksRef.current.length - 1), Math.max(0, index))
    setSel(selRef.current)
  }
  const toggleOpen = (index: number): void => {
    const c = checksRef.current[index]
    if (c) setOpenId(o => (o === c.id ? null : c.id))
  }
  const rerun = (depth: 'fast' | 'deep'): void => {
    depthRef.current = depth
    run()
    moveTo(0)
  }

  useInput(
    (input, key, event) => {
      const flow = fixFlowRef.current
      if (flow) {
        event.stopImmediatePropagation()
        if (flow.phase === 'confirm') {
          if (key.escape) {
            setFixFlow(null)
            return
          }
          if (key.return) {
            const check = flow.check
            setFixFlow({ phase: 'running', check })
            void applyRemedy(check).then(outcome => {
              if (fixFlowRef.current?.phase === 'running' && fixFlowRef.current.check.id === check.id) {
                setFixFlow({ phase: 'done', check, outcome })
              }
            })
          }
          return
        }
        if (flow.phase === 'running') return
        if (key.return || key.escape) {
          const verified = flow.outcome.verified?.ok === true
          setFixFlow(null)
          if (verified) rerun(depthRef.current)
        }
        return
      }

      const action = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true, pageKeys: true })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action === 'movePrevious' || action === 'moveNext') {
        event.stopImmediatePropagation()
        const step = action === 'moveNext' ? 1 : -1
        if (openRowScrollStep(step)) return
        moveTo(selRef.current + step)
        return
      }
      if (action === 'pagePrevious' || action === 'pageNext') {
        event.stopImmediatePropagation()
        const page = Math.max(4, pageRowsRef.current)
        moveTo(action === 'pagePrevious' ? selRef.current - page : selRef.current + page)
        return
      }
      if (action === 'first' || action === 'last') {
        event.stopImmediatePropagation()
        moveTo(action === 'first' ? 0 : checksRef.current.length - 1)
        return
      }
      if (action === 'enterChild' || action === 'leaveChild') {
        event.stopImmediatePropagation()
        const c = checksRef.current[selRef.current]
        if (!c) return
        if (action === 'enterChild') setOpenId(c.id)
        else setOpenId(o => (o === c.id ? null : o))
        return
      }

      if (!pastOpenEvent()) return
      if (action === 'activate') {
        event.stopImmediatePropagation()
        toggleOpen(selRef.current)
        return
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        rerun('deep')
        return
      }
      if (input === 'r' && !key.ctrl && !key.meta) {
        rerun(depthRef.current)
        return
      }
      if (input === 'f' && !key.ctrl && !key.meta) {
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
  const sections = cert ? cert.sections : liveSections
  const fixRows = fixCardRows(fixFlow, innerW)
  const nextRows = actions.length > 0 ? actions.length + 2 : 0
  const contentRows = nextRows + sections.reduce((n, s) => n + 2 + s.checks.length, 0) + (openId ? frameRows : 0)
  const layout = healthPopupLayout(frameRows, fixRows, Math.max(1, contentRows))
  pageRowsRef.current = layout.listRows - 1
  const fixable = checks[sel] !== undefined && healthFixEnabled() && isFixable(checks[sel]!)
  const footer = healthPopupFooter({ rows: checks.length, cursor: sel, fixable }, innerW)
  const statusLine = cert && meta
    ? null
    : loading
      ? `◐ examining the harness (${depthRef.current})…${progress ? ` ${progress.done}/${progress.total} · ${progress.current} · ${Math.round((Date.now() - runStartedAt.current) / 1000)}s` : ''}`
      : `▲ the certificate could not be produced — r re-runs${loadError ? ` · ${loadError}` : ''}`

  return (
    <Box ref={elevatedRef} flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={tok.borderStrong} paddingX={1} opaque={true} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <Box flexDirection="row" height={1} overflow="hidden">
        <ProductLockup view={HEALTH_POPUP_VIEW} separator=" · " />
        {cert && meta ? (
          <Text wrap="truncate-end">
            <Text color={FAINT}> · </Text>
            <StateBadge state={meta.state} label={meta.label} />
          </Text>
        ) : null}
      </Box>
      {layout.compact ? null : (
        <Box height={1}>
          {cert && meta ? (
            <Text color={FAINT} wrap="truncate-end">
              {meta.line} · issued {formatAge(Date.now() - Date.parse(cert.ranAt))} · {cert.version}
              {cert.head.branch ? (
                <>
                  {' '}
                  · {branchChip(cert.head.branch)} @ {sha7(cert.head.sha)}
                  {cert.head.dirty ? ' (dirty)' : ''}
                </>
              ) : null}{' '}
              · {cert.durationMs}ms · read-only
            </Text>
          ) : (
            <Text color={loading ? FAINT : AMBER} wrap="truncate-end">{statusLine}</Text>
          )}
        </Box>
      )}
      {layout.compact ? null : (
        <Box height={1}>
          {counts ? (
            <Text color={FAINT} wrap="truncate-end">
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
        </Box>
      )}
      {layout.compact ? null : <Box height={1} />}
      {fixFlow ? (
        <Box flexDirection="column" maxHeight={layout.cardRows} overflow="hidden" flexShrink={0}>
          <FixCard flow={fixFlow} />
        </Box>
      ) : null}
      <PopupScrollViewport scrollRef={scrollRef}>{scrolls => (
      <ScrollBox ref={scrollRef} height={layout.listRows} flexShrink={0} flexDirection="column">
        {layout.compact && statusLine !== null ? <Text color={loading ? FAINT : AMBER} wrap="truncate-end">{statusLine}</Text> : null}
        {actions.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader marginTop={0}>NEXT</SectionHeader>
            {actions.map((a, i) => (
              <Text key={i} wrap="truncate-end">
                <Text color={statusColor(a.status)}>{HEALTH_STATUS_META[a.status].glyph} </Text>
                <Text color={IVORY}>{a.fix}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {sections.map((section, sectionIndex) => (
          <Box key={section.id} flexDirection="column">
            <SectionHeader marginTop={sectionIndex === 0 && actions.length === 0 ? 0 : 1}>{section.title}</SectionHeader>
            {section.checks.map(c => {
              const index = checks.findIndex(candidate => candidate.id === c.id)
              return (
                <CheckRow
                  key={c.id}
                  check={c}
                  active={selId === c.id}
                  open={openId === c.id}
                  width={Math.max(1, innerW - (scrolls ? 1 : 0))}
                  rowRef={selId === c.id ? selRowRef : undefined}
                  onSelect={() => moveTo(index)}
                  onActivate={() => toggleOpen(index)}
                />
              )
            })}
          </Box>
        ))}
      </ScrollBox>
      )}</PopupScrollViewport>
      {layout.legend ? (
        <Box height={1}>
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
      <Box height={1} width={innerW + 1} marginRight={-1}>
        <Text color={tok.textMuted} wrap="truncate-end">{footer}</Text>
      </Box>
    </Box>
  )
}

export { MercuryHealthCertificate }
