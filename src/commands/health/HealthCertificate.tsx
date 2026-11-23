import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Box, Text, useInput, wrapText } from '../../screen/themedRenderer.js'
import type { DOMElement } from '../../screen/themedRenderer.js'
import type { ScrollBoxHandle } from '../../screen/renderer/elements/ScrollBox.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../screen/overlays/overlayHooks.js'
import { useModalOrTerminalSize } from '../../screen/overlays/modalContext.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../screen/theme/mercuryPalette.js'
import { padTo, truncateToWidth } from '../../screen/theme/glyphs.js'
import { InteractiveRow } from '../../screen/widgets/InteractiveRow.js'
import { CursorCell } from '../../screen/widgets/LiveGlyphs.js'
import { panelWidth, shedToFit } from '../../screen/widgets/geometry.js'
import { decodeNavKey } from '../../screen/widgets/navSemantics.js'
import { useElevatedSurface } from '../../screen/widgets/useElevatedSurface.js'
import { useOpenEventGate } from '../../screen/widgets/useOpenEventGate.js'
import { useSessionAccent } from '../../screen/widgets/sessionAccent.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { PopupFrameContext } from '../../screen/overlays/PopupGutter.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { useLayoutPublish, useLoad } from '../../screen/effects/effects.js'
import type { CommandPopupShape } from '../../screen/cockpit/commandPopup.js'
import { settingsPopupCompact } from '../../screen/cockpit/settingsPopup.js'
import { estateGroundBg } from '../../screen/theme/mercuryTokens.js'
import { MODEL_PICKER_PANEL } from '../../models/facts/modelPickerGroups.js'
import {
  HEALTH_STATUS_META,
  countByStatus,
  nextActions,
  runAndRecordHealthReport,
  type HealthCertificate as Cert,
  type HealthCheck,
  type HealthSection,
  type HealthStatus,
} from '../../platform/health/healthReport.js'
import { isFixable } from '../../platform/health/healthCertCore.js'
import { applyRemedy, healthFixEnabled } from '../../platform/health/healthFix.js'
import { healthCertificateView, type FixFlow } from './certificate/healthCertificateView.js'


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
  { state: 'live' | 'gated' | 'failed'; label: string }
> = {
  certified: {
    state: 'live',
    label: 'OK',
  },
  caution: {
    state: 'gated',
    label: 'ATTENTION',
  },
  fault: {
    state: 'failed',
    label: 'FAILED',
  },
}

