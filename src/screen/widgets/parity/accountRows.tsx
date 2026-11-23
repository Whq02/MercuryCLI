import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import {
  familyAbsentWords,
  scopeSlotTail,
  slotSigninState,
  type AccountSlot,
  type deriveFamilySlotGroups,
  type SlotIdentities,
} from '../../../models/roads/accountSlots.js'
import { usageCreditsLine, usageForProvider, type ProviderFamilyPresence } from '../../../models/roads/providerUsage.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from '../../theme/mercuryPalette.js'
import { padTo, truncateToWidth } from '../../theme/glyphs.js'
import { InteractiveRow } from '../InteractiveRow.js'
import type { useInteractiveList } from '../useInteractiveList.js'

export type BoardRow =
  | { type: 'slot'; slot: AccountSlot }
  | { type: 'absent'; family: ProviderFamilyPresence }

export const rowKey = (row: BoardRow): string =>
  row.type === 'slot' ? row.slot.id : `absent:${row.family.id}`

export function renderAccountRow(
  row: BoardRow,
  index: number,
  {
    sel,
    identities,
    accent,
    groups,
    rowProps,
    tailWidth,
  }: {
    sel: number
    identities: SlotIdentities
    accent: string
    groups: ReturnType<typeof deriveFamilySlotGroups>
    rowProps: ReturnType<typeof useInteractiveList<BoardRow>>['rowProps']
    tailWidth: number
  },
): React.ReactNode {
  const selected = index === sel
  let glyph: string
  let color: string
  let name: string
  let kindLabel: string
  let tail: string
  if (row.type === 'absent') {
    glyph = '⦿'
    color = AMBER
    name = row.family.id
    kindLabel = 'absent'
    tail = familyAbsentWords(row.family.id)
  } else {
    const slot = row.slot
    name = slot.name
    kindLabel = slot.kindLabel
    if (slot.scope) {
      const id = identities[slot.id]
      const state = slotSigninState(slot, identities)
      glyph = state.basis === 'excluded' ? '⊘' : state.signedIn ? '●' : '⦿'
      color = state.basis === 'excluded' ? FAINT : state.signedIn ? TEAL : AMBER
      tail = scopeSlotTail(state, id, slot)
    } else {
      glyph = slot.active ? '●' : '○'
      color = slot.active ? TEAL : slot.envPinned ? SECOND : AMBER
      const affordance =
        slot.family === 'openai'
          ? slot.kind === 'subscription'
            ? '↵ opens Logins to reconnect · ⌫ disconnects'
            : slot.envPinned
              ? "the shell's — ⌫ explains"
              : '↵ opens Logins (ChatGPT) · ⌫ clears'
          : slot.envPinned
            ? "the shell's — ⌫ explains"
            : slot.removal.route === 'moonshot-oauth'
              ? '↵ names the route · ⌫ disconnects'
              : slot.removal.route === 'zai-stored-key' ||
                  slot.removal.route === 'moonshot-stored-key' ||
                  slot.removal.route === 'deepseek-stored-key' ||
                  slot.removal.route === 'xai-stored-key' ||
                  slot.removal.route === 'meta-stored-key' ||
                  slot.removal.route === 'compat-stored-key' ||
                  slot.removal.route === 'mistral-stored-key' ||
                  slot.removal.route === 'mistral-admin-key' ||
                  slot.removal.route === 'nous-stored-key' ||
                  slot.removal.route === 'minimax-stored-key' ||
                  slot.removal.route === 'together-stored-key' ||
                  slot.removal.route === 'cohere-stored-key' ||
                  slot.removal.route === 'groq-stored-key' ||
                  slot.removal.route === 'melious-stored-key' ||
                  slot.removal.route === 'orcarouter-stored-key' ||
                  slot.removal.route === 'cerebras-stored-key' ||
                  slot.removal.route === 'fireworks-stored-key' ||
                  slot.removal.route === 'qwen-stored-key'
                ? '⌫ clears'
              : slot.removal.route === 'anthropic-managed-key'
                ? '⌫ removes'
                : '↵/⌫ name the owning route'
      tail = [
        slot.identity,
        slot.active && slot.kind !== 'oauth' ? 'active source' : '',
        slot.stateNote ?? '',
        affordance,
      ]
        .filter(Boolean)
        .join(' · ')
    }
  }
  const family = row.type === 'slot' && row.slot.active && row.slot.signedIn ? groups.find(group => group.family.id === row.slot.family)?.family.id : undefined
  const credits = row.type === 'slot' && row.slot.signedIn && row.slot.credits !== undefined
    ? usageCreditsLine(row.slot.credits)
    : family === undefined ? undefined : usageCreditsLine(usageForProvider(family).credits)
  return (
    <InteractiveRow key={rowKey(row)} {...rowProps(row, index)}>
      <Box flexDirection="column">
        <Text>
          <Text color={selected ? accent : FAINT}>{selected ? '▸ ' : '  '}</Text>
          <Text color={color}>{glyph} </Text>
          <Text color={selected ? IVORY : SECOND}>{padTo(name, 12)}</Text>
          <Text color={FAINT}>{padTo(kindLabel, 15)}</Text>
          <Text color={FAINT} wrap="truncate-end">{truncateToWidth(tail, tailWidth)}</Text>
        </Text>
        {credits !== undefined ? <Box paddingLeft={4}><Text color={FAINT}>{credits}</Text></Box> : null}
      </Box>
    </InteractiveRow>
  )
}
