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

// ============================================================================
//  DaemonSupervisorView — the /daemon control-plane COCKPIT.
//
//  This was a static design specimen (a hard-coded ROSTER under an OFF badge whose
//  footer read "do not fake live state until the backend exists"). The backend DOES
//  exist: getMercuryDaemonStatus() (src/daemon/status.ts) is a complete, never-throws
//  control-socket RPC client. So this now reads the operator's REAL supervisor and
//  renders it — pid/uptime, the long-lived Implementer worker (model/effort/context
//  -fill/respawns/busy), the breaker, lease holders, the loud DEGRADED escalation,
//  and the fire-outcome rollup. The "damn" for an away operator: type /daemon and
//  SEE whether the Implementer is busy, how full its context is, how many times it
//  respawned, and whether the breaker tripped — no guesswork.
//
//  Honest discipline (the live-read idiom, shared with /saturn): a SYNC pid probe paints
//  the first frame, the async RPC fills the detail, and supervisor===null is an
//  honest-empty card — live state is NEVER fabricated. The row/badge derive is a
//  pure, provable function (utils/cockpit/daemonSupervisorRows); the text phrasing
//  mirrors formatMercuryDaemonStatus so the TUI and `mercury daemon status` agree.
//  READ-ONLY: this surface never starts, stops, or mutates the daemon — `r` re-probes
//  and a stamp-gated slow auto-poll (MERCURY_DAEMON_COCKPIT_POLL) re-reads it, nothing more.
//
//  Keyboard (ink-component-patterns): ONE useInput over a local selectedIndex, a
//  150ms enter-buffer, clamp-don't-wrap, gated `isActive`; ↵ toggles an inline
//  untruncated-fields drill under the selected worker row; esc/← close (CommandCenter
//  mounts captureInput=false so our useInput owns esc). Standalone-only (NOT in the
//  cockpit-tower TABS), so isActive:true is correct.
// ============================================================================

const MAX_ROWS = 12
// read-only auto-refresh cadence for an open cockpit (slow enough to be cheap,
// fast enough that an away operator isn't staring at a frozen snapshot).
const COCKPIT_POLL_MS = 4000
// how long the `r` completion note ('refreshed ✓') shows before it self-clears,
// so the manual re-probe never lingers as a perpetual banner.
const NOTE_EXPIRE_MS = 2500