const HEALTH_POPUP_VIEW = 'health'
const HEALTH_POPUP_MIN_ROWS = 10
const HEALTH_POPUP_SPARE_ROWS = 7
const HEALTH_POPUP_CHROME_ROWS = 7
const HEALTH_POPUP_COMPACT_CHROME_ROWS = 4
const HEALTH_POPUP_LEGEND_MIN_ROWS = 30
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
  return (
    <InteractiveRow id={`health:row:${check.id}`} selected={active} onSelect={onSelect} onActivate={onActivate} width={width} flexDirection="column" rowRef={rowRef}>
      <Text wrap="truncate-end">
        <CursorCell focused={active} color={accent} />
        <Text color={statusColor(check.status)}>{meta.glyph} </Text>
        <Text color={meta.tone === 'neutral' ? SECOND : IVORY}>{labelCell(check.label)}</Text>
        {!open ? <Text color={FAINT}>{check.status}</Text> : null}
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

const FIX_CARD_DESTRUCTIVE_WORDS = 'DESTRUCTIVE — this discards state that cannot be mechanically recovered. '
const FIX_CARD_CONFIRM_WORDS = '↵ apply · esc cancel'
const FIX_CARD_RUNNING_WORDS = '◐ applying…'

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

function nextActionRows(actions: ReturnType<typeof nextActions>, width: number): number {
  if (actions.length === 0) return 0
  const textWidth = Math.max(1, width - 2)
  return actions.reduce((n, a) => n + wrapText(a.fix ?? '', textWidth, 'wrap').split('\n').length, 0) + 2
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

function resolveHealthSelection(
  checks: readonly Pick<HealthCheck, 'id'>[],
  selectedId: string | null,
): { id: string | null; index: number } {
  if (checks.length === 0) return { id: null, index: 0 }
  if (selectedId !== null) {
    const found = checks.findIndex(c => c.id === selectedId)
    if (found >= 0) return { id: selectedId, index: found }
  }
  return { id: checks[0]!.id, index: 0 }
}

function MercuryHealthCertificate({ onClose, report = runAndRecordHealthReport }: { onClose: () => void; report?: typeof runAndRecordHealthReport }): React.ReactNode {
  const tok = useMercuryTokens()
  const elevatedRef = useElevatedSurface()
  const { columns, rows: termRows } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns })
  const frame = React.useContext(PopupFrameContext)
  const width = frame?.width ?? panelWidth(slot.columns, MODEL_PICKER_PANEL)
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

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const [fixFlow, setFixFlow] = useState<FixFlow | null>(null)

  const checksRef = React.useRef<HealthCheck[]>([])
  const selIdRef = React.useRef<string | null>(null)
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

  useLoad(signal => {
    const acc = new Map<string, HealthSection>()
    report({
      depth: depthRef.current,
      signal,
      onProgress: ev => {
        if (signal.aborted) return
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
        if (signal.aborted) return
        checksRef.current = flatChecks(c.sections)
        setCert(c)
        setLoadError(null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (signal.aborted) return
        setLoadError(String(e))
        setLoading(false)
      })
  }, [runToken])

  const checks = useMemo(
    () => flatChecks(cert ? cert.sections : liveSections),
    [cert, liveSections],
  )
  checksRef.current = checks
  const resolved = resolveHealthSelection(checks, selectedId)
  const sel = resolved.index
  const selId = resolved.id

  const scrollRef = React.useRef<ScrollBoxHandle>(null)
  const selRowRef = React.useRef<DOMElement | null>(null)
  const pageRowsRef = React.useRef(8)
  useLayoutPublish(() => {
    const box = scrollRef.current
    if (!box) return
    if (sel === 0) {
      box.scrollTo(0)
      return
    }
    if (selRowRef.current) {
      box.scrollToElement(selRowRef.current, -CONTEXT_ROWS_ABOVE)
    }
  }, [sel, selId, openId, cert, frameRows, width])
  const openRowScrollStep = (direction: -1 | 1): boolean => {
    const box = scrollRef.current
    const currentId = resolveHealthSelection(checksRef.current, selIdRef.current).id
    const open = openId !== null && openId === currentId
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
  const selectId = (id: string | null): void => {
    selIdRef.current = id
    setSelectedId(id)
  }
  const moveTo = (index: number): void => {
    const clamped = Math.min(Math.max(0, checksRef.current.length - 1), Math.max(0, index))
    selectId(checksRef.current[clamped]?.id ?? null)
  }
  const moveBy = (delta: number): void => {
    const current = resolveHealthSelection(checksRef.current, selIdRef.current).index
    moveTo(current + delta)
  }
  const toggleOpen = (id: string | null): void => {
    if (id === null) return
    selectId(id)
    setOpenId(o => (o === id ? null : id))
  }
  const rerun = (depth: 'fast' | 'deep'): void => {
    depthRef.current = depth
    run()
    selectId(null)
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
        moveBy(step)
        return
      }
      if (action === 'pagePrevious' || action === 'pageNext') {
        event.stopImmediatePropagation()
        const page = Math.max(4, pageRowsRef.current)
        moveBy(action === 'pagePrevious' ? -page : page)
        return
      }
      if (action === 'first' || action === 'last') {
        event.stopImmediatePropagation()
        moveTo(action === 'first' ? 0 : checksRef.current.length - 1)
        return
      }
      if (action === 'enterChild' || action === 'leaveChild') {
        event.stopImmediatePropagation()
        const cur = resolveHealthSelection(checksRef.current, selIdRef.current)
        if (!cur.id) return
        selectId(cur.id)
        if (action === 'enterChild') setOpenId(cur.id)
        else setOpenId(o => (o === cur.id ? null : o))
        return
      }

      if (!pastOpenEvent()) return
      if (action === 'activate') {
        event.stopImmediatePropagation()
        toggleOpen(resolveHealthSelection(checksRef.current, selIdRef.current).id)
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
        const cur = resolveHealthSelection(checksRef.current, selIdRef.current)
        const c = checksRef.current[cur.index]
        if (c && healthFixEnabled() && isFixable(c)) {
          setFixFlow({ phase: 'confirm', check: c })
        }
      }
    },
    { isActive: true },
  )

  const counts = cert ? countByStatus(checks) : null
  const meta = cert ? VERDICT_META[cert.verdict] : null
  const actions = cert && cert.verdict !== 'certified' ? nextActions(checks, 3) : []
  const sections = cert ? cert.sections : liveSections
  const fixRows = fixCardRows(fixFlow, innerW)
  const nextRows = nextActionRows(actions, innerW)
  const contentRows = nextRows + sections.reduce((n, s) => n + 2 + s.checks.length, 0) + (openId ? frameRows : 0)
  const layout = healthPopupLayout(frameRows, fixRows, Math.max(1, contentRows))
  pageRowsRef.current = layout.listRows - 1
  const fixable = checks[sel] !== undefined && healthFixEnabled() && isFixable(checks[sel]!)
  const footer = healthPopupFooter({ rows: checks.length, cursor: sel, fixable }, innerW)
  const statusLine = cert && meta
    ? null
    : loading
      ? `◐ Checking…${progress ? ` ${progress.done}/${progress.total} · ${progress.current}` : ''}`
      : `▲ Health check failed — r retries${loadError ? ` · ${loadError}` : ''}`

  return healthCertificateView({ tok, elevatedRef, width, innerW, ground, cert, loading, openId, fixFlow, checks, scrollRef, selRowRef, selectId, toggleOpen, selId, counts, meta, actions, sections, layout, footer, statusLine, statusColor, HEALTH_POPUP_VIEW, CheckRow, FixCard })
}

export { MercuryHealthCertificate }
