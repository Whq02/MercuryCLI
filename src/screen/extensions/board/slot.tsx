import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { saveOptionValues, type OptionValue } from '../../../integrations/extensions/options.js'
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { bytesWord } from '../ExtensionView.js'
import type { boardActions, installCardActions, rowSourceActions } from './actions.js'
import type { Slot } from './shapes.js'

type SlotArgs = Pick<ReturnType<typeof boardActions>, 'refresh'> &
  Pick<ReturnType<typeof installCardActions>, 'doUninstallNow'> &
  Pick<ReturnType<typeof rowSourceActions>, 'runAdd' | 'doRemoveSource' | 'runFetchProposal'> & {
    slot: Slot | null
    setSlot: React.Dispatch<React.SetStateAction<Slot | null>>
    setFilterText: React.Dispatch<React.SetStateAction<string>>
    setNote: React.Dispatch<React.SetStateAction<string | null>>
    note: string | null
    cols: number
    tokens: ReturnType<typeof useMercuryTokens>
  }

export function slotParts({ slot, setSlot, setFilterText, setNote, note, cols, tokens, runAdd, doUninstallNow, doRemoveSource, runFetchProposal, refresh }: SlotArgs) {
  const onSlotInput = (input: string, key: Record<string, boolean>): void => {
    if (slot === null || key['ctrl'] || key['meta'] || key['super']) return
    const typed = input && !key['tab'] && !key['return'] ? input : ''
    switch (slot.mode) {
      case 'add': {
        if (slot.busy) return
        if (key['return']) {
          void runAdd(slot.text)
          return
        }
        if (key['backspace'] || key['delete']) setSlot({ ...slot, text: slot.text.slice(0, -1), error: null })
        else if (typed) setSlot({ ...slot, text: slot.text + typed, error: null })
        return
      }
      case 'filter': {
        if (key['return']) {
          setSlot(null)
          return
        }
        const next = key['backspace'] || key['delete'] ? slot.text.slice(0, -1) : typed ? slot.text + typed : slot.text
        setSlot({ ...slot, text: next })
        setFilterText(next)
        return
      }
      case 'uninstall': {
        if (input === 'y') void doUninstallNow(slot.id, false)
        else if (input === 'k' && slot.dataBytes > 0 && !slot.inPlace) void doUninstallNow(slot.id, true)
        else if (key['return'] && (slot.inPlace || slot.dataBytes === 0)) void doUninstallNow(slot.id, false)
        return
      }
      case 'remove-source': {
        if (key['return']) void doRemoveSource(slot.label, false)
        else if (input === 'y' && slot.installedIds.length > 0) void doRemoveSource(slot.label, true)
        return
      }
      case 'fetch': {
        if (key['return']) void runFetchProposal(slot)
        return
      }
      case 'option': {
        if (key['return']) {
          const keyName = slot.keys[slot.index]!
          const declared = slot.schema[keyName]
          const value: OptionValue =
            declared?.type === 'number' ? Number(slot.text) : declared?.type === 'boolean' ? slot.text.trim() === 'true' : slot.text
          const out = saveOptionValues(slot.id, slot.schema, { [keyName]: value })
          if (!out.ok) {
            setNote(out.error)
            setSlot(null)
            return
          }
          const nextIndex = slot.index + 1
          if (nextIndex < slot.keys.length) setSlot({ ...slot, index: nextIndex, text: '' })
          else {
            setSlot(null)
            setNote('options saved')
            refresh()
          }
          return
        }
        if (key['backspace'] || key['delete']) setSlot({ ...slot, text: slot.text.slice(0, -1) })
        else if (typed) setSlot({ ...slot, text: slot.text + typed })
        return
      }
      default:
        return
    }
  }

  const onSlotEscape = (): void => {
    if (slot === null) return
    if (slot.mode === 'add' && slot.busy) return
    if (slot.mode === 'filter' && slot.text !== '') {
      setSlot({ ...slot, text: '' })
      setFilterText('')
      return
    }
    setSlot(null)
  }

  const confirmFace = (parts: [string, string]): { node: React.ReactNode; rows: number } => {
    const one = `${parts[0]} · ${parts[1]}`
    if (one.length <= Math.max(20, cols - 6)) {
      return {
        rows: 1,
        node: (
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {one}
          </Text>
        ),
      }
    }
    return {
      rows: 2,
      node: (
        <Box flexDirection="column">
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {parts[0]}
          </Text>
          <Text color={tokens.textSecondary} wrap="truncate-end">
            {parts[1]}
          </Text>
        </Box>
      ),
    }
  }
  const slotNode = ((): { node: React.ReactNode; rows: number } | null => {
    if (slot !== null) {
      switch (slot.mode) {
        case 'add': {
          const line = slot.busy ?? slot.error ?? 'a git URL, a folder or an archive · ↵ adds · esc cancels'
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={slot.error ? tokens.failure : tokens.textMuted} wrap="truncate-end">
                  {line}
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>add › </Text>
                  <Text color={tokens.textPrimary}>{slot.text}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        }
        case 'filter':
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={tokens.textMuted} wrap="truncate-end">
                  typing narrows both sections · esc clears, then closes
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>filter › </Text>
                  <Text color={tokens.textPrimary}>{slot.text}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        case 'uninstall':
          return confirmFace(
            slot.inPlace
              ? [`forget ${slot.name}? the folder stays in the repo`, '↵ forget · esc cancel']
              : slot.dataBytes > 0
                ? [`uninstall ${slot.name} ${slot.version} (${slot.label}) · data ${bytesWord(slot.dataBytes)}`, 'y delete data · k keep data · esc cancel']
                : [`uninstall ${slot.name} ${slot.version} (${slot.label})`, '↵ uninstall · esc cancel'],
          )
        case 'remove-source': {
          const names = slot.installedIds.map(id => id.split('@')[0])
          const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '')
          return confirmFace(
            slot.installedIds.length > 0
              ? [`remove ${slot.label}? · ${slot.installedIds.length} installed from it: ${shown}`, '↵ remove the source only · y also uninstall them · esc cancel']
              : [`remove ${slot.label}?`, '↵ remove · esc cancel'],
          )
        }
        case 'fetch':
          return confirmFace([`fetch ${slot.name} from ${slot.url} to inspect?`, '↵ fetch · esc not now'])
        case 'option': {
          const keyName = slot.keys[slot.index]!
          const declared = slot.schema[keyName]
          const masked = declared?.sensitive ? '•'.repeat(slot.text.length) : slot.text
          return {
            rows: 2,
            node: (
              <Box flexDirection="column">
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {`option ${slot.index + 1}/${slot.keys.length} · ${keyName}${declared?.sensitive ? ' (sensitive)' : ''}${declared?.required ? ' · required' : ''}${declared?.description ? ` · ${declared.description}` : ''} · ↵ saves · esc skips`}
                </Text>
                <Text wrap="truncate-end">
                  <Text color={tokens.accent}>{keyName} › </Text>
                  <Text color={tokens.textPrimary}>{masked}</Text>
                  <Text color={tokens.accent}>▌</Text>
                </Text>
              </Box>
            ),
          }
        }
        default:
          return null
      }
    }
    if (note !== null) {
      const budget = Math.max(20, cols - 6)
      const noteRows: string[] = []
      let current = ''
      for (const piece of note.split(' — ')) {
        const candidate = current === '' ? piece : `${current} — ${piece}`
        if (candidate.length <= budget || current === '') current = candidate
        else {
          noteRows.push(current)
          current = piece
        }
      }
      noteRows.push(current)
      const shown = noteRows.slice(0, 3)
      return {
        rows: shown.length,
        node: (
          <Box flexDirection="column">
            {shown.map((line, i) => (
              <Text key={i} color={tokens.textMuted} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ),
      }
    }
    return null
  })()
  return { onSlotInput, onSlotEscape, slotNode }
}
