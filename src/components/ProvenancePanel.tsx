import * as React from 'react'
import { Box, Text } from '../ink.js'
import {
  readPromptProvenance,
  type ProvenanceSectionRecord,
} from '../utils/cockpit/promptProvenance.js'
import { FAINT, IVORY, TEAL, TERRA } from './mercuryPalette.js'
import { CommandCenter } from './mercury-ui/components.js'

// ============================================================================
//  ProvenancePanel — the /provenance view (typed
//  pass): the turn bill-of-materials. READ-ONLY: renders the typed behaviour
//  contract getSystemPrompt() ACTUALLY composed last (true capture — semantic
//  IDs, owners, provider scope, cache class, sizes, sha-8 fingerprints; never
//  content), so the operator can see exactly what the harness assembled, what
//  it costs, and what changed since the previous composition.
// ============================================================================

const tok = (chars: number) => Math.round(chars / 4)
const fmt = (n: number) => n.toLocaleString('en-US')

function Row({
  section,
  total,
}: {
  section: ProvenanceSectionRecord
  total: number
}): React.ReactNode {
  const pct = total > 0 ? Math.round((section.chars / total) * 100) : 0
  const scopeMark =
    section.scope === 'anthropic-only'
      ? 'ant'
      : section.scope === 'openai-only'
        ? 'oai'
        : ''
  const cacheMark = section.cacheClass === 'turn' ? '· uncached' : ''
  return (
    <Box>
      <Box width={30}>
        <Text color={IVORY} wrap="truncate">
          {section.name}
        </Text>
      </Box>
      <Box width={9} justifyContent="flex-end">
        <Text color={IVORY}>{fmt(section.chars)}</Text>
      </Box>
      <Box width={8} justifyContent="flex-end">
        <Text color={FAINT}>{`≈${fmt(tok(section.chars))}t`}</Text>
      </Box>
      <Box width={5} justifyContent="flex-end">
        <Text color={FAINT}>{`${pct}%`}</Text>
      </Box>
      <Box width={5} justifyContent="flex-end">
        <Text color={TERRA}>{scopeMark}</Text>
      </Box>
      <Box width={11} justifyContent="flex-end">
        <Text color={FAINT}>{section.sha8}</Text>
      </Box>
      {cacheMark ? <Text color={TERRA}> {cacheMark}</Text> : null}
    </Box>
  )
}

export function ProvenancePanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const prov = readPromptProvenance()

  if (!prov) {
    return (
      <CommandCenter
        view="provenance"
        subtitle="system-prompt bill of materials"
        onClose={onClose}
      >
        <Box flexDirection="column" paddingX={1}>
          <Text color={FAINT}>
            No composition recorded yet this session — the system prompt is
            assembled on the first turn. Run any turn, then /provenance.
          </Text>
        </Box>
      </CommandCenter>
    )
  }

  const groupsInOrder = ['static', 'boundary', 'dynamic', 'wrapper', 'mode', 'antisyc', 'reconcile', 'context', 'segment']
  const byGroup = new Map<string, ProvenanceSectionRecord[]>()
  for (const s of prov.sections) {
    const list = byGroup.get(s.group) ?? []
    list.push(s)
    byGroup.set(s.group, list)
  }
  const delta = prov.previous ? prov.totalChars - prov.previous.totalChars : null

  return (
    <CommandCenter
      view="provenance"
      subtitle={`what the harness actually assembled · recorded ${prov.recordedAt.slice(11, 19)}Z`}
      footer="shape-only capture — semantic IDs, owners, sizes, sha-8 — never content"
      onClose={onClose}
    >
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color={TEAL} bold>
            {fmt(prov.totalChars)} chars · ≈{fmt(tok(prov.totalChars))} tokens ·{' '}
            {prov.segmentCount} segments · contract {prov.digest}
          </Text>
        </Box>
        <Box>
          <Text color={FAINT}>
            openai render {fmt(prov.openaiChars)} chars
            {delta !== null
              ? ` · vs previous composition ${delta >= 0 ? '+' : ''}${fmt(delta)} chars`
              : ''}
          </Text>
        </Box>
        {groupsInOrder.map(group => {
          const sections = byGroup.get(group)
          if (!sections || sections.length === 0) return null
          const owner = sections[0]!.owner
          const uniformOwner = sections.every(s => s.owner === owner)
          return (
            <Box key={group} flexDirection="column" marginTop={1}>
              <Box>
                <Text color={TERRA} bold>
                  {group}
                </Text>
                <Text color={FAINT}>
                  {uniformOwner ? ` — ${owner}` : ' — per-section owners'}
                </Text>
              </Box>
              {sections.map((s, i) => (
                <Row key={`${s.name}-${i}`} section={s} total={prov.totalChars} />
              ))}
            </Box>
          )
        })}
        {prov.absent.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={TERRA} bold>
              absent registry sections
            </Text>
            {prov.absent.map((a, i) => (
              <Box key={`${a.name}-${i}`}>
                <Box width={30}>
                  <Text color={FAINT} wrap="truncate">
                    {a.name}
                  </Text>
                </Box>
                <Text color={FAINT}>{a.reason}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    </CommandCenter>
  )
}
