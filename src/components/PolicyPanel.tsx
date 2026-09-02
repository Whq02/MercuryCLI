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

// ============================================================================
//  PolicyPanel — the Mercury governance posture (the /policy view). A
//  READ-ONLY dashboard distinct from the base /permissions RULE EDITOR (which
//  is untouched, priority #1): permission mode, MCP max risk, sandbox, trusted
//  servers, capability kill-switches, and denials this session (from the
//  trace). Reads through utils/cockpit snapshots; never mutates a rule. The
//  live account/scope owners are /accounts · /delegate.
// ============================================================================

const MAX_DENIED = 6

export function PolicyPanel({
  mode,
  onClose,
}: {
  /** Live permission mode; optional because the cockpit tab system renders all
   *  tabs uniformly. permissionsSnapshot handles an absent mode. */
  mode?: string
  onClose: () => void
}): React.ReactNode {
  const perms = permissionsSnapshot({ mode })
  const mcp = mcpGauge()
  // Denials this session come from the invocation trace (real source); off → honest.
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
    // footer freshness (trust-cockpit W2a): the panel is sync gate/config
    // reads — "config — read live" is the honest stamp (nothing to age), vs
    // the sibling tabs' `↻ Ns ago` on genuinely async feeds.
    <CommandCenter view="policy" onClose={onClose} footer="read-only — /permissions edits rules · config — read live">
      {/* AUTHORITY — every row names its LEVER (
          the operator stared at a read-only board with no pointer to where
          each posture is actually changed). */}
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
        {/* Config is not a connection: a configured server list reads
            `configured` (live per-server states live in /capabilities). */}
        <StateBadge
          state={mcp.state === 'live' ? 'configured' : mcp.state}
          label={mcp.state === 'live' ? mcp.data.names.join(', ') : mcp.state}
          mono
        />
        <Text color={FAINT}>  manage: /mcp · states: /capabilities</Text>
      </Text>

      {/* KILL SWITCHES */}
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

      {/* TRUSTED MCP */}
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

      {/* FAILED / KILLED (honest label — the set includes plain ok:false
          errors, not just gate denials; product-study r2 glyph-grammar) */}
      <SectionHeader count={deniedRecords.length}>Failed or killed calls</SectionHeader>
      {trace === null ? (
        <Text color={FAINT}>loading…</Text>
      ) : trace.state !== 'live' ? (
        <Text color={FAINT}>trace {trace.state} — {trace.reason}</Text>
      ) : deniedRecords.length === 0 ? (
        <Text color={FAINT}>none — no failed or killed calls</Text>
      ) : (
        // Distinguishable rows (six identical "× Bash · builtin"
        // rows carried zero signal). The trace is SHAPE-ONLY by doctrine (no
        // command text), so distinguish with what it does carry — clock, risk,
        // duration — and point at /trace for the full record.
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

      {/* WARNING */}
      {!p.mcpPolicyActive ? (
        <Box marginTop={1}>
          <WarningBanner tone="warn" title="MCP max risk permissive" detail="MERCURY_MCP_MAX_RISK=low|medium to tighten" />
        </Box>
      ) : null}
    </CommandCenter>
  )
}
