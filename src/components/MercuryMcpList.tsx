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


const NAME_WIDTH = 32
const MAX_ROWS = 12

const RISK_COLOR: Record<string, string> = { low: TEAL, medium: AMBER, high: CRIMSON }

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

  const pastOpenEvent = useOpenEventGate()

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
            {
}
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
