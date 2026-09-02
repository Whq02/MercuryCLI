// MercuryPermissionsPanel — authority control (real Ink).
// Three zones, top to bottom:
//   1. capability gates  — READ-ONLY. They reflect BOOT-TIME env flags / live
//      substrate probes; there is no runtime setter for them, so toggling one
//      would lie. Inspect-only (↑↓).
//   2. feature toggles   — WRITABLE. The Mercury feature toggles (five default-off opt-ins + one default-on capability) whose
//      gates re-read their env var LIVE each call (featureToggles.ts), so a
//      runtime flip is honest — ↵/space sets process.env and behavior changes
//      going forward (scope note per row). Session-scoped.
//   3. danger zone       — the bypass toggle: ↵/space drives the real
//      toolPermissionContext.mode and lights the standing CRIMSON ▸▸ badge.
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import type { FeatureToggle } from '../utils/featureToggles.js'
// Status/danger spine fixed (TEAL/CRIMSON); identity (TERRA) is the live critter
// hue, read at render so a /critter pick re-tints this panel.
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

// Plain-language "what it does + what it risks" for the highlighted row, shown as
// a detail line below the list (master-detail) so the rows stay compact but the
// panel explains itself. Keyed by gate name / feature key / 'bypass'. Kept short
// to fit 80 cols; a row with no risk (a safety-positive always-on gate) omits it.
const DESC: Record<string, { effect: string; risk?: string }> = {
  // capability gates (read-only)
  'Capability kill-switch': {
    effect: 'Hard-blocks chosen tools so nothing — not even bypass — can run them.',
    risk: 'A kill is absolute; a wrong target disables a tool you need.',
  },
  'MCP policy gate': {
    effect: 'Caps which external (MCP) tools may run, by risk level.',
    risk: 'Too strict and useful MCP tools disappear.',
  },
  'MCP trust cards': {
    effect: 'Asks you to trust a new MCP server before its tools are used.',
  },
  'Capability manifest': {
    effect: 'The searchable tool index the agent loads from on demand (ToolSearch).',
  },
  'File leases + lease-guard': {
    effect: 'Stops two teammate agents editing the same file at once.',
  },
  TeamBrief: { effect: 'A shared status board for a team of agents.' },
  'Agent-cap posture': {
    effect: 'Caps what tools a worker-role agent may use, by risk level.',
    risk: 'Too strict and delegated agents lose tools they need.',
  },
  'Skill self-auth': {
    effect: "A running skill's declared tool allowlist merges into the session.",
    risk: 'A skill can quietly widen what runs without a prompt.',
  },
  'Model floor (never Haiku)': {
    effect: 'Any agent spawn that resolves to Haiku is upgraded to Sonnet-5.',
  },
  // feature toggles (writable)
  'relevant-recall': {
    effect: 'Surfaces only the memory notes relevant to your task, not all of them.',
    risk: 'May skip a note if it misjudges relevance.',
  },
  'mcp-hardening': {
    effect: 'Blocks higher-risk tools from MCP servers you have not trusted.',
    risk: 'Can break MCP tools you rely on, mid-session.',
  },
  'classifier-fail-closed': {
    effect: "If the safety check can't read a tool's input, it blocks not allows.",
    risk: 'Stricter — may block a legitimate tool call.',
  },
  'commit-gate': {
    effect: 'Forces commits to chain behind a passing test (`test && commit`).',
    risk: 'Blocks a bare `git commit`; engages next turn.',
  },
  'daemon-breaker-timeout': {
    effect: 'A slow background task no longer counts as a crash toward the breaker.',
    risk: 'A genuinely stuck task trips the safety brake slower.',
  },
  // danger zone
  bypass: {
    effect: 'Every tool runs with NO approval prompt.',
    risk: 'The agent can run destructive commands without asking — use briefly.',
  },
}

export type Gate = { key: string; label: string; on: boolean; flag: string; danger?: boolean }
// The hardcoded DEFAULT_GATES fallback is DELETED — its
// rows were factually wrong (MERCURY_SWARMS claimed off; agentSwarmsEnabled
// defaults ON) and one propless mount away from rendering false authority
// claims. The one live mount (/authority) passes substrateSnapshot rows.)
type Props = {
  gates: Gate[]
  features?: FeatureToggle[]
  initialBypass?: boolean
  onToggleGate?: (key: string, on: boolean) => void
  onToggleFeature?: (key: string) => boolean
  onBypassChange?: (on: boolean) => void
  onClose?: () => void
}

/** A list row that survives wrapping: a fixed prefix cell beside a flexing
 *  text cell, so continuation lines align under the row text. A single
 *  <Text> wrapped its continuation to the panel edge, losing the list
 *  indent at narrow widths. */
function HangingRow({
  prefix,
  children,
}: {
  prefix: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box>
      <Box flexShrink={0}>
        <Text>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
    </Box>
  )
}

