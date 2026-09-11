import figures from 'figures'
import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { SampleRowV1 } from '../../services/engine-connector/types.js'
import { openSampleUrl } from '../../services/samples/open.js'
import { useNowTick } from '../mercury-ui/components.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { computeSessionWindow } from '../mercury-ui/screens/SessionManagerView.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useFocusedWorkRoster } from '../tasks/useFocusedWork.js'
import { SAMPLES_EMPTY_LINE, SAMPLES_LIST_HINT, SAMPLES_LIST_WINDOW, sampleListRow, samplesListTitle } from './samplesListText.js'

export function SamplesListView({ onClose }: { onClose: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  useNowTick(15_000)
  const now = Date.now()
  const samples: readonly SampleRowV1[] = useFocusedWorkRoster().samples ?? []
  const selectedIdRef = useRef<string | null>(null)
  const [cursor, setCursor] = useState(0)
  let selectedIndex = samples.findIndex(sample => sample.id === selectedIdRef.current)
  if (selectedIndex < 0) selectedIndex = Math.max(0, Math.min(cursor, samples.length - 1))
  selectedIdRef.current = samples[selectedIndex]?.id ?? null
  const selected = samples[selectedIndex]
  const move = (delta: number): void => {
    if (samples.length === 0) return
    const next = Math.max(0, Math.min(samples.length - 1, selectedIndex + delta))
    selectedIdRef.current = samples[next]?.id ?? null
    setCursor(next)
  }
  const open = (sample: SampleRowV1 | undefined): void => {
    if (sample?.url !== undefined) void openSampleUrl(sample.url)
  }
  useKeybindings(
    {
      'confirm:no': () => {
        onClose()
      },
      'confirm:previous': () => {
        move(-1)
      },
      'confirm:next': () => {
        move(1)
      },
      'confirm:yes': () => {
        open(selected)
      },
    },
    { context: 'Confirmation', isActive: true },
  )
  if (samples.length === 0) {
    return <Text color={tokens.textMuted}>{SAMPLES_EMPTY_LINE}</Text>
  }
  const title = samplesListTitle(samples.length)
  const { start, end } = computeSessionWindow(selectedIndex, samples.length, SAMPLES_LIST_WINDOW)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold color={tokens.textPrimary}>{title}</Text>
        <Box flexGrow={1} />
        <Text color={tokens.textMuted}>{SAMPLES_LIST_HINT}</Text>
      </Box>
      {start > 0 ? <Text dimColor>↑ {start} more above</Text> : null}
      {samples.slice(start, end).map((sample, i) => {
        const index = start + i
        const isSelected = index === selectedIndex
        const row = sampleListRow(sample, now)
        return (
          <InteractiveRow
            key={sample.id}
            id={`samples:row:${sample.id}`}
            selected={isSelected}
            unavailable={sample.url === undefined}
            onSelect={() => {
              selectedIdRef.current = sample.id
              setCursor(index)
            }}
            onActivate={() => open(sample)}
          >
            {hover => (
              <Text wrap="truncate-end">
                <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>
                  {isSelected ? `${figures.pointer} ` : '  '}
                </Text>
                <Text color={sample.state === 'approved' ? tokens.success : sample.state === 'changes-needed' ? tokens.warning : tokens.textMuted}>
                  {`${sample.glyph} `}
                </Text>
                <Text color={isSelected || hover ? tokens.textPrimary : tokens.textSecondary}>{row}</Text>
              </Text>
            )}
          </InteractiveRow>
        )
      })}
      {end < samples.length ? <Text dimColor>↓ {samples.length - end} more</Text> : null}
    </Box>
  )
}
