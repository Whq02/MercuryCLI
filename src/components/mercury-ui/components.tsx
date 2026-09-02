
import * as React from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useElevatedSurface } from './useElevatedSurface.js'
import { Box, MotionParkContext, Text, useInput, useTheme } from '../../ink.js'
import { useCwdState } from '../../hooks/useCwdState.js'
import { formatFreshness, freshnessTone } from '../../utils/cockpit/freshness.js'
import { quantizedNow, subscribeUiClock } from '../../utils/cockpit/uiClock.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { markTransitionEnd } from '../../utils/observability/frictionStopwatch.js'
import { resolveMercuryTokens, spectralRampFor } from '../../utils/mercuryTokens.js'
import { Crab, Wordmark } from './assets.js'
import { rampSegments } from './focalRamp.js'
import { useGreetingShimmer } from './useGreetingShimmer.js'
import { useSessionAccent } from './sessionAccent.js'
import { GLYPH, SPARK, displayWidth, padTo, truncateToWidth } from './glyphs.js'
import { InteractiveRow } from './InteractiveRow.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize, useModalScrollRef } from '../../context/modalContext.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { composeFooterHint, packFooter, type FooterCloseKeys } from './footerHint.js'
import { gaugeColorOf, stateStyleOf, type SnapshotState } from './theme.js'


export const CockpitEmbeddedContext = React.createContext(false)


