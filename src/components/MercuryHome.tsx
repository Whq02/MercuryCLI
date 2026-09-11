import { pathTailLabel } from '../utils/pathLabel.js'
import * as React from 'react'
import { useContext, useEffect, useId, useMemo, useState } from 'react'
import { claimHover, releaseHover, useHoverOwned } from './mercury-ui/useHoverOwned.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { Box, Text } from '../ink.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useCwdState } from '../hooks/useCwdState.js'
import { findGitRoot } from '../utils/git.js'
import { isDeckPaneActive } from '../utils/fullscreen.js'
import {
  daemonSnapshot,
  fleetGauge,
  gitSnapshot,
  substrateSnapshot,
  traceSnapshot,
  type FleetData,
  type GitData,
  type Snapshot,
  type TraceData,
} from '../utils/cockpit/index.js'
import { HERO_ART_COLS, HERO_ART_LINES, SQUARE_ART_LINES, critterDefForKey, decideCritterForm, type CritterForm } from '../utils/cockpit/critterData.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { BigWordmark, Sigil, Wordmark, wordmarkForm } from './mercury-ui/assets.js'
import { AnimatedCritterArt, BreathingDot } from './mercury-ui/AnimatedCritterArt.js'
import { HeroCompanionBubble, MiniCritter } from './mercury-ui/MiniCritter.js'
import { useCompanionEnabled } from './mercury-ui/useCompanion.js'
import { cycleSessionCritter, getSessionAccent, useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH, branchChip } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'


const HERO_MIN_ROWS = 30

export function berthCritterForm(columns: number, rows: number): CritterForm {
  const rawDef = critterDefForKey(getSessionAccent().key)
  return decideCritterForm({ columns, rows }, !!rawDef.heroArt?.length)
}

export function berthCritterCols(columns: number, rows: number): number {
  const form = berthCritterForm(columns, rows)
  return form === 'hero' || form === 'premium-compact' ? HERO_ART_COLS : 13
}

export function PinnedCritterBerth(): React.ReactNode {
  const tok = useMercuryTokens()
  const sa = useSessionAccent()
  const { columns, rows } = useTerminalSize()
  const rawDef = critterDefForKey(sa.key)
  const def = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep }),
    [rawDef, sa.accent, sa.accentDeep],
  )
  const hoverDef = React.useMemo(
    () => ({ ...def, hue: tok.accentSoft }),
    [def, tok.accentSoft],
  )
  const form = decideCritterForm({ columns, rows }, !!rawDef.heroArt?.length)
  const heroFits = form === 'hero' || form === 'premium-compact'
  return (
    <InteractiveRow
      id="berth:critter"
      directActivate
      onActivate={cycleSessionCritter}
      flexDirection="column"
      flexShrink={0}
    >
      {hover => (
        <Box flexDirection="column" flexShrink={0} justifyContent="center">
          {
}
          <Box
            height={heroFits ? HERO_ART_LINES : SQUARE_ART_LINES}
            flexDirection="column"
            justifyContent="flex-end"
          >
            <AnimatedCritterArt def={hover ? hoverDef : def} hero={heroFits} square={!heroFits} />
          </Box>
        </Box>
      )}
    </InteractiveRow>
  )
}

export function MercuryHero(): React.ReactNode {
  const { isCompact } = useLayoutChrome()
  return isCompact ? null : <MercuryHeroBody />
}

