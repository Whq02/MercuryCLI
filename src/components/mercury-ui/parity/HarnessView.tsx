import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from '../components.js'
import { GLYPH, padTo, truncateToWidth } from '../glyphs.js'
import { CursorCell } from '../LiveGlyphs.js'
import { useSessionAccent } from '../sessionAccent.js'
import { InteractiveRow } from '../InteractiveRow.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { useMainLoopModel } from '../../../hooks/useMainLoopModel.js'
import {
  harnessEffortFact,
  harnessProfileArmed,
  harnessSessionPin,
  resolveActiveHarnessProfile,
  setHarnessSessionPin,
} from '../../../services/mission/harnessApplication.js'
import { useAppState } from '../../../state/AppState.js'
import { harnessProfileById } from '../../../services/mission/harnessProfiles.js'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'

// ============================================================================
//  HarnessView — the /harness drill-in: ONE operator
//  contract for the harness profile — inspect (identity · origin · reason ·
//  axes · declined trail) · pin for this session · persist a default ·
//  reset to the measured selection. Armed-only surface: while
//  MERCURY_HARNESS_PROFILE is off the panel states exactly that and touches
//  nothing (the resolver is never invoked — the CH-41 certificate). Pins
//  never fabricate: an invalid/incompatible pin falls through at the
//  resolver with a NAMED reason and this panel projects the fallthrough.
// ============================================================================

type ActionRow = {
  id: string
  label: string
  desc: string
  run: () => string
}

export function HarnessView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const armed = harnessProfileArmed()
  const mainModel = useMainLoopModel()
  // Version tick: pin actions mutate module/config state React cannot see;
  // bump to re-derive the resolution after each action (the module-state
  // toggle law — no polling, the action IS the invalidation).
  const [tick, setTick] = React.useState(0)
  void tick
  // The effort fact from the one owner (the profiles' effort axis judges
  // the tier the request carries for the main model).
  const effortValue = useAppState(s => s.effortValue)
  const resolution = armed
    ? resolveActiveHarnessProfile({ model: mainModel, effortLevel: harnessEffortFact(mainModel, effortValue) })
    : null
  const active = resolution ? harnessProfileById(resolution.profileId) : null
  const sessionPin = armed ? harnessSessionPin() : null
  const persistedPin = armed ? ((getGlobalConfig().harnessProfilePin ?? '').trim() || null) : null

  const rows: ActionRow[] = !armed || !resolution
    ? []
    : [
        sessionPin === resolution.profileId
          ? {
              id: 'clear-session-pin',
              label: 'clear session pin',
              desc: 'drop the session pin — the selector decides again',
              run: () => {
                setHarnessSessionPin(null)
                setTick(t => t + 1)
                return 'session pin cleared — back to the measured selection'
              },
            }
          : {
              id: 'pin-session',
              label: 'pin for this session',
              desc: `hold ${resolution.profileId} until this session ends`,
              run: () => {
                setHarnessSessionPin(resolution.profileId)
                setTick(t => t + 1)
                return `session pin → ${resolution.profileId}`
              },
            },
        persistedPin === resolution.profileId
          ? {
              id: 'clear-persisted-pin',
              label: 'clear persisted default',
              desc: 'remove the durable operator pin (config harnessProfilePin)',
              run: () => {
                saveGlobalConfig(cfg => ({ ...cfg, harnessProfilePin: undefined }))
                setTick(t => t + 1)
                return 'persisted pin cleared'
              },
            }
          : {
              id: 'persist-pin',
              label: 'persist as default',
              desc: `save ${resolution.profileId} as the durable operator pin`,
              run: () => {
                saveGlobalConfig(cfg => ({ ...cfg, harnessProfilePin: resolution.profileId }))
                setTick(t => t + 1)
                return `persisted pin → ${resolution.profileId} (config harnessProfilePin)`
              },
            },
        {
          id: 'reset',
          label: 'reset to measured selection',
          desc: 'clear BOTH pins — the resolver decides from facts + evidence',
          run: () => {
            setHarnessSessionPin(null)
            saveGlobalConfig(cfg => ({ ...cfg, harnessProfilePin: undefined }))
            setTick(t => t + 1)
            return 'pins cleared — the selector owns the choice again'
          },
        },
      ]

  const { selectedIndex: sel, note, hints, rowProps } = useInteractiveList({
    rows,
    rowId: row => row.id,
    idNamespace: 'harness',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'apply',
        run: row => (row ? row.run() : 'no actions'),
      },
    ],
  })

  return (
    <CommandCenter view="harness" onClose={onClose} captureInput={false} footer={hints}>
      {!armed ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <StateBadge state="off" label="harness profiles off" />
            <Text color={FAINT}> · the resolver is never invoked while off (byte-identical)</Text>
          </Text>
          <Text color={FAINT}>
            arm with MERCURY_HARNESS_PROFILE=on — accepted defaults stay byte-identical; behaviour changes only through measured, promoted candidates
          </Text>
        </Box>
      ) : !resolution || !active ? (
        <Box marginTop={1}>
          <Text color={FAINT}>no harness resolution for the current model</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <StateBadge state="live" label={`harness profile ${resolution.profileId}`} />
            <Text color={FAINT}> · {resolution.origin} · {resolution.reasonCodes[0]}</Text>
          </Text>
          <Text color={FAINT}>
            {resolution.profileDigest} · v{active.version} · {active.status} · rollback → {active.rollbackProfileId} · epoch {truncateToWidth(resolution.evidenceEpoch, 20)}
          </Text>

          <SectionHeader>Axes — accepted default = today's behaviour</SectionHeader>
          <Text color={FAINT}>context {active.axes.context.selectionPolicy}/{active.axes.context.allocationBand} · tools {active.axes.toolPresentation.catalogue}/{active.axes.toolPresentation.parallelCalls} · editing {active.axes.editingPosture.preference}</Text>
          <Text color={FAINT}>verify {active.axes.verificationPosture.focusedCadence}/{active.axes.verificationPosture.reviewerBand} · delegation {active.axes.delegationTopology.supportedExecution.join('+')} ≤{active.axes.delegationTopology.maxConcurrentLanes} · turns {active.axes.turnRecovery.timeoutClass}/{active.axes.turnRecovery.heartbeat}</Text>

          {resolution.declined.length > 0 ? (
            <>
              <SectionHeader count={resolution.declined.length}>Considered and declined</SectionHeader>
              {resolution.declined.slice(0, 4).map(d => (
                <Text key={d.profileId + d.reason} color={FAINT}>
                  {d.profileId} → {d.reason}
                </Text>
              ))}
            </>
          ) : null}

          <SectionHeader count={rows.length}>Pins</SectionHeader>
          <Text color={FAINT}>session {sessionPin ?? 'none'} · persisted {persistedPin ?? 'none'} · ↵ apply</Text>
          {rows.map((row, i) => (
            <InteractiveRow key={row.id} {...rowProps(row, i)}>
              <Text>
                <CursorCell focused={i === sel} color={accent} />
                <Text color={i === sel ? IVORY : SECOND}>{padTo(row.label, 26)}</Text>
                <Text color={FAINT}>{truncateToWidth(row.desc, 44)}</Text>
              </Text>
            </InteractiveRow>
          ))}

          {note ? (
            <Box marginTop={1}>
              <Text color={AMBER}>{truncateToWidth(note, 72)}</Text>
            </Box>
          ) : null}
          <Text color={TEAL}>{GLYPH.circledDash} the invariant floor is outside harness-profile control</Text>
        </Box>
      )}
    </CommandCenter>
  )
}
