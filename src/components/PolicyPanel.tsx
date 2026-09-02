import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  mcpGauge,
  permissionsSnapshot,
  traceSnapshot,
  type Snapshot,
  type TraceData,
} from '../utils/cockpit/index.js'
import { CRIMSON, FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import {
  Chip,
  CommandCenter,
  SectionHeader,
  StateBadge,
  WarningBanner,
} from './mercury-ui/components.js'
import { GLYPH } from './mercury-ui/glyphs.js'


const MAX_DENIED = 6

export function PolicyPanel({
  mode,
  onClose,
}: {
  mode?: string
  onClose: () => void
}): React.ReactNode {
  const perms = permissionsSnapshot({ mode })
  const mcp = mcpGauge()
  const [trace, setTrace] = useState<Snapshot<{ data: TraceData }> | null>(null)
  useEffect(() => {
    let alive = true
    traceSnapshot().then(s => alive && setTrace(s))
    return () => {
      alive = false
    }
  }, [])

  const p = perms.data
  const deniedRecords =
    trace?.state === 'live'
      ? trace.data.records.filter(r => r.ok === false || r.killed === true).slice(-MAX_DENIED)
      : []

  return (
    <CommandCenter view="policy" onClose={onClose} footer="read-only — /permissions edits rules · config — read live">
      {
}
      <SectionHeader>Authority</SectionHeader>
      <Text>
        <Text color={FAINT}>permission mode  </Text>
        <Chip tone="accent" solid>
          {p.mode}
        </Chip>
        <Text color={FAINT}>  change: shift+tab carousel</Text>
      </Text>
      <Text>
        <Text color={FAINT}>mcp max risk     </Text>
        <Text color={p.mcpPolicyActive ? TEAL : CRIMSON}>{p.mcpMaxRisk}</Text>
        <Text color={FAINT}> · {p.mcpPolicyHint}</Text>
      </Text>
      <Text>
        <Text color={FAINT}>sandbox          </Text>
        <Text color={p.sandbox === 'off' ? FAINT : TEAL}>{p.sandbox}</Text>
        <Text color={FAINT}>  change: /sandbox</Text>
      </Text>
      <Text>
        <Text color={FAINT}>mcp servers      </Text>
        {
}
        <StateBadge
          state={mcp.state === 'live' ? 'configured' : mcp.state}
          label={mcp.state === 'live' ? mcp.data.names.join(', ') : mcp.state}
          mono
        />
        <Text color={FAINT}>  manage: /mcp · states: /capabilities</Text>
      </Text>

      {}
      <SectionHeader count={p.kills.length}>Kill switches</SectionHeader>
      {p.kills.length === 0 ? (
        <Text color={FAINT}>none active — MERCURY_KILL=Tool arms a bypass-immune kill</Text>
      ) : (
        p.kills.map((k, i) => (
          <Text key={i}>
            <Text color={CRIMSON}>× </Text>
            <Text color={IVORY}>{k}</Text>
            <Text color={FAINT}> · bypass-immune</Text>
          </Text>
        ))
      )}

      {}
      <SectionHeader count={p.trusted.length}>Trusted MCP servers</SectionHeader>
      {p.trusted.length === 0 ? (
        <Text color={FAINT}>none — all servers treated as untrusted provenance</Text>
      ) : (
        p.trusted.map((s, i) => (
          <Text key={i}>
            <Text color={TEAL}>● </Text>
            <Text color={IVORY}>{s}</Text>
          </Text>
        ))
      )}

      {
}
      <SectionHeader count={deniedRecords.length}>Failed or killed calls</SectionHeader>
      {trace === null ? (
        <Text color={FAINT}>loading…</Text>
      ) : trace.state !== 'live' ? (
        <Text color={FAINT}>trace {trace.state} — {trace.reason}</Text>
      ) : deniedRecords.length === 0 ? (
        <Text color={FAINT}>none — no failed or killed calls</Text>
      ) : (
        deniedRecords.map((r, i) => (
          <Text key={i}>
            <Text color={CRIMSON}>{r.killed ? GLYPH.circledSlash : GLYPH.fail} </Text>
            <Text color={IVORY}>{r.tool}</Text>
            {typeof r.surface === 'string' ? <Text color={SECOND}> · {r.surface}</Text> : null}
            <Text color={FAINT}>
              {` · ${new Date(r.ts).toLocaleTimeString('en-GB', { hour12: false })}`}
              {r.risk ? ` · ${r.risk}` : ''}
              {typeof r.durationMs === 'number' ? ` · ${Math.round(r.durationMs)}ms` : ''}
            </Text>
          </Text>
        ))
      )}
      {deniedRecords.length > 0 ? (
        <Text color={FAINT}>  full records: /trace</Text>
      ) : null}

      {}
      {!p.mcpPolicyActive ? (
        <Box marginTop={1}>
          <WarningBanner tone="warn" title="MCP max risk permissive" detail="MERCURY_MCP_MAX_RISK=low|medium to tighten" />
        </Box>
      ) : null}
    </CommandCenter>
  )
}
