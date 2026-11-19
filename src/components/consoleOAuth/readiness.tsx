import React, { useEffect } from 'react'
import { Box, Text } from '../../ink.js'
import wrapText from '../../ink/wrap-text.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import { resolveProviderUsability, type ProviderId } from '../../services/providers/providerUsability.js'

export const MORE_BELOW_ROW = (hidden: number): string => `…and ${hidden} more below`

export const READINESS_ROWS: ReadonlyArray<{ id: ProviderId; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'moonshot', label: 'Kimi (Moonshot)' },
  { id: 'zai', label: 'GLM (Z.AI)' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xai', label: 'xAI' },
  { id: 'meta', label: 'Meta' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'zen', label: 'OpenCode Zen' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'together', label: 'Together AI' },
  { id: 'cohere', label: 'Cohere' },
  { id: 'groq', label: 'Groq' },
  { id: 'melious', label: 'Melious AI' },
  { id: 'orcarouter', label: 'OrcaRouter' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'local', label: 'Local servers' },
  { id: 'openai-compat', label: 'OpenAI-compatible' },
  { id: 'nous', label: 'Nous Portal' },
]

export const READINESS_LABEL_WIDTH = 21

function readinessStatusOf(lane: { usable: boolean; credential?: string | null; limit?: string | null; blockers: readonly string[] }): string {
  return lane.usable
    ? `ready · ${lane.credential}${lane.limit === 'rejected' ? ' · window reached' : ''}`
    : (lane.blockers[0] ?? 'not ready')
}

export function readinessBlockPlan(
  map: Record<ProviderId, { usable: boolean; credential?: string | null; limit?: string | null; blockers: readonly string[] }>,
  statusWidth: number | null,
): { rows: number; lines: number[] } {
  const lines = READINESS_ROWS.map(({ id }) => (statusWidth === null ? 1 : wrapText(readinessStatusOf(map[id]), Math.max(1, statusWidth), 'wrap').split('\n').length))
  return { rows: 1 + lines.reduce((sum, n) => sum + n, 0), lines }
}

function readinessFamiliesShown(plan: { rows: number; lines: number[] }, rows: number): number {
  if (rows >= plan.rows) return plan.lines.length
  let used = 2
  let shown = 0
  for (const n of plan.lines) {
    if (used + n > rows) break
    used += n
    shown++
  }
  return shown
}

export function ProviderReadinessBlock({ rows, statusWidth }: { rows: number; statusWidth: number | null }): React.ReactNode {
  const tokens = useMercuryTokens()
  useCatalogueEpoch()
  useEffect(() => {
    resolveProviderUsability(undefined, { fetchCatalogues: true })
  }, [])
  const map = resolveProviderUsability()
  const plan = readinessBlockPlan(map, statusWidth)
  const whole = rows >= plan.rows
  const shown = READINESS_ROWS.slice(0, readinessFamiliesShown(plan, rows))
  return (
    <Box flexDirection="column">
      <Text dimColor bold>
        Provider readiness
      </Text>
      {shown.map(({ id, label }) => {
        const lane = map[id]
        const status = readinessStatusOf(lane)
        return (
          <Box key={id}>
            <Box width={READINESS_LABEL_WIDTH} flexShrink={0}>
              <Text dimColor>
                {'  '}
                {label}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={lane.usable ? tokens.success : undefined} dimColor={!lane.usable}>
                {status}
              </Text>
            </Box>
          </Box>
        )
      })}
      {whole ? null : <Text dimColor>{MORE_BELOW_ROW(READINESS_ROWS.length - shown.length)}</Text>}
    </Box>
  )
}