function MercuryHeroBody(): React.ReactNode {
  const tok = useMercuryTokens()
  const sa = useSessionAccent()
  const { columns, rows } = useTerminalSize()
  const heroHoverId = useId()
  const heroHover = useHoverOwned(heroHoverId)
  const companionOn = useCompanionEnabled()
  const rawDef = critterDefForKey(sa.key)
  const heroDef = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep }),
    [rawDef, sa.accent, sa.accentDeep],
  )
  if (rows < HERO_MIN_ROWS || columns < HERO_ART_COLS + 4) {
    if (companionOn && !isDeckPaneActive() && rows >= 10 && columns >= 40) {
      return (
        <Box paddingX={1} marginTop={1} flexShrink={0} justifyContent="center">
          <MiniCritter cols={columns} />
        </Box>
      )
    }
    return null
  }
  const accent = sa.accent
  const heroCols = HERO_ART_COLS
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
      {
}
      <Box flexDirection="row" alignItems="flex-end">
        <Box
          flexDirection="column"
          paddingX={2}
          paddingBottom={1}
          width={heroCols + 4}
          alignItems="center"
          flexShrink={0}
          onMouseEnter={() => claimHover(heroHoverId)}
          onMouseLeave={() => releaseHover(heroHoverId)}
          onClick={cycleSessionCritter}
        >
          {
}
          <Box height={HERO_ART_LINES} flexDirection="column" justifyContent="flex-end">
            <AnimatedCritterArt def={heroDef} hero={true} />
          </Box>
        </Box>
        {
}
        {companionOn && columns >= HERO_ART_COLS + 44 && !isDeckPaneActive() ? (
          <Box
            height={HERO_ART_LINES}
            flexDirection="column"
            justifyContent="center"
            flexShrink={0}
            paddingBottom={1}
          >
            <HeroCompanionBubble />
          </Box>
        ) : null}
      </Box>
      {
}
      {
}
      {heroHover ? (
        <Text>
          <Text color={sa.accentDeep}>{' ' + GLYPH.mission + '─'}</Text>
          <Text color={tok.textMuted}>{' click ⇒ next critter '}</Text>
          <Text color={sa.accentDeep}>{'─'.repeat(Math.max(0, heroCols - 21)) + GLYPH.mission}</Text>
        </Text>
      ) : (
        <Text color={sa.accentDeep}>
          {' ' + GLYPH.mission + '─'.repeat(heroCols + 2) + GLYPH.mission}
        </Text>
      )}
    </Box>
  )
}

export function MercuryBrandRow(): React.ReactNode {
  const tok = useMercuryTokens()
  const { rows, columns } = useTerminalSize()
  const banner = wordmarkForm(columns, rows) === 'banner'
  return (
    <Box paddingX={1} marginTop={1} flexShrink={0}>
      {banner ? (
        <BigWordmark />
      ) : (
        <Text>
          <Sigil size="inline" />
          <Text> </Text>
          <Wordmark />
        </Text>
      )}
    </Box>
  )
}

export function MercuryHome(): React.ReactNode {
  const { isCompact } = useLayoutChrome()
  return isCompact ? null : <MercuryHomeBody />
}

