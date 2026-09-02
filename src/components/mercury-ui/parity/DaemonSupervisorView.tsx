import * as React from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { formatFreshness } from '../../../utils/cockpit/freshness.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import {
  CommandCenter,
  EmptyState,
  KeyValueGrid,
  SectionHeader,
  StateBadge,
  useNowTick,
  WarningBanner,
  type KVRow,
} from '../components.js'
import { GLYPH, padTo, truncateToWidth } from '../glyphs.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { CursorCell } from '../LiveGlyphs.js'
import { useSessionAccent } from '../sessionAccent.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { getMercuryDaemonStatus, type MercuryDaemonStatus } from '../../../daemon/status.js'
import { daemonSnapshot } from '../../../utils/cockpit/daemonSnapshot.js'
import { deriveSupervisorRows } from '../../../utils/cockpit/daemonSupervisorRows.js'


const MAX_ROWS = 12
const COCKPIT_POLL_MS = 4000
const NOTE_EXPIRE_MS = 2500

const EMPTY_STATUS: MercuryDaemonStatus = {
  supervisor: null,
  controlSock: '',
  controlReachable: false,
  workersLive: null,
  workersTotal: null,
  breakerOpen: null,
  maxInflight: null,
  leaseCount: null,
  proto: null,
  degraded: null,
  warmRunners: null,
  fireOutcomes: null,
  handshake: null,
  versionLine: null,
  workers: [],
}

