import { pathTailLabel } from '../utils/pathLabel.js'
import * as React from 'react'
import { useContext, useEffect, useMemo, useState } from 'react'
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
import { SQUARE_DOCK_ART_LINES, critterDefForKey, squareDockArtFor } from '../utils/cockpit/critterData.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import { requestCommandDispatch } from '../utils/cockpit/helmFocus.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { BigWordmark, Sigil, Wordmark, wordmarkForm } from './mercury-ui/assets.js'
import { AnimatedCritterArt, BreathingDot } from './mercury-ui/AnimatedCritterArt.js'
import { MiniCritter } from './mercury-ui/MiniCritter.js'
import { cycleSessionCritter, useSessionAccent } from './mercury-ui/sessionAccent.js'
import { branchChip } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'


export function PinnedCritterBerth(): React.ReactNode {
  const tok = useMercuryTokens()
  const sa = useSessionAccent()
  const rawDef = critterDefForKey(sa.key)
  const dockDef = React.useMemo(
    () => ({ ...rawDef, hue: sa.accent, hueDeep: sa.accentDeep, square: squareDockArtFor(sa.key) }),
    [rawDef, sa.accent, sa.accentDeep, sa.key],
  )
  const hoverDockDef = React.useMemo(
    () => ({ ...dockDef, hue: tok.accentSoft }),
    [dockDef, tok.accentSoft],
  )
  return (
    <InteractiveRow
      id="berth:critter"
      width={Math.max(...dockDef.square.map(row => row.length))}
      directActivate
      onActivate={cycleSessionCritter}
      flexDirection="column"
      flexShrink={0}
    >
      {hover => (
        <Box flexDirection="column" flexShrink={0} justifyContent="center">
          {
}
          <Box height={SQUARE_DOCK_ART_LINES} flexDirection="column" justifyContent="flex-end">
            <AnimatedCritterArt def={hover ? hoverDockDef : dockDef} square />
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
  const { columns, rows } = useTerminalSize()
  if (isDeckPaneActive() || rows < 10 || columns < 40) return null
  return (
    <Box paddingX={1} marginTop={1} flexShrink={0} justifyContent="center">
      <MiniCritter />
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
