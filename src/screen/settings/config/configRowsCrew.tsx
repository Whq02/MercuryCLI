import { Text } from '../../themedRenderer.js'
import type { GlobalConfig } from '../../../platform/settings/config.js'
import { BACKGROUND_LAUNCH_DOORS, BACKGROUND_LAUNCH_KEY, BACKGROUND_LAUNCH_LABEL, BACKGROUND_LAUNCH_NOTE, BACKGROUND_LAUNCH_SUMMARY, backgroundLaunchValueWords, backgroundSessionsLaunchCrewmates, setBackgroundSessionsLaunchCrewmates } from '../../../daemon/switchboard/backgroundLaunch.js'
import type { crewmateDefaultsOf } from '../../../crew/agents/agentDefaults.js'
import { crewmateFanoutCap } from '../../../tools/crewmate/subagentDoctrine.js'
import { EFFORT_LEVELS } from '../../../models/effort/effort.js'
import { modelChoiceLabel } from '../../../commands/model/mercuryModel.js'
import { CREWMATE_INHERIT_ROW, type SettingsItem, cycleIn, type ConfigRowKit } from './configItems.js'

export function configCrewRows({ tokens, writeGlobal, recordToggle, recordSet, bump, agentDefaults, writeAgents }: ConfigRowKit & {
  agentDefaults: ReturnType<typeof crewmateDefaultsOf>
  writeAgents: (patch: Partial<NonNullable<GlobalConfig['agents']>>) => void
}): SettingsItem[] {
  const items: SettingsItem[] = []
  items.push({
    id: 'agentsDefaultEffort',
    label: 'Crewmate default effort',
    searchText: 'crewmate default effort delegate',
    kind: 'enum',
    setByYou: agentDefaults.effortSource === 'setting',
    value: (
      <Text>
        {agentDefaults.effort}
        {agentDefaults.effortSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
      </Text>
    ),
    warning: 'Used when a crewmate call names no effort; independent of the lead.',
    change: direction => {
      const next = cycleIn(EFFORT_LEVELS, agentDefaults.effort, direction)
      writeAgents({ defaultEffort: next })
      recordSet('agentsDefaultEffort', `set the crewmate default effort to ${next}`)
    },
  })
  items.push({
    id: 'agentsDefaultModel',
    label: 'Crewmate default model',
    searchText: 'crewmate default model inherit parent',
    kind: 'managed-enum',
    setByYou: agentDefaults.model !== undefined,
    value: (
      <Text>
        {agentDefaults.model === undefined || agentDefaults.model === CREWMATE_INHERIT_ROW.id ? CREWMATE_INHERIT_ROW.name : modelChoiceLabel(agentDefaults.model)}
      </Text>
    ),
    warning: 'Used when the call and agent definition name no model. Inherit uses the parent’s model.',
    open: 'agent-model',
  })
  const envFanoutCap = crewmateFanoutCap()
  items.push({
    id: 'agentsMaxConcurrent',
    label: 'Crewmates at once',
    searchText: 'crewmate crewmates at once concurrent cap fan-out maximum',
    kind: 'enum',
    setByYou: agentDefaults.maxConcurrentSource === 'setting',
    value: (
      <Text>
        {agentDefaults.maxConcurrent}
        {agentDefaults.maxConcurrentSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
        {envFanoutCap !== null ? (
          <Text color={tokens.textSecondary}> · MERCURY_AGENT_FANOUT_CAP={envFanoutCap} outranks it this boot</Text>
        ) : null}
      </Text>
    ),
    warning: 'Maximum simultaneous crewmates.',
    change: direction => {
      const next = Math.max(1, agentDefaults.maxConcurrent + direction)
      writeAgents({ maxConcurrent: next })
      recordSet('agentsMaxConcurrent', `set crewmates at once to ${next}`)
    },
  })
  const backgroundLaunchOn = backgroundSessionsLaunchCrewmates()
  items.push({
    id: BACKGROUND_LAUNCH_KEY,
    label: BACKGROUND_LAUNCH_LABEL,
    searchText: 'crewmate backgrounded background session launch delegate crewmates-allowed tag visit',
    kind: 'boolean',
    setByYou: backgroundLaunchOn,
    value: <Text color={backgroundLaunchOn ? tokens.success : tokens.textSecondary}>{backgroundLaunchValueWords(backgroundLaunchOn)}</Text>,
    warning: `${BACKGROUND_LAUNCH_SUMMARY} · ${BACKGROUND_LAUNCH_NOTE} · doors: ${BACKGROUND_LAUNCH_DOORS}`,
    change: () => {
      const next = !backgroundLaunchOn
      setBackgroundSessionsLaunchCrewmates(next, writeGlobal)
      recordToggle(BACKGROUND_LAUNCH_KEY, `set ${BACKGROUND_LAUNCH_LABEL.toLowerCase()} to ${backgroundLaunchValueWords(next)}`)
      bump()
    },
  })
  return items
}