export function MercuryPermissionsPanel({ gates, features = [], initialBypass = false, onToggleGate, onToggleFeature, onBypassChange, onClose }: Props): React.ReactNode {
  // Identity accent at render → a live /critter pick re-tints this panel.
  // (AURORA: accent stays on the cursor/selected rows; the panel border is
  // structure.)
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const [rows] = useState(gates)
  const [feats, setFeats] = useState(features)
  const [bypass, setBypass] = useState(initialBypass)
  const [i, setI] = useState(0)

  // Index layout: [0 .. gates) read-only · [gates .. gates+feats) writable · last = bypass.
  const featStart = rows.length
  const bypassIdx = rows.length + feats.length
  const N = bypassIdx + 1
  const onGate = i < featStart
  const onFeature = i >= featStart && i < bypassIdx
  const onBypass = i === bypassIdx

  // ACTION keys only past the mount buffer: this panel flips BYPASS and safety
  // toggles, so the keystroke that opened it (or its terminal repeat) must never
  // land on a row (the idle-parked-commits arm of STALE-PAINT). Doctrine per
  // useOpenEventGate.ts: esc + arrows stay immediate — only ↵/space is gated.
  const pastOpenEvent = useOpenEventGate()
  useInput((input, key) => {
    if (key.downArrow) setI(x => Math.min(N - 1, x + 1))
    else if (key.upArrow) setI(x => Math.max(0, x - 1))
    else if (key.return || input === ' ') {
      if (!pastOpenEvent()) return
      if (onFeature) {
        const f = feats[i - featStart]
        if (f) {
          const next = onToggleFeature?.(f.key) ?? !f.on
          setFeats(fs => fs.map((x, idx) => (idx === i - featStart ? { ...x, on: next } : x)))
        }
      } else if (onBypass) {
        setBypass(b => { const v = !b; onBypassChange?.(v); return v })
      }
      // gate rows are read-only — no write.
    } else if (key.escape) onClose?.()
  })

  const hint = onGate
    ? '↑↓ inspect · read-only gate · esc close'
    : onFeature
      ? '↑↓ move · ↵/space toggle · esc close'
      : '↑↓ move · ↵/space bypass · esc close'

  // Plain-language detail for whatever row the cursor is on (what it does + risk).
  const currentKey = onGate
    ? rows[i]?.key
    : onFeature
      ? feats[i - featStart]?.key
      : 'bypass'
  const detail = currentKey ? DESC[currentKey] : undefined

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1}>
      <Text><Text color={TERRA}>{CRAB}</Text><Text bold color={TERRA}> permissions · authority</Text></Text>
      <Text color={FAINT}>capability gates · read-only</Text>
      {rows.map((r, idx) => {
        const on = idx === i; const glyph = r.on ? (r.danger ? GLYPH.circledSlash : GLYPH.done) : GLYPH.pending
        return (
          <HangingRow
            key={r.key}
            prefix={
              <>
                <Text color={on ? TERRA : FAINT}>{on ? GLYPH.prompt : ' '} </Text>
                <Text color={r.on ? (r.danger ? CRIMSON : TEAL) : FAINT}>{glyph} </Text>
              </>
            }
          >
            <Text color={on ? TERRA : r.on ? IVORY : SAND}>{r.label}</Text>
            <Text color={FAINT}>   {r.on ? 'enabled' : 'disabled'} · {r.flag}</Text>
          </HangingRow>
        )
      })}
      {feats.length > 0 ? (
        <>
          <Text color={FAINT}>feature toggles · ↵ flips (session)</Text>
          {feats.map((f, idx) => {
            const cur = idx + featStart === i
            const onColor = f.caution ? SAND : TEAL
            const glyph = f.on ? GLYPH.circledBullet : GLYPH.pending
            return (
              <HangingRow
                key={f.key}
                prefix={
                  <>
                    <Text color={cur ? TERRA : FAINT}>{cur ? GLYPH.prompt : ' '} </Text>
                    <Text color={f.on ? onColor : FAINT}>{glyph} </Text>
                  </>
                }
              >
                <Text color={cur ? TERRA : f.on ? IVORY : SAND}>{f.label}</Text>
                <Text color={FAINT}>   {f.on ? 'on' : 'off'}</Text>
                {f.caution ? <Text color={SAND}> {GLYPH.warn}</Text> : null}
                <Text color={FAINT}> · {f.scope}</Text>
              </HangingRow>
            )
          })}
        </>
      ) : null}
      <Text color={FAINT}>danger zone</Text>
      <HangingRow
        prefix={<Text color={onBypass ? TERRA : FAINT}>{onBypass ? GLYPH.prompt : ' '} </Text>}
      >
        <Text bold color={bypass ? CRIMSON : FAINT}>{bypass ? '▸▸' : GLYPH.pending} sovereign mode</Text>
        <Text color={FAINT}>   {bypass ? 'ON — every tool auto-runs' : 'off · skip all approvals'}</Text>
      </HangingRow>
      {/* HB-0175: no standing restatement badge here. The CRIMSON bypass ROW above
          ('▸▸ sovereign mode … ON — every tool auto-runs') already conveys the
          danger state, the hint advertises ↵/space toggle, and the master-detail
          below states the effect/risk when the cursor rests on it — a third copy
          carried no new info. */}
      {detail ? (
        <Box flexDirection="column" marginTop={1}>
          <HangingRow prefix={<Text color={TERRA}>{'  › '}</Text>}>
            <Text color={IVORY}>{detail.effect}</Text>
          </HangingRow>
          {detail.risk ? (
            <HangingRow prefix={<Text color={SAND}>{'    '}{GLYPH.warn} </Text>}>
              <Text color={SAND}>{detail.risk}</Text>
            </HangingRow>
          ) : null}
        </Box>
      ) : null}
      <Text color={FAINT}>{hint}</Text>
    </Box>
  )
}