// Belt-and-suspenders only: getMercuryDaemonStatus NEVER throws, but if it somehow
// rejected we resolve to this honest-empty status rather than spin on "probing".
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
  // The rows wore a fixed
  // ~74-cell geometry (14-cell name + 56-cell detail) whatever the
  // terminal — clipped at 80 columns, wasting half a 160-column pane while
  // the model id (the detail's first casualty) stayed cut. The detail and
  // the supervisor dir now spend the LIVE width; the name column and the
  // status-first ordering stay ruled as they were.
  const { columns: termCols } = useTerminalSize()
  const detailBudget = Math.max(40, termCols - 24)
  const dirBudget = Math.max(40, termCols - 22)
  const accent = useSessionAccent().accent
  // stamp-gated read-only auto-refresh. Opt out with MERCURY_DAEMON_COCKPIT_POLL=0
  // ⇒ false ⇒ no interval below, byte-identical to the manual-only `r` behavior.
  const pollEnabled = React.useMemo(
    () => (flagEnv('MERCURY_DAEMON_COCKPIT_POLL') === '0' ? false : true),
    [],
  )
  // Cheap SYNC pid probe → an honest first paint before the RPC resolves.
  const sync = React.useMemo<{ state: string; reason?: string }>(() => {
    try {
      return daemonSnapshot()
    } catch {
      return { state: 'off', reason: '' }
    }
  }, [])
  const [status, setStatus] = React.useState<MercuryDaemonStatus | null>(null)
  const [sel, setSel] = React.useState(0)
  // The cursor's IDENTITY.
  // A bare index over a roster that reaps and reorders under the 4-second
  // poll teleported the cursor (and the open drill) to a different seat
  // per refresh. The key survives the shuffle; a reaped seat falls to the
  // clamped index (its nearest surviving neighbour).
  const [selKey, setSelKey] = React.useState<string | null>(null)
  const [loadId, setLoadId] = React.useState(0)
  const [note, setNote] = React.useState<string | null>(null)
  // When the LAST probe completed — drives the footer's `↻ Ns ago` stamp so
  // the cockpit says how old what you're looking at is (trust-cockpit W2a).
  // 0 until the first resolve renders the honest `↻ —`.
  const [probedAt, setProbedAt] = React.useState(0)
  // ↵ toggles an inline detail grid under the selected worker row — the
  // untruncated fields the 56-col row detail clips (model id first casualty).
  const [detailOpen, setDetailOpen] = React.useState(false)
  const now = useNowTick()

  // 150ms buffer so the keystroke that launched /daemon doesn't immediately
  // fire `r` or ↵ (the launching Enter would instantly toggle the drill) — as
  // a open-event seq gate (event identity, not wall-clock), not the old setTimeout→setState flag whose
  // parked commit swallowed the first keypress nondeterministically
  //
  // esc/← and ↑↓ respond instantly; only the ACTION keys (↵ · r) wait.
  const pastOpenEvent = useOpenEventGate()

  // Probe the daemon (read-only). `loadId` bump re-probes — manual `r` or the
  // stamp-gated auto-poll below. Never throws. On resolve we flip a PENDING manual
  // `r` note to a completion signal (then self-expire it) so it never lingers as a
  // perpetual "re-probe …"; a silent auto-poll leaves note===null, so it stays quiet.
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
        // the probe DID complete (resolved-empty) — stamp it, honest age.
        setProbedAt(Date.now())
      })
    return () => {
      alive = false
      if (expiry) clearTimeout(expiry)
    }
  }, [loadId])

  // read-only auto-poll — bump `loadId` on a slow timer so the probe effect
  // above re-runs and an open cockpit stays live. Cleared on unmount. OFF (flag =0)
  // ⇒ pollEnabled false ⇒ no interval, byte-identical.
  React.useEffect(() => {
    if (!pollEnabled) return
    const id = setInterval(() => setLoadId(n => n + 1), COCKPIT_POLL_MS)
    return () => clearInterval(id)
  }, [pollEnabled])

  const probing = status === null
  const v = deriveSupervisorRows(status)
  // Selection-centered window over ALL workers (cap-then-clamp-to-cap fix,
  // flare pass): the cursor ranges the full roster; MAX_ROWS only
  // bounds what's PAINTED, sliding with the cursor. Workers past #12 were
  // permanently unreachable before.
  const indexClamped = Math.min(sel, Math.max(0, v.workers.length - 1))
  // The key wins where it still exists; the clamped index is the reap
  // fallback. The effect below re-anchors the index state so the next
  // arrow moves from the row the operator SEES.
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
        // inline drill, not a subview — follows the cursor while open, so ↑↓
        // reads the next worker's untruncated fields without re-toggling.
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
        // honest first paint from the cheap sync pid probe
        <Box marginTop={1}>
          <Text color={FAINT}>{GLYPH.drifting} probing control socket … </Text>
          <Text color={sync.state === 'live' ? TEAL : FAINT}>{sync.reason || sync.state}</Text>
        </Box>
      ) : v.empty ? (
        <Box marginTop={1} flexDirection="column">
          <EmptyState glyph="○" title="no daemon running" hint={v.empty} />
          <Text color={FAINT}>  the supervisor + Implementer start headless; nothing is fabricated here</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* supervisor identity */}
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

          {/* the loud DEGRADED escalation — the centerpiece for an away-run */}
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
          {/* the version gap (the handshake): the daemon against this build + the heal's status */}
          {v.version ? (
            <Box marginTop={1}>
              <WarningBanner tone="warn" title="version" detail={v.version} />
            </Box>
          ) : null}

          {/* worker roster */}
          <SectionHeader count={v.workers.length}>Workers</SectionHeader>
          {visible.length === 0 ? (
            <Text color={FAINT}>  no long-lived workers rostered (the Implementer spawns on first dispatch)</Text>
          ) : (
            <>
            {winStart > 0 ? <Text color={FAINT}>{`  ↑ +${winStart} above`}</Text> : null}
            {
            visible.map((w, i) => {
              const active = winStart + i === clampedSel
              // OUTCOME FIRST (the deck's own law, daemon-settled-worker-idle-
              // costume): a settled seat — DEGRADED after the respawn budget,
              // crashed, killed — never wears the idle costume; the roster
              // keeps it until reap, so this row is the operator's only tell.
              const settled = w.outcome !== undefined
              const failed = w.outcome === 'degraded' || w.outcome === 'crashed' || w.outcome === 'killed'
              // busy shows HOW LONG the current turn has run; a stall (busy too long)
              // is the loud AMBER heads-up before the maxTurnMs watchdog kills it.
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
              // Status-first so a narrow (80-col) truncation cuts the long model
              // id, NOT the at-a-glance signals (busy / elapsed / respawns / ctx).
              const detail = `${w.state} · ${activity} · respawns ${w.respawns} · ctx ${w.ctx} · ${w.model}/${w.effort}`
              // ↵ drill: the row's clipped fields, UNTRUNCATED (the 56-col
              // truncate cuts the model id first) — inline under the selected
              // row, never a subview (esc keeps meaning close).
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

          {/* supervisor health: breaker · leases */}
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

          {/* fire-outcome rollup — "every wake has an outcome" */}
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
