import * as React from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import {
  getMcpGaugeVersion,
  mcpGauge,
  subscribeMcpGauge,
  type McpData,
  type McpServerState,
  type Snapshot,
} from '../utils/cockpit/index.js'

// ============================================================================
//  MercuryMcpList — the warm-ink MCP server roster. Reads mcpGauge (the ONE
//  MCP owner: configured rows joined with this process's live connections —
//  render-safe, never connects itself) and follows its publish version, so a
//  server that connects, fails, needs auth or is disabled repaints its mark
//  the instant the connection manager publishes: `off` when none configured
//  (honest, not an error), `unavailable` if the config can't be read, `live`
//  with a server roster otherwise. Every row wears its LIVENESS MARK
//  (operator-approved): ● ready · ◔ connecting · △ needs auth ·
//  ✕ failed · ◇ configured/off. A real list: ↑↓ moves the in-row cursor
//  (clamp, never wrap), ↵ surfaces an honest "manage in /mcp" note (the main
//  connection manager owns the real toggles), esc closes. One useInput over a
//  local selectedIndex, isActive-gated, 150ms enter-buffer. The list is
//  bounded with a `+N more`; server names truncate to the column width.
// ============================================================================

const NAME_WIDTH = 32
const MAX_ROWS = 12

const RISK_COLOR: Record<string, string> = { low: TEAL, medium: AMBER, high: CRIMSON }

/** The liveness mark per server state — the approved glyph and its tone. */
export const MCP_STATE_MARK: Record<McpServerState, { glyph: string; color: string; word: string }> = {
  ready: { glyph: GLYPH.ok, color: TEAL, word: 'ready' },
  starting: { glyph: '◔', color: SECOND, word: 'connecting' },
  'needs-auth': { glyph: '△', color: AMBER, word: 'needs auth' },
  failed: { glyph: GLYPH.fail, color: CRIMSON, word: 'failed' },
  disabled: { glyph: GLYPH.diamond, color: FAINT, word: 'off' },
  configured: { glyph: GLYPH.diamond, color: FAINT, word: 'configured' },
}

const UNREADABLE: Snapshot<{ data: McpData }> = {
  state: 'unavailable',
  data: {
    servers: [],
    names: [],
    counts: { ready: 0, starting: 0, needsAuth: 0, failed: 0, disabled: 0, configured: 0, total: 0 },
    maxRisk: 'high',
    mcpPolicyActive: false,
    mcpPolicyHint: 'high · permissive',
    runtimeStampedAt: null,
  },
  reason: 'mcp config unreadable',
}

export function MercuryMcpList({
  onClose,
  isActive = true,
}: {
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  const accent = useSessionAccent().accent
  // Live: the gauge's publish version is the subscription; the read itself is
  // the config half (synchronous, render-safe) joined with the published
  // connections, memoized per version so a keystroke never re-reads disk.
  const version = useSyncExternalStore(subscribeMcpGauge, getMcpGaugeVersion, getMcpGaugeVersion)
  const snap = useMemo<Snapshot<{ data: McpData }>>(() => {
    try {
      return mcpGauge()
    } catch {
      return UNREADABLE
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version IS the dependency
  }, [version])

  const servers = snap.data.servers
  const shown = useMemo(() => servers.slice(0, MAX_ROWS), [servers])

  const [sel, setSel] = useState(0)
  const [note, setNote] = useState<string | null>(null)

  // 150ms buffer so the keystroke that launched the list doesn't immediately
  // confirm — an open-event seq gate (event identity, not wall-clock). Only
  // ↵ waits; esc/arrows respond instantly.
  const pastOpenEvent = useOpenEventGate()

  // Keep the cursor in range if the roster shrinks under it.
  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  useInput(
    (_input, key) => {
      if (!isActive) return
      if (key.escape) {
        onClose()
        return
      }
      if (key.upArrow) {
        setSel(s => Math.max(0, s - 1))
        setNote(null)
        return
      }
      if (key.downArrow) {
        setSel(s => Math.min(Math.max(0, shown.length - 1), s + 1))
        setNote(null)
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        const row = shown[Math.min(sel, Math.max(0, shown.length - 1))]
        if (row) {
          setNote(`${row.name} · ${MCP_STATE_MARK[row.state].word} — ${row.detail} · manage (enable/disable, reconnect, tools) in /mcp`)
        }
        return
      }
    },
    { isActive },
  )

  // Honest empty/unavailable — a missing source is a state.
  if (snap.state !== 'live' || servers.length === 0) {
    return (
      <CommandCenter view="mcp" onClose={onClose}>
        <Box marginTop={1}>
          <EmptyState
            tone={snap.state === 'unavailable' ? 'danger' : 'idle'}
            title={snap.reason ?? 'no MCP servers configured'}
            hint="add a server with /mcp (or in config.mcpServers) — then they appear here"
          />
        </Box>
      </CommandCenter>
    )
  }

  const maxRisk = snap.data.maxRisk
  // Color the gate by whether the policy is ACTIVE (per-server overrides count),
  // not by the bare-default risk WORD: a clamp leaves maxRisk='high' yet the gate
  // is enforcing, so RISK_COLOR['high']=CRIMSON would falsely read 'wide open'.
  const riskColor = snap.data.mcpPolicyActive ? TEAL : (RISK_COLOR[maxRisk] ?? FAINT)

  return (
    <CommandCenter view="mcp" onClose={onClose} captureInput={false} footer={isActive ? '↑↓ move · ↵ manage' : 'showcase specimen — keys inert'}>
      <Box marginTop={1}>
        <Text>
          <StateBadge state="live" label="MCP servers" />
          <Text color={FAINT}> · max exposed risk </Text>
          <Text color={riskColor}>{maxRisk}</Text>
          <Text color={FAINT}> · {snap.data.mcpPolicyHint}</Text>
        </Text>
      </Box>

      <SectionHeader count={servers.length}>Servers</SectionHeader>
      {shown.map((row, i) => {
        const here = i === sel
        const mark = MCP_STATE_MARK[row.state]
        return (
          <Text key={row.name}>
            <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
            {/* The liveness mark — the gauge's per-server state word as the
                approved glyph + tone; a server this process has not connected
                keeps the neutral hollow diamond (configured), never a claim. */}
            <Text color={mark.color}>{mark.glyph} </Text>
            <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(row.name, NAME_WIDTH), NAME_WIDTH)}</Text>
          </Text>
        )
      })}
      {servers.length > shown.length ? (
        <Text color={FAINT}>  +{servers.length - shown.length} more</Text>
      ) : null}

      {note ? (
        <Box marginTop={1}>
          <Text>
            <StateBadge state="gated" label="" mono />
            <Text color={AMBER}>{truncateToWidth(note, 72)}</Text>
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
