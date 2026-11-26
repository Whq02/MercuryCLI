import * as React from 'react'
import { Box, Text, useInput } from '../../screen/themedRenderer.js'
import { SQUARE_DOCK_ART_LINES, critterDefForKey } from '../../screen/cockpit/critterData.js'
import { FAINT, TEAL } from '../../screen/theme/mercuryPalette.js'
import { CommandCenter, SectionHeader } from '../../screen/widgets/components.js'
import { AnimatedCritterArt } from '../../screen/widgets/AnimatedCritterArt.js'
import { InteractiveRow } from '../../screen/widgets/InteractiveRow.js'
import { GLYPH, padTo } from '../../screen/theme/glyphs.js'
import {
  ALL_CRITTERS,
  getSessionAccent,
  setSessionCritter,
  persistSessionCritter,
} from '../../screen/widgets/sessionAccent.js'
import { useInteractiveList } from '../../screen/widgets/useInteractiveList.js'

const NAME_CELL_WIDTH = 16

export function CritterSelect({ onClose }: { onClose: () => void }): React.ReactNode {
  const activeIndex = Math.max(
    0,
    ALL_CRITTERS.findIndex(c => c.key === getSessionAccent().key),
  )
  const dockDefs = React.useMemo(() => ALL_CRITTERS.map(c => critterDefForKey(c.key)), [])

  const nav = useInteractiveList({
    rows: ALL_CRITTERS,
    rowId: c => c.key,
    idNamespace: 'critter',
    initialId: ALL_CRITTERS[activeIndex]?.key,
    orientation: 'vertical',
    onClose,
    actions: [
      {
        key: 'return',
        run: picked => {
          if (picked) {
            setSessionCritter(picked.key)
            persistSessionCritter(picked.key)
          }
          return `switched to ${picked?.name ?? 'crab'} — yours across relaunches (MERCURY_CRITTER overrides)`
        },
        hint: 'pick',
      },
      {
        key: 't',
        run: picked => {
          if (picked) setSessionCritter(picked.key)
          return `trying ${picked?.name ?? 'crab'} — this session only (↵ to keep it)`
        },
        hint: 'try once',
      },
    ],
  })

  useInput((input, key) => {
    if (key.leftArrow) {
      nav.moveTo(Math.max(0, nav.selectedIndex - 1))
      return
    }
    if (key.rightArrow) {
      nav.moveTo(Math.min(ALL_CRITTERS.length - 1, nav.selectedIndex + 1))
      return
    }
    const n = Number(input)
    if (Number.isInteger(n) && n >= 1 && n <= ALL_CRITTERS.length) nav.moveTo(n - 1)
  })

  const sel = nav.selectedIndex
  const liveActive = getSessionAccent().key

  return (
    <CommandCenter
      view="critter"
      onClose={onClose}
      captureInput={false}
      footer={(nav.hints ? nav.hints + ' · ' : '') + `${nav.motionHint} / click move`}
    >
      <SectionHeader>Session theme</SectionHeader>
      <Box flexDirection="row">
        <Box flexDirection="column" width={27} flexShrink={0}>
          {ALL_CRITTERS.map((c, i) => {
            const on = i === sel
            const active = c.key === liveActive
            return (
              <InteractiveRow key={c.key} {...nav.rowProps(c, i)} height={1}>
                <Text wrap="truncate-end">
                  <Text color={on ? c.accent : FAINT}>{on ? `${GLYPH.prompt} ` : '  '}</Text>
                  <Text bold={on} color={c.accent}>{padTo(`[${i + 1}] ${c.name}`, NAME_CELL_WIDTH)}</Text>
                  {active ? <Text color={TEAL}>current</Text> : null}
                </Text>
              </InteractiveRow>
            )
          })}
        </Box>
        <Box marginLeft={4} height={SQUARE_DOCK_ART_LINES} flexDirection="column" justifyContent="flex-end" flexShrink={0}>
          <AnimatedCritterArt def={dockDefs[sel]!} square specimen />
        </Box>
      </Box>
      {nav.note ? (
        <Box marginTop={1}>
          <Text color={TEAL}>{nav.note}</Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
