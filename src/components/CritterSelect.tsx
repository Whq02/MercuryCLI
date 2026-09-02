import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { claimHover, releaseHover, useHoverOwner } from './mercury-ui/useHoverOwned.js'
import { FLAT_ART_LINES, HERO_ART_COLS, HERO_ART_LINES, critterDefForKey } from '../utils/cockpit/critterData.js'
import { companionEngineSnapshot } from '../utils/cockpit/companionEngine.js'
import { companionQuietPreference, critterProfile, setCompanionQuiet } from '../utils/cockpit/critterProfile.js'
import { DUNE, FAINT, TEAL } from './mercuryPalette.js'
import { CommandCenter, SectionHeader } from './mercury-ui/components.js'
import { AnimatedCritterArt } from './mercury-ui/AnimatedCritterArt.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import {
  ALL_CRITTERS,
  getSessionAccent,
  setSessionCritter,
  persistSessionCritter,
} from './mercury-ui/sessionAccent.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'


export function CritterSelect({ onClose }: { onClose: () => void }): React.ReactNode {
  const activeIndex = Math.max(
    0,
    ALL_CRITTERS.findIndex(c => c.key === getSessionAccent().key),
  )
  const paneCols = useTerminalSize().columns
  const heroCards = paneCols >= 64

  const nav = useInteractiveList({
    rows: ALL_CRITTERS,
    rowId: c => c.key,
    idNamespace: 'critter',
    initialId: ALL_CRITTERS[activeIndex]?.key,
    orientation: heroCards ? { grid: { columns: 2 } } : 'horizontal',
    onClose,
    actions: [
      {
        key: 'return',
        run: picked => {
          if (picked) {
            setSessionCritter(picked.key)
            persistSessionCritter(picked.key)
          }
          return `switched to ${picked?.name ?? 'crab'} — yours across relaunches (env pin still wins)`
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
      {
        key: 'm',
        run: () => {
          const quiet = setCompanionQuiet(!companionQuietPreference())
          return quiet ? 'quiet mode ON — poses stay, speech off' : 'quiet mode OFF — the companion may speak again'
        },
        hint: 'quiet',
      },
    ],
  })

  useInput((input, _key) => {
    const n = Number(input)
    if (Number.isInteger(n) && n >= 1 && n <= ALL_CRITTERS.length) nav.moveTo(n - 1)
  })

  const sel = nav.selectedIndex
  const liveActive = getSessionAccent().key
  const hoverBase = React.useId()
  const hoverOwner = useHoverOwner()
  const hovered =
    hoverOwner != null && hoverOwner.startsWith(`${hoverBase}:`)
      ? Number(hoverOwner.slice(hoverBase.length + 1))
      : -1

  return (
    <CommandCenter
      view="critter"
      onClose={onClose}
      captureInput={false}
      footer={(nav.hints ? nav.hints + ' · ' : '') + `${nav.motionHint} / click move`}
    >
      <SectionHeader>Session theme</SectionHeader>
      <Text color={FAINT}>
        pick a critter — it themes the whole harness (frame · deck · headers) · the status spine stays fixed
      </Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1} width={heroCards ? 60 : undefined}>
        {ALL_CRITTERS.map((c, i) => {
          const on = i === sel
          const active = c.key === liveActive
          const def = critterDefForKey(c.key)
          return (
            <Box
              key={c.key}
              borderStyle="round"
              borderColor={on || hovered === i ? c.accent : DUNE}
              marginRight={1}
              marginBottom={1}
              flexDirection="column"
              alignItems="center"
              width={heroCards ? HERO_ART_COLS + 4 : undefined}
              paddingX={heroCards ? 1 : 0}
              onClick={() => nav.moveTo(i)}
              onMouseEnter={() => claimHover(`${hoverBase}:${i}`)}
              onMouseLeave={() => releaseHover(`${hoverBase}:${i}`)}
            >
              {
}
              {
}
              <Box
                height={heroCards ? HERO_ART_LINES : FLAT_ART_LINES}
                flexDirection="column"
                justifyContent="flex-end"
              >
                <AnimatedCritterArt def={def} hero={heroCards} specimen />
              </Box>
              <Box marginTop={heroCards ? 0 : 1}>
                <Text bold color={c.accent}>
                  [{i + 1}] {c.name}
                </Text>
              </Box>
              <Box onClick={(e) => { e.stopImmediatePropagation(); nav.activate(i) }}>
                <Text color={on ? c.accent : FAINT}>{GLYPH.prompt} launch </Text>
                {active ? <Text color={TEAL}>{GLYPH.done} ready</Text> : <Text color={FAINT}>{GLYPH.pending}</Text>}
              </Box>
            </Box>
          )
        })}
      </Box>
      {nav.note ? (
        <Box marginTop={1}>
          <Text color={TEAL}>{nav.note}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            ↵ / click launch switches live (morphs + recolors); the status spine (teal·amber·crimson) is fixed in every theme
          </Text>
        </Box>
      )}
      {(() => {
        const focused = ALL_CRITTERS[sel]
        if (!focused) return null
        const profile = critterProfile()
        const snap = companionEngineSnapshot()
        const reason: Record<string, string> = {
          working: 'a turn is running',
          thinking: 'streaming a response',
          focused: 'deep in a long turn',
          blocked: 'waiting on you',
          done: 'just settled a turn',
          sad: 'the last turn failed',
          sleeping: 'long idle',
          idle: 'nothing in flight',
        }
        const quiet = companionQuietPreference()
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={focused.accent} bold>{focused.name}</Text>
            </Text>
            <Text color={FAINT}>
              mood {snap.mood} · {reason[snap.mood] ?? snap.mood}
              {' · '}settles {profile.milestones.settles}
              {profile.milestones.recoveries > 0 ? ` · recoveries ${profile.milestones.recoveries}` : ''}
              {profile.recoveredAt ? ' · profile recovered' : ''}
              {' · '}{quiet ? 'quiet' : 'speaking'}
            </Text>
          </Box>
        )
      })()}
    </CommandCenter>
  )
}