export function DaemonSupervisorView({ onClose }: { onClose: () => void }): React.ReactNode {
  const { columns: termCols } = useTerminalSize()
  const detailBudget = Math.max(40, termCols - 24)
  const dirBudget = Math.max(40, termCols - 22)
  const accent = useSessionAccent().accent
  const pollEnabled = React.useMemo(
    () => (flagEnv('MERCURY_DAEMON_COCKPIT_POLL') === '0' ? false : true),
    [],
  )
  const sync = React.useMemo<{ state: string; reason?: string }>(() => {
    try {
      return daemonSnapshot()
    } catch {
      return { state: 'off', reason: '' }
    }
  }, [])
  const [status, setStatus] = React.useState<MercuryDaemonStatus | null>(null)
  const [sel, setSel] = React.useState(0)
  const [selKey, setSelKey] = React.useState<string | null>(null)
  const [loadId, setLoadId] = React.useState(0)
  const [note, setNote] = React.useState<string | null>(null)
  const [probedAt, setProbedAt] = React.useState(0)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const now = useNowTick()

  const pastOpenEvent = useOpenEventGate()

  React.useEffect(() => {
    let alive = true
    let expiry: ReturnType<typeof setTimeout> | undefined
    getMercuryDaemonStatus()
      .then(s => {
        if (!alive) return
        setStatus(s)
        setProbedAt(Date.now())
        setNote(prev => (prev ? 'refreshed ✓' : prev))
        expiry = setTimeout(() => {
          if (alive) setNote(prev => (prev === 'refreshed ✓' ? null : prev))
        }, NOTE_EXPIRE_MS)
      })
      .catch(() => {
        if (!alive) return
        setStatus(EMPTY_STATUS)
        setProbedAt(Date.now())
      })
    return () => {
      alive = false
      if (expiry) clearTimeout(expiry)
    }
  }, [loadId])

  React.useEffect(() => {
    if (!pollEnabled) return
    const id = setInterval(() => setLoadId(n => n + 1), COCKPIT_POLL_MS)
    return () => clearInterval(id)
  }, [pollEnabled])

  const probing = status === null
  const v = deriveSupervisorRows(status)
  const indexClamped = Math.min(sel, Math.max(0, v.workers.length - 1))
  const keyAt = selKey !== null ? v.workers.findIndex(w => w.short === selKey) : -1
  const clampedSel = keyAt >= 0 ? keyAt : indexClamped
  React.useEffect(() => {
    if (sel !== clampedSel) setSel(clampedSel)
  }, [sel, clampedSel])
  const winStart = Math.max(
    0,
    Math.min(clampedSel - Math.floor(MAX_ROWS / 2), v.workers.length - MAX_ROWS),
  )
  const visible = v.workers.slice(winStart, winStart + MAX_ROWS)
  const hiddenBelow = v.workers.length - winStart - visible.length

  useInput(
    (input, key) => {
      if (key.escape || key.leftArrow) {
        onClose()
        return
      }
      if (key.upArrow) {
        const next = Math.max(0, clampedSel - 1)
        setSel(next)
        setSelKey(v.workers[next]?.short ?? null)
        setNote(null)
        return
      }
      if (key.downArrow) {
        const next = Math.min(Math.max(0, v.workers.length - 1), clampedSel + 1)
        setSel(next)
        setSelKey(v.workers[next]?.short ?? null)
        setNote(null)
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        if (visible.length > 0) setDetailOpen(o => !o)
        return
      }
      if (input === 'r') {
        setNote('re-probe control socket (read-only)')
        setLoadId(n => n + 1)
        return
      }
    },
    { isActive: true },
  )

  const refresh = pollEnabled ? 'r re-probe · live' : 'r re-probe'
  const stamp = formatFreshness(now, probedAt)
  const footer =
    v.workers.length > 0
      ? `↑↓ move · ↵ detail · ${refresh} · ${stamp}`
      : `${refresh} · ${stamp}`

  return (
    <CommandCenter
      view="daemon"
      subtitle="supervisor + workers"
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      {probing ? (
        <Box marginTop={1}>
          <Text color={FAINT}>{GLYPH.drifting} probing control socket … </Text>
          <Text color={sync.state === 'live' ? TEAL : FAINT}>{sync.reason || sync.state}</Text>
        </Box>
      ) : v.empty ? (
        <Box marginTop={1} flexDirection="column">
          <EmptyState glyph="○" title="no daemon running" hint={v.empty} />
          <Text color={FAINT}>  the supervisor starts headless; nothing is fabricated here</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {}
          <Box marginTop={1}>
            <StateBadge state={v.badge} label={v.badgeLabel} />
            <Text color={FAINT}> · localhost-only ◆ safe</Text>
          </Box>
          {v.supervisorLine ? (
            <Text>
              <Text color={FAINT}>{'  supervisor  '}</Text>
              <Text color={IVORY}>{v.supervisorLine}</Text>
            </Text>
          ) : null}
          {v.dir ? <Text color={FAINT}>{`  dir         ${truncateToWidth(v.dir, dirBudget)}`}</Text> : null}

          {}
          {v.degraded ? (
            <Box marginTop={1}>
              <WarningBanner tone="danger" title="DEGRADED" detail={v.degraded} />
            </Box>
          ) : null}
          {v.orphanWarning ? (
            <Box marginTop={1}>
              <WarningBanner tone="warn" title="orphaned record" detail={v.orphanWarning} />
            </Box>
          ) : null}
          {}
          {v.version ? (
            <Box marginTop={1}>
              <WarningBanner tone="warn" title="version" detail={v.version} />
            </Box>
          ) : null}

          {}
          <SectionHeader count={v.workers.length}>Workers</SectionHeader>
          {visible.length === 0 ? (
            <Text color={FAINT}>  no long-lived workers rostered (a crew or session seat spawns on its engage)</Text>
          ) : (
            <>
            {winStart > 0 ? <Text color={FAINT}>{`  ↑ +${winStart} above`}</Text> : null}
            {
            visible.map((w, i) => {
              const active = winStart + i === clampedSel
              const settled = w.outcome !== undefined
              const failed = w.outcome === 'degraded' || w.outcome === 'crashed' || w.outcome === 'killed'
              const activity = settled
                ? failed
                  ? `${GLYPH.fail} ${w.outcome}`
                  : `settled · ${w.outcome}`
                : w.busy
                  ? w.stalled
                    ? `${GLYPH.uptri} stalled ${w.elapsed}`
                    : w.elapsed
                      ? `busy ${w.elapsed}`
                      : 'busy'
                  : 'idle'
              const leadInk = failed ? CRIMSON : settled ? FAINT : w.stalled ? AMBER : w.busy ? TEAL : SECOND
              const detail = `${w.state} · ${activity} · respawns ${w.respawns} · ctx ${w.ctx} · ${w.model}/${w.effort}`
              const drill: KVRow[] = [
                { k: 'model', v: w.model, tone: IVORY },
                { k: 'effort', v: w.effort, tone: IVORY },
                { k: 'ctx', v: w.ctx, tone: IVORY },
                { k: 'turn', v: activity, tone: failed ? CRIMSON : w.stalled ? AMBER : w.busy ? TEAL : FAINT },
                { k: 'respawns', v: String(w.respawns), tone: IVORY },
                { k: 'state', v: w.state, tone: failed ? CRIMSON : SECOND },
              ]
              return (
                <React.Fragment key={w.short + i}>
                  <Text>
                    <CursorCell focused={active} color={accent} />
                    <Text color={leadInk}>
                      {failed ? GLYPH.fail : w.busy ? GLYPH.inProgress : GLYPH.done}{' '}
                    </Text>
                    <Text color={IVORY}>{padTo(w.short, 14)}</Text>
                    <Text color={failed ? CRIMSON : w.stalled ? AMBER : FAINT}>{truncateToWidth(detail, detailBudget)}</Text>
                  </Text>
                  {active && detailOpen ? (
                    <Box paddingLeft={4} flexDirection="column">
                      <KeyValueGrid rows={drill} keyWidth={9} />
                    </Box>
                  ) : null}
                </React.Fragment>
              )
            })
            }
            </>
          )}
          {hiddenBelow > 0 ? <Text color={FAINT}>{`  +${hiddenBelow} more`}</Text> : null}

          {}
          <Box marginTop={1}>
            <Text color={FAINT}>{'  breaker  '}</Text>
            <Text color={v.breakerOpen ? AMBER : SECOND}>{v.breaker ?? '—'}</Text>
            {v.leases !== null ? (
              <Text>
                <Text color={FAINT}>{'   ·  leases '}</Text>
                <Text color={SECOND}>{v.leases}</Text>
              </Text>
            ) : null}
          </Box>

          {}
          {v.fireLine ? (
            <Text>
              <Text color={FAINT}>{'  '}</Text>
              <Text color={SECOND}>{v.fireLine}</Text>
            </Text>
          ) : null}
          {v.recentLine ? <Text color={FAINT}>{`  ${v.recentLine}`}</Text> : null}

          {note ? (
            <Box marginTop={1}>
              <Text color={TEAL}>{GLYPH.drifting} {note}</Text>
            </Box>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={FAINT}>read-only · this view never starts, stops, or mutates the daemon</Text>
      </Box>
    </CommandCenter>
  )
}