export function ProductLockup({
  view,
  subtitle,
}: {
  view: string
  subtitle?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const { accent } = useSessionAccent()
  const [theme] = useTheme()
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  const title = `Mercury — ${view}`
  const shimmer = useGreetingShimmer(ramp, displayWidth(title))
  return (
    <Box>
      <Crab />
      <Text> </Text>
      {ramp.length > 1 ? (
        <Text>
          {rampSegments(title, ramp, { shimmer }).map((s, i) => (
            <Text key={i} bold color={s.color}>
              {s.text}
            </Text>
          ))}
        </Text>
      ) : (
        <Text>
          <Wordmark />
          <Text color={t.textMuted}> — {view}</Text>
        </Text>
      )}
      {subtitle ? (
        <Text wrap="truncate-end">
          <Text color={t.textMuted}> · </Text>
          <Text color={t.textPrimary}>{subtitle}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

export function CommandCenter({
  view,
  subtitle,
  footer,
  onClose,
  captureInput = true,
  closeKeys = 'esc-arrow',
  embedded: embeddedProp = false,
  specimen = false,
  elevated = false,
  children,
}: {
  view: string
  subtitle?: string
  footer?: string
  onClose: () => void
  captureInput?: boolean
  closeKeys?: FooterCloseKeys
  embedded?: boolean
  specimen?: boolean
  elevated?: boolean
  children: React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  const embedded = embeddedProp || React.useContext(CockpitEmbeddedContext)
  const elevatedRef = useElevatedSurface()
  React.useEffect(() => {
    if (!embedded) markTransitionEnd('screen-switch')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const closable = closeKeys !== 'none'
  const overlayToken = useRegisterOverlay(`center:${view}`, captureInput && !embedded && closable)
  useInput(
    (_i, key) => {
      if (key.escape || key.leftArrow) {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        onClose()
      }
    },
    { isActive: captureInput && !embedded && closable },
  )
  const groundCwd = useCwdState()
  const dir = groundCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || groundCwd
  const cols = useTerminalSize().columns
  const footerText = packFooter(
    composeFooterHint(footer ?? dir, { closeKeys, captureInput }),
    Math.max(0, cols - 4),
  )
  const insideModal = useIsInsideModal()
  const termRows = useTerminalSize().rows
  const slotRows = useModalOrTerminalSize({ rows: termRows, columns: cols }).rows
  const bodyCap = Math.max(1, slotRows - (5 + (specimen ? 1 : 0)))
  const bodyRef = React.useRef<ScrollBoxHandle | null>(null)
  const modalScrollRef = useModalScrollRef()
  React.useLayoutEffect(() => {
    if (!insideModal || embedded || !modalScrollRef) return
    modalScrollRef.current = bodyRef.current
    return () => {
      modalScrollRef.current = null
    }
  }, [insideModal, embedded, modalScrollRef])
  useInput(
    (_i, key) => {
      const body = bodyRef.current
      if (!body || !(key.pageUp || key.pageDown)) return
      const viewport = body.getViewportHeight()
      if (body.getFreshScrollHeight() <= viewport) return
      body.scrollBy((key.pageUp ? -1 : 1) * Math.max(1, viewport - 1))
    },
    { isActive: insideModal && !embedded },
  )
  if (embedded) {
    return (
      <Box flexDirection="column">
        {specimen ? (
          <Box>
            <Text wrap="truncate-end">
              <Text color={t.textSecondary} bold>{GLYPH.mission} DESIGN SPECIMEN</Text>
              <Text color={t.textMuted}> — a planned/gated design realised in-terminal, not live product</Text>
            </Text>
          </Box>
        ) : null}
        {children}
      </Box>
    )
  }
  return (
    <Box ref={elevated ? elevatedRef : undefined} flexDirection="column" borderStyle="round" borderColor={t.borderStrong} paddingX={1}>
      <ProductLockup view={view} subtitle={subtitle} />
      {specimen ? (
        <Box>
          <Text wrap="truncate-end">
            <Text color={t.textSecondary} bold>{GLYPH.mission} DESIGN SPECIMEN</Text>
            <Text color={t.textMuted}> — a planned/gated design realised in-terminal, not live product</Text>
          </Text>
        </Box>
      ) : null}
      {insideModal ? (
        <ScrollBox ref={bodyRef} flexDirection="column" maxHeight={bodyCap}>
          {children}
        </ScrollBox>
      ) : (
        children
      )}
      {
}
      <InteractiveRow id={`center:${view}:close`} directActivate onActivate={closable ? onClose : undefined} flexDirection="column">
        {
}
        {hover => (
          <Box marginTop={1}>
            <Text color={hover ? t.info : t.textMuted}>{footerText}</Text>
          </Box>
        )}
      </InteractiveRow>
    </Box>
  )
}

export function Panel({
  title,
  accentBorder,
  raised = false,
  children,
}: {
  title?: string
  accentBorder?: boolean
  raised?: boolean
  children: React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={accentBorder ? t.accent : t.textMuted}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      backgroundColor={raised ? t.surface1 : undefined}
      paddingX={1}
    >
      {title ? (
        <Text bold color={t.info}>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  )
}

export function SectionHeader({
  children,
  count,
  marginTop = 1,
}: {
  children: string
  count?: number
  marginTop?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box marginTop={marginTop} flexDirection="row">
      <Text bold color={t.textPrimary}>
        {children}
      </Text>
      {typeof count === 'number' ? <Text color={t.textMuted}> ({count})</Text> : null}
      <Box
        flexGrow={1}
        height={1}
        marginLeft={1}
        borderStyle="single"
        borderColor={t.borderSubtle}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      />
    </Box>
  )
}

export function Heading({ children }: { children: string }): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text bold color={t.info}>
      {children}
    </Text>
  )
}

export function Sep(): React.ReactNode {
  const t = useMercuryTokens()
  return <Text color={t.textMuted}> {GLYPH.sep} </Text>
}

export function Divider({
  label,
  width = 40,
  color,
}: {
  label?: string
  width?: number
  color?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const ink = color ?? t.textMuted
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  if (!label) {
    return <Text color={ink}>{'─'.repeat(width)}</Text>
  }
  const side = Math.max(1, Math.floor((width - displayWidth(label) - 2) / 2))
  return (
    <Text color={ink}>
      {'─'.repeat(side)} {label} {'─'.repeat(side)}
    </Text>
  )
}


export function useNowTick(ms: number | null = 1000): number {
  const parked = React.useContext(MotionParkContext)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!ms || parked) return
    setNow(quantizedNow(ms))
    return subscribeUiClock(ms, () => setNow(quantizedNow(ms)))
  }, [ms, parked])
  return now
}

export function FreshnessLine({
  at,
  now,
  source,
  staleMs = 60_000,
}: {
  at: number
  now: number
  source?: string
  staleMs?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const stale = freshnessTone(now, at, staleMs) === 'stale'
  return (
    <Text color={stale ? t.warning : t.textMuted}>
      {source ? `${source} · ` : ''}
      {formatFreshness(now, at)}
      {stale ? ' · stale' : ''}
    </Text>
  )
}

export function StateBadge({
  state,
  label,
  mono = false,
}: {
  state: SnapshotState
  label?: string
  mono?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const s = stateStyleOf(t, state)
  const text = label ?? s.label
  return (
    <Text>
      <Text color={s.color}>{s.glyph}</Text>
      <Text color={mono ? t.textSecondary : s.color}> {text}</Text>
    </Text>
  )
}

export function StatusDot({
  state,
  glyph,
  color,
}: {
  state?: SnapshotState
  glyph?: string
  color?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  if (state) {
    const s = stateStyleOf(t, state)
    return <Text color={s.color}>{s.glyph}</Text>
  }
  return <Text color={color ?? t.textMuted}>{glyph ?? GLYPH.idle}</Text>
}

type ChipToneName = 'active' | 'warn' | 'danger' | 'idle' | 'pending' | 'neutral' | 'accent'
function chipTone(t: ReturnType<typeof useMercuryTokens>, tone: string): string {
  switch (tone) {
    case 'active': return t.success
    case 'warn': return t.warning
    case 'danger': return t.failure
    case 'idle': return t.textMuted
    case 'accent': return t.accent
    default: return t.textSecondary
  }
}

export function Chip({
  tone = 'neutral',
  solid = false,
  children,
}: {
  tone?: ChipToneName | string
  solid?: boolean
  children: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = chipTone(t, tone)
  return (
    <Text color={color} bold={solid}>
      [ {children} ]
    </Text>
  )
}


export function MetricPill({
  label,
  value,
  tone,
}: {
  label?: string
  value: string
  tone?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text>
      {label ? <Text color={t.textMuted}>{label} </Text> : null}
      <Text color={tone ?? t.textPrimary}>{value}</Text>
    </Text>
  )
}

export type KVRow = {
  k: string
  v: string
  tone?: string
  note?: string
  fit?: 'middle' | 'end'
}
export function KeyValueGrid({
  rows,
  keyWidth = 14,
}: {
  rows: KVRow[]
  keyWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column">
      {rows.map((r, i) =>
        r.fit ? (
          <Box key={i} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={t.textMuted}>{padTo(r.k, keyWidth)}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text
                color={r.tone ?? t.textPrimary}
                wrap={r.fit === 'middle' ? 'truncate-middle' : 'truncate-end'}
              >
                {r.v}
                {r.note ? <Text color={t.textMuted}> {r.note}</Text> : null}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text key={i}>
            <Text color={t.textMuted}>{padTo(r.k, keyWidth)}</Text>
            <Text color={r.tone ?? t.textPrimary}>{r.v}</Text>
            {r.note ? <Text color={t.textMuted}> {r.note}</Text> : null}
          </Text>
        ),
      )}
    </Box>
  )
}

export function ProgressBar({
  value,
  max = 100,
  width = 5,
  tone,
  showPct = false,
}: {
  value: number
  max?: number
  width?: number
  tone?: string
  showPct?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const v = Number.isFinite(value) ? value : 0
  const frac = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0
  const pct = max > 0 ? Math.round((Math.max(0, v) / max) * 100) : 0
  let filled = Math.max(0, Math.min(width, Math.round(frac * width)))
  if (width > 1) {
    if (frac > 0 && filled === 0) filled = 1
    if (frac < 1 && filled === width) filled = width - 1
  }
  const color = tone ?? gaugeColorOf(t, pct)
  const ramp = spectralRampFor(color, t.surface0)
  const flat = ramp.length === 1
  return (
    <Text>
      {flat ? (
        <Text color={color}>{GLYPH.barFull.repeat(filled)}</Text>
      ) : (
        [...Array(filled)].map((_, i) => (
          <Text
            key={i}
            color={ramp[Math.min(ramp.length - 1, Math.floor((i * ramp.length) / Math.max(1, width)))]}
          >
            {GLYPH.barFull}
          </Text>
        ))
      )}
      <Text color={t.textMuted}>{GLYPH.barEmpty.repeat(width - filled)}</Text>
      {showPct ? <Text color={color}> {pct}%</Text> : null}
    </Text>
  )
}

export function Sparkline({
  values,
  color,
  max,
}: {
  values: number[]
  color?: string
  max?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const hi = max ?? values.reduce((m, v) => Math.max(m, v), 0)
  const cells = values
    .map(v => {
      if (!(v > 0)) return SPARK[0]
      if (hi <= 0) return SPARK[0]
      const idx = Math.max(1, Math.min(SPARK.length - 1, Math.round((v / hi) * (SPARK.length - 1))))
      return SPARK[idx]
    })
    .join('')
  return <Text color={color ?? t.info}>{cells}</Text>
}

export function CommandRow({
  command,
  hint,
  disabled = false,
  reason,
}: {
  command: string
  hint?: string
  disabled?: boolean
  reason?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text>
      <Text color={disabled ? t.textMuted : t.accent}>{GLYPH.prompt} </Text>
      <Text color={disabled ? t.textMuted : t.textPrimary}>{command}</Text>
      {hint ? <Text color={t.textMuted}> {hint}</Text> : null}
      {disabled && reason ? <Text color={t.warning}> {reason}</Text> : null}
    </Text>
  )
}


export function EmptyState({
  title,
  hint,
  glyph,
  tone = 'idle',
}: {
  title: string
  hint?: string
  glyph?: string
  tone?: 'idle' | 'gated' | 'danger'
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = tone === 'danger' ? t.failure : tone === 'gated' ? t.warning : t.textMuted
  const g =
    glyph ??
    (tone === 'danger' ? GLYPH.fail : tone === 'gated' ? GLYPH.warn : GLYPH.pending)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{g} </Text>
        <Text color={t.textSecondary}>{title}</Text>
      </Text>
      {hint ? <Text color={t.textMuted}>{hint}</Text> : null}
    </Box>
  )
}

export function WarningBanner({
  tone = 'warn',
  title,
  detail,
}: {
  tone?: 'warn' | 'danger' | 'info'
  title: string
  detail?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const color = tone === 'danger' ? t.failure : tone === 'info' ? t.info : t.warning
  const glyph = tone === 'danger' ? GLYPH.fail : tone === 'info' ? GLYPH.trace : GLYPH.warn
  return (
    <Box borderStyle="single" borderColor={color} borderTop={false} borderRight={false} borderBottom={false} paddingX={1}>
      <Text>
        <Text bold color={color}>
          {glyph} {title}
        </Text>
        {detail ? <Text color={t.textMuted}> · {detail}</Text> : null}
      </Text>
    </Box>
  )
}


export function AgentRow({
  name,
  agentType,
  state = 'idle',
  tasks = [],
  maxWidth,
}: {
  name: string
  agentType?: string
  state?: 'busy' | 'idle' | 'drifting' | 'blocked'
  tasks?: string[]
  maxWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const map: Record<string, { glyph: string; color: string }> = {
    idle: { glyph: GLYPH.idle, color: t.textMuted },
    busy: { glyph: GLYPH.busy, color: t.success },
    drifting: { glyph: GLYPH.drifting, color: t.warning },
    blocked: { glyph: GLYPH.fail, color: t.failure },
  }
  const g = map[state] ?? map.idle!
  const stateColor = state === 'drifting' ? t.warning : state === 'busy' ? t.success : state === 'blocked' ? t.failure : t.textMuted
  return (
    <Text>
      <Text color={g.color}>{g.glyph} </Text>
      <Text color={t.textPrimary}>{maxWidth !== undefined ? truncateToWidth(name, maxWidth) : name}</Text>
      {agentType ? <Text color={t.textMuted}>{` <${agentType}>`}</Text> : null}
      <Text color={t.textMuted}> · </Text>
      <Text color={stateColor}>{state}</Text>
      {tasks.length > 0 ? (
        <Text color={t.textSecondary}> · {tasks.map(id => `#${id}`).join(', ')}</Text>
      ) : null}
    </Text>
  )
}

export function TraceRow({
  time,
  tool,
  risk,
  surface,
  duration,
  ok,
  killed,
  toolWidth = 16,
  surfaceWidth = 14,
}: {
  time: string
  tool: string
  risk?: 'low' | 'medium' | 'high'
  surface?: string
  duration?: string
  ok?: boolean
  killed?: boolean
  toolWidth?: number
  surfaceWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const riskColor = risk === 'high' ? t.failure : risk === 'medium' ? t.warning : risk === 'low' ? t.success : t.textMuted
  let mark = '·'
  let markColor = t.textMuted
  if (killed) {
    mark = GLYPH.circledSlash
    markColor = t.failure
  } else if (ok === false) {
    mark = GLYPH.fail
    markColor = t.failure
  } else if (ok === true) {
    mark = GLYPH.ok
    markColor = t.success
  }
  return (
    <Text>
      <Text color={t.textMuted}>{time} </Text>
      <Text color={killed ? t.textMuted : t.textPrimary}>{padTo(tool, toolWidth)}</Text>
      <Text color={riskColor}>{padTo(risk ?? '?', 7)}</Text>
      <Text color={t.textSecondary}>{padTo(surface ?? '?', surfaceWidth)}</Text>
      <Text color={t.textMuted}>{padTo(duration ?? '', 7)}</Text>
      <Text color={markColor}>{mark}</Text>
      {killed ? <Text color={t.failure}> killed</Text> : null}
    </Text>
  )
}

export function ActivityFeed({
  events,
  showHeader = true,
}: {
  events: React.ComponentProps<typeof TraceRow>[]
  showHeader?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <>
      {showHeader ? (
        <Text color={t.textMuted}>
          {padTo('time', 9)}
          {padTo('tool', 16)}
          {padTo('risk', 7)}
          {padTo('surface', 14)}
          {padTo('dur', 7)}
          ok
        </Text>
      ) : null}
      {events.map((e, i) => (
        <TraceRow key={i} {...e} />
      ))}
    </>
  )
}

export function GateRow({
  name,
  on,
  hint,
  nameWidth = 27,
  hintWidth,
}: {
  name: string
  on: boolean
  hint?: string
  nameWidth?: number
  hintWidth?: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const nm = padTo(truncateToWidth(name, nameWidth - 1), nameWidth)
  const ht = hint ? (hintWidth ? truncateToWidth(hint, hintWidth) : hint) : ''
  return (
    <Text>
      <Text color={on ? t.success : t.textMuted}>{on ? GLYPH.done : GLYPH.pending}</Text>
      <Text> </Text>
      <Text color={on ? t.textPrimary : t.textSecondary}>{nm}</Text>
      {ht ? <Text color={t.textMuted}>{ht}</Text> : null}
    </Text>
  )
}

export type MapNode = {
  name: string
  state?: SnapshotState
  detail?: string
}
export function SystemMap({
  title,
  nodes,
}: {
  title?: string
  nodes: MapNode[]
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column">
      {title ? <Heading>{title}</Heading> : null}
      {nodes.map((n, i) => {
        const s = stateStyleOf(t, n.state ?? 'off')
        return (
          <Text key={i}>
            <Text color={s.color}>{s.glyph} </Text>
            <Text color={n.state === 'off' ? t.textSecondary : t.textPrimary}>{n.name}</Text>
            {n.detail ? <Text color={t.textMuted}> · {truncateToWidth(n.detail, 28)}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

export function UsageMeter({
  window,
  value,
  max = 100,
  resetIn,
  state = 'live',
  hint,
  labelWidth = 4,
  compact = false,
  numberOnly = false,
}: {
  window: string
  value?: number
  max?: number
  resetIn?: string
  state?: SnapshotState
  hint?: string
  labelWidth?: number
  compact?: boolean
  numberOnly?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  if (compact) {
    if (state !== 'live' || !Number.isFinite(value)) {
      const s = stateStyleOf(t, state === 'live' ? 'unavailable' : state)
      return (
        <Text>
          <Text color={t.textMuted}>{window} </Text>
          <Text color={s.color}>{s.glyph}</Text>
        </Text>
      )
    }
    const pct = Math.round((Math.max(0, value as number) / max) * 100)
    if (numberOnly) {
      return (
        <Text>
          <Text color={t.textMuted}>{window} </Text>
          <Text color={gaugeColorOf(t, pct)}>{pct}%</Text>
          {resetIn ? <Text color={t.textMuted}> {resetIn}</Text> : null}
        </Text>
      )
    }
    return (
      <Text>
        <Text color={t.textMuted}>{window} </Text>
        <ProgressBar value={value as number} max={max} width={4} showPct={false} />
        <Text color={t.textMuted}> {pct}%</Text>
        {resetIn ? <Text color={t.textMuted}> {resetIn}</Text> : null}
      </Text>
    )
  }
  if (state !== 'live' || !Number.isFinite(value)) {
    const s = stateStyleOf(t, state === 'live' ? 'unavailable' : state)
    return (
      <Text>
        <Text color={t.textMuted}>{padTo(window, labelWidth)} </Text>
        <Text color={s.color}>{s.glyph} </Text>
        <Text color={t.textSecondary}>{hint ?? s.label}</Text>
      </Text>
    )
  }
  return (
    <Text>
      <Text color={t.textMuted}>{padTo(window, labelWidth)} </Text>
      <ProgressBar value={value as number} max={max} width={8} showPct />
      {resetIn ? <Text color={t.textMuted}> · resets {resetIn}</Text> : null}
    </Text>
  )
}