function MercuryHomeBody(): React.ReactNode {
  const tok = useMercuryTokens()
  const model = useDisplayedSessionModel().label
  const cwd = useCwdState()
  const dir = pathTailLabel(cwd)

  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  const [fleet, setFleet] = useState<Snapshot<{ data: FleetData }> | null>(null)
  const [trace, setTrace] = useState<Snapshot<{ data: TraceData }> | null>(null)
  const [projectScopeEmpty, setProjectScopeEmpty] = useState(false)
  const isProjectCwd = useMemo((): boolean => {
    try {
      return findGitRoot(cwd) !== null
    } catch {
      return false
    }
  }, [cwd])
  useEffect(() => {
    let alive = true
    gitSnapshot().then(s => alive && setGit(s))
    fleetGauge().then(s => alive && setFleet(s))
    traceSnapshot().then(s => alive && setTrace(s))
    void import('../services/instructions/engine.js')
      .then(engine => engine.getInstructionFiles())
      .then(files => {
        if (!alive) return
        setProjectScopeEmpty(
          !files.some(f => f.type === 'Project' || f.type === 'Local'),
        )
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [cwd])

  const substrate = substrateSnapshot()
  const daemon = daemonSnapshot()
  const helmHome = useContext(CockpitActiveContext)
  const deckPresent = isDeckPaneActive() && !helmHome

  const sa = useSessionAccent()
  const accent = sa.accent
  const { rows: termRows, columns: termCols } = useTerminalSize()
  const bigHero = wordmarkForm(termCols, termRows) === 'banner'
  const critterLabel = sa.name.charAt(0).toUpperCase() + sa.name.slice(1)
  const rowClick = (key: string, command: string): { id: string; directActivate: true; onActivate: () => void } => ({
    id: `home:row:${key}`,
    directActivate: true,
    onActivate: () => requestCommandDispatch(command),
  })

  const branch = git?.data.git?.branchName
  const gitState = git == null ? '…' : git.data.git == null ? 'no git' : git.data.git.isClean ? 'clean' : 'uncommitted'

  const agents = fleet?.state === 'live' ? fleet.data.health.length : 0
  const traceCount = trace?.state === 'live' ? trace.data.total : 0

  return (
    <Box flexDirection="column" paddingX={1}>
      {
}

      {
}
      <Box flexDirection="column" marginTop={1}>
        {bigHero ? (
          <BigWordmark />
        ) : (
          <Box>
            <Sigil size="inline" />
            <Text> </Text>
            <Wordmark />
          </Box>
        )}
        {
}
        <InteractiveRow {...rowClick('standing-by', '/deck')}>
          <BreathingDot />
          <Text color={tok.success}> ready</Text>
          <Text color={tok.textMuted}>
            {' · type a prompt, or '}
            <Text color={tok.info}>/</Text>
            {' for commands'}
          </Text>
        </InteractiveRow>
      </Box>

      {
}
      <Box marginTop={1} flexDirection="column">
        {!deckPresent ? (
          <InteractiveRow {...rowClick('model', '/model')}>
            <Text>
              <Text color={tok.textMuted}>{'  model   '}</Text>
              <Text color={tok.textPrimary}>{model}</Text>
            </Text>
          </InteractiveRow>
        ) : null}
        <InteractiveRow {...rowClick('theme', '/critter')}>
          <Text>
            <Text color={tok.textMuted}>{'  theme   '}</Text>
            <Text color={accent}>{critterLabel}</Text>
          </Text>
        </InteractiveRow>
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{'  dir     '}</Text>
          <Text color={tok.textPrimary}>{dir}</Text>
          {!deckPresent && branch ? (
            <Text>
              <Text color={tok.textMuted}>{'   ' + branchChip('')}</Text>
              <Text color={tok.textPrimary}>{branch}</Text>
            </Text>
          ) : null}
          {!deckPresent ? <Text color={tok.textMuted}> · {gitState}</Text> : null}
        </Text>
        {
}
        {!helmHome && !deckPresent ? (
          <InteractiveRow {...rowClick('fleet', '/fleet')}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  fleet   '}</Text>
            {agents > 0 ? (
              <Text color={tok.success}>{'● '.repeat(Math.min(agents, 3)).trim()} </Text>
            ) : (
              <Text color={tok.textMuted}>○ </Text>
            )}
            <Text color={tok.textSecondary}>{agents > 0 ? `${agents} agents` : 'no fleet'}</Text>
            <Text color={tok.textMuted}> · trace </Text>
            <Text color={tok.textSecondary}>{traceCount}</Text>
            <Text color={tok.textMuted}> · substrate </Text>
            <Text color={tok.textSecondary}>
              {substrate.data.active}/{substrate.data.total}
            </Text>
            <Text color={tok.textMuted}> · daemon </Text>
            <Text color={daemon.state === 'live' ? tok.success : tok.textMuted}>
              {daemon.state === 'live' ? 'on' : 'off'}
            </Text>
          </Text>
          </InteractiveRow>
        ) : null}
        {
}
        {projectScopeEmpty && isProjectCwd ? (
          <InteractiveRow {...rowClick('init-signpost', '/init')}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  no MERCURY.md here · '}</Text>
              <Text color={tok.info}>/init</Text>
              <Text color={tok.textMuted}> studies the repo and writes it</Text>
            </Text>
          </InteractiveRow>
        ) : null}
      </Box>

      {
}
      {
}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={accent}>❯ </Text>
          <Text color={tok.textPrimary}>↵</Text>
          <Text color={tok.textSecondary}> sends</Text>
          {
}
          <Text color={tok.textMuted}>{'  ·  /workflows /teammates /saturn /health /cockpit /trace'}</Text>
        </Text>
      </Box>
    </Box>
  )
}
