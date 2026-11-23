import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import type { AgentDocument } from '../../../crew/agents/contracts.js'
import { SCOUT_TOOLS_DESCRIPTION } from '../../../tools/crewmate/scoutPolicy.js'
import { AMBER, CRIMSON, FAINT, IVORY, TEAL } from '../../theme/mercuryPalette.js'
import { SectionHeader } from '../../widgets/components.js'
import { truncateToWidth } from '../../theme/glyphs.js'
import { agentModelAvailabilityNote } from '../../../models/catalogue/agentModelPicker.js'
import {
  buildReviewFacts,
  type computeStudioValidation,
  type effectiveStudioRuntime,
  type StudioDraftBase,
} from './studioEditorModel.js'

type StudioReviewArgs = {
  doc: AgentDocument
  base: StudioDraftBase | undefined
  header: React.ReactNode
  destinationPath: string
  effective: ReturnType<typeof effectiveStudioRuntime>
  validation: ReturnType<typeof computeStudioValidation>
}

export function studioReviewView({ doc, base, header, destinationPath, effective, validation }: StudioReviewArgs): React.ReactNode {
  const { changed, diffLines } = buildReviewFacts(doc, base)
  const availability = agentModelAvailabilityNote(doc.fields.model)
  return (
    <Box flexDirection="column">
      {header}
      <SectionHeader>Review</SectionHeader>
      <Text>
        <Text color={FAINT}>{'destination  '}</Text>
        <Text color={IVORY}>{truncateToWidth(destinationPath, 62)}</Text>
      </Text>
      <Text>
        <Text color={FAINT}>{'fields       '}</Text>
        <Text color={changed.length > 0 ? IVORY : FAINT}>
          {changed.length > 0 ? changed.join(', ') : '(no field changes)'}
        </Text>
      </Text>
      <Text>
        <Text color={FAINT}>{'effective    '}</Text>
        <Text color={TEAL}>
          {`${effective.model} · ${effective.effort.supportsEffort ? `effort ${effective.effort.label}` : effective.effort.label}${effective.effort.adjustedFrom ? ` (requested ${effective.effort.adjustedFrom})` : ''}`}
        </Text>
      </Text>
      {availability !== null ? (
        <Text>
          <Text color={FAINT}>{'availability '}</Text>
          <Text color={AMBER}>{truncateToWidth(`${availability} — /logins signs in`, 62)}</Text>
        </Text>
      ) : null}
      {effective.tools ? (
        <Text>
          <Text color={FAINT}>{'tools        '}</Text>
          <Text color={effective.tools.invalidTools.length > 0 ? AMBER : IVORY}>
            {effective.tools.readOnly
              ? SCOUT_TOOLS_DESCRIPTION
              : effective.tools.hasWildcard
              ? 'all tools'
              : `${effective.tools.validTools.length} available${effective.tools.invalidTools.length > 0 ? ` · unknown: ${effective.tools.invalidTools.join(', ')}` : ''}`}
          </Text>
        </Text>
      ) : null}
      {diffLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {diffLines.map((l, i) => (
            <Text key={i} color={l.startsWith('+') ? TEAL : l.startsWith('-') ? CRIMSON : FAINT}>
              {truncateToWidth(`  ${l}`, 78)}
            </Text>
          ))}
        </Box>
      ) : null}
      {validation.errors.map((e, i) => (
        <Text key={`e${i}`} color={CRIMSON}>{`  ✗ ${truncateToWidth(e, 74)}`}</Text>
      ))}
      {validation.warnings.map((w, i) => (
        <Text key={`w${i}`} color={AMBER}>{`  ▲ ${truncateToWidth(w, 74)}`}</Text>
      ))}
      <Box marginTop={1}>
        <Text color={validation.canSave ? TEAL : FAINT}>
          {validation.canSave
            ? 's / ↵ save · v advanced · r raw · esc back'
            : 'save disabled while errors exist · v advanced · r raw · esc back'}
        </Text>
      </Box>
    </Box>
  )
}
