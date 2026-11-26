import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { CommandPopupLease } from '../../screen/overlays/CommandPopupSlot.js'
import { claimCommandPopup } from '../../screen/cockpit/commandPopup.js'
import { crewDoorShape } from '../../screen/fullscreen-layout/CrewViewSlot.js'
import { CommandCenter, SectionHeader } from '../../screen/widgets/components.js'
import { InteractiveRow } from '../../screen/widgets/InteractiveRow.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { saturnEmptyDetailLines, useSaturnController } from '../../screen/boot-face/BootSaturnScreen.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

function SaturnPopup({ onClose }: { onClose: (value?: string) => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const { facts, form, formPrompt, formPick, menuM, rowPropsAt } = useSaturnController({ onClose })
  const subtitle =
    formPick !== null
      ? formPick.field
      : form !== null
        ? 'schedule a birth'
        : `${facts.rows.length} schedule${facts.rows.length === 1 ? '' : 's'}${facts.heldTotal > 0 ? ` · ${facts.heldTotal} held` : ''}`
  const footer = menuM.legend.replace(/esc back$/, form === null ? 'esc close' : 'esc back')
  const emptyParagraphs =
    menuM.entries.length === 0
      ? saturnEmptyDetailLines(facts)
          .reduce<string[]>((acc, line) => {
            if (line === '') acc.push('')
            else if (acc.length === 0 || acc[acc.length - 1] === '') acc.push(line)
            else acc[acc.length - 1] = `${acc[acc.length - 1]} ${line}`
            return acc
          }, [])
          .filter(Boolean)
      : []
  const groups: Array<{ title: string; items: Array<{ index: number; entry: (typeof menuM.entries)[number] }> }> = []
  menuM.entries.forEach((entry, index) => {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.title === entry.groupTitle) last.items.push({ index, entry })
    else groups.push({ title: entry.groupTitle, items: [{ index, entry }] })
  })
  return (
    <CommandCenter elevated view="saturn" subtitle={subtitle} footer={footer} bodyOwnsPageKeys onClose={() => onClose()} captureInput={false}>
      <Box flexDirection="column" tabIndex={-1}>
        {menuM.entries.length === 0 ? (
          <Box flexDirection="column" gap={1}>
            {emptyParagraphs.map((paragraph, i) => (
              <Text key={i} color={i === 0 ? tokens.textSecondary : tokens.textMuted} wrap="wrap">{paragraph}</Text>
            ))}
          </Box>
        ) : (
          groups.map((group, gi) => (
            <Box key={`${group.title}-${gi}`} flexDirection="column">
              <SectionHeader marginTop={gi === 0 ? 0 : 1} count={group.items.length}>{group.title}</SectionHeader>
              {group.items.map(({ index, entry }) => {
                const isSelected = index === menuM.selIdx
                const target = rowPropsAt(index)
                const content = (
                  <>
                    <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>{isSelected ? `${figures.pointer} ` : '  '}</Text>
                    <Box flexGrow={1} minWidth={0}>
                      <Text bold={isSelected} color={isSelected ? tokens.textPrimary : tokens.textSecondary} wrap="truncate-end">{entry.label}</Text>
                    </Box>
                    {entry.valueLabel !== '' ? (
                      <Box flexShrink={0} marginLeft={2}>
                        <Text color={entry.valueIsDefault ? tokens.textMuted : tokens.warning}>{entry.valueLabel}</Text>
                      </Box>
                    ) : null}
                  </>
                )
                return target !== null ? (
                  <InteractiveRow key={target.props.id} {...target.props} flexDirection="row" flexGrow={1}>
                    {content}
                  </InteractiveRow>
                ) : (
                  <Box key={`saturn-${index}`} flexDirection="row" flexGrow={1} minWidth={0}>
                    {content}
                  </Box>
                )
              })}
            </Box>
          ))
        )}
        {menuM.statusRight !== '' ? (
          <Box marginTop={1}>
            <Text color={formPrompt !== null ? tokens.textPrimary : tokens.textMuted} wrap="wrap">{menuM.statusRight}</Text>
          </Box>
        ) : null}
      </Box>
    </CommandCenter>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  const token = claimCommandPopup({ ...crewDoorShape('saturn'), compact: 'pane' })
  return (
    <CommandPopupLease token={token}>
      <SaturnPopup onClose={(value?: string) => onDone(value, value === undefined ? { display: 'skip' } : undefined)} />
    </CommandPopupLease>
  )
}
