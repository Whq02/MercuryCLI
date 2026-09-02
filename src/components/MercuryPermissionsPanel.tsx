import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import type { FeatureToggle } from '../utils/featureToggles.js'
import { CRAB_GLYPHS as CRAB } from './mercury-ui/assets.js';

const DESC: Record<string, { effect: string; risk?: string }> = {
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
  bypass: {
    effect: 'Every tool runs with NO approval prompt.',
    risk: 'The agent can run destructive commands without asking — use briefly.',
  },
}

export type Gate = { key: string; label: string; on: boolean; flag: string; danger?: boolean }
type Props = {
  gates: Gate[]
  features?: FeatureToggle[]
  initialBypass?: boolean
  onToggleGate?: (key: string, on: boolean) => void
  onToggleFeature?: (key: string) => boolean
  onBypassChange?: (on: boolean) => void
  onClose?: () => void
}

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
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const [rows] = useState(gates)
  const [feats, setFeats] = useState(features)
  const [bypass, setBypass] = useState(initialBypass)
  const [i, setI] = useState(0)

  const featStart = rows.length
  const bypassIdx = rows.length + feats.length
  const N = bypassIdx + 1
  const onGate = i < featStart
  const onFeature = i >= featStart && i < bypassIdx
  const onBypass = i === bypassIdx

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
    } else if (key.escape) onClose?.()
  })

  const hint = onGate
    ? '↑↓ inspect · read-only gate · esc close'
    : onFeature
      ? '↑↓ move · ↵/space toggle · esc close'
      : '↑↓ move · ↵/space bypass · esc close'

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
      {
}
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
