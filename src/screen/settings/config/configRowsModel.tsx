import { Text } from '../../themedRenderer.js'
import type { AppState } from '../../app-state/AppState.js'
import { getCustomApiKeyStatus } from '../../../platform/settings/config.js'
import { getSettingsForSource } from '../../../platform/settings/settings.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import type { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import { providerFamilyPresences } from '../../../models/roads/providerUsage.js'
import { localRecordFor } from '../../../models/roads/local/localCatalogue.js'
import { localWindowSettingOf, nextLocalWindowSetting, writeLocalWindowSetting, localWindowSettingWords } from '../../../models/roads/local/localWindow.js'
import { HELPER_JOB_WORDS, helperChoiceWords, helperJobsWords, helperModelChoices, nextHelperModelSetting, readHelperModelSetting, readHelperModelState, writeHelperModelSetting } from '../../../models/roads/local/tensorfoldHelper.js'
import { localServerConfigItems, type LocalServerConfigState } from '../LocalServer.js'
import { advisorConfigItems } from '../Advisor.js'
import { swarmMasterEnabled } from '../../../crew/board/seam.js'
import { setAdvisorEnabled, setAdvisorMinutes } from '../../../models/advisor/advisorSettings.js'
import type { SettingsItem, ConfigRowKit } from './configItems.js'
import { mainLoopPointerText, localModelWindowRow, configProviderRows } from './configRowFacts.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function configModelRows({ config, merged, tokens, writeGlobal, writeSource, recordToggle, recordSet, bump, appState, servedModel, mainRoute, configStamp, localServer }: ConfigRowKit & {
  appState: AppState
  servedModel: string | null
  mainRoute: ReturnType<typeof declaredRouteOf>
  configStamp: number
  localServer: LocalServerConfigState
}): SettingsItem[] {
  const items: SettingsItem[] = []
  items.push({
    id: 'model',
    label: 'Model (main loop)',
    searchText: 'model provider main loop',
    kind: 'info',
    setByYou: merged.engine?.model !== undefined,
    value: (
      <Text>
        {mainLoopPointerText(servedModel ?? appState.engineModelForSession ?? appState.engineModel)}
      </Text>
    ),
  })
  const localMain = mainRoute === 'local' ? localRecordFor(servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel()) : undefined
  const localWindowRow = localModelWindowRow(localMain, mainRoute ?? 'unrecognised', configStamp)
  items.push({
    id: 'localModelWindow',
    label: 'Local model window',
    searchText: 'local model window context num_ctx ollama lm studio served window',
    kind: 'enum',
    value: <Text color={localWindowRow.overFit ? tokens.failureText : localWindowRow.tight ? tokens.warning : localWindowRow.applies ? undefined : tokens.textSecondary} wrap="truncate-end">{localWindowRow.valueText}</Text>,
    setByYou: localWindowRow.setByYou,
    warning: localWindowRow.note,
    change: direction => {
      if (localMain === undefined || !localWindowRow.applies) return
      const next = nextLocalWindowSetting(localWindowSettingOf(localMain), direction)
      writeLocalWindowSetting(localMain, next, writeGlobal)
      recordSet('localModelWindow', `set the local model window for ${localMain.id} to ${localWindowSettingWords(next)}`)
      bump()
    },
  })
  {
    const helper = readHelperModelSetting(config)
    const choices = helperModelChoices({ session: localMain ?? null })
    const chosen = choices.find(choice => choice.size === helper.size) ?? choices[0]!
    const on = helper.size !== 'off' && chosen.available
    const pending = on && helper.size !== 'session' && readHelperModelState().port === undefined
    items.push({
      id: 'helperModel',
      label: 'Helper model',
      searchText: 'helper model local small jobs titles summaries judge compaction tensorfold llama.cpp',
      kind: 'enum',
      value: <Text color={helper.size === 'off' ? tokens.textSecondary : chosen.available ? tokens.success : tokens.warning} wrap="truncate-end">{helperChoiceWords(chosen)}</Text>,
      warning: on ? `${pending ? `starts with the next small job · ${chosen.memory} · ` : ''}${helperJobsWords(helper.compaction)}` : `a local model for Mercury's own small jobs whatever the main model · ${choices.filter(choice => choice.size !== 'off').map(helperChoiceWords).join(' · ')}`,
      setByYou: helper.size !== 'off',
      change: direction => {
        const next = nextHelperModelSetting(helper.size, direction, choices)
        writeHelperModelSetting({ size: next }, writeGlobal)
        recordSet('helperModel', `set the helper model to ${choices.find(choice => choice.size === next)?.label ?? next}`)
        bump()
      },
    })
    items.push({
      id: 'helperModelCompaction',
      label: 'Helper model for compaction',
      searchText: 'helper model compaction opt-in small model can drop details',
      kind: 'boolean',
      value: <Text color={helper.compaction ? tokens.warning : tokens.textSecondary}>{helper.compaction ? `on · ${HELPER_JOB_WORDS.compactionReason}` : `off · ${HELPER_JOB_WORDS.compactionReason}`}</Text>,
      warning: on ? undefined : 'applies once a helper model is chosen',
      setByYou: helper.compaction,
      change: () => {
        writeHelperModelSetting({ compaction: !helper.compaction }, writeGlobal)
        recordToggle('helperModelCompaction', `set the helper model for compaction to ${helper.compaction ? 'off' : 'on'}`)
        bump()
      },
    })
  }
  for (const row of configProviderRows(providerFamilyPresences())) {
    items.push({
      id: row.id,
      label: row.label,
      searchText: `${row.label} provider signed in`,
      kind: 'info',
      value: (
        <Text color={row.credentialed ? tokens.success : tokens.textSecondary} wrap="truncate-end">
          {row.valueText}
        </Text>
      ),
    })
  }
  items.push(
    ...localServerConfigItems({
      state: localServer,
      nowMs: Date.now(),
      tokens,
      onSet: (id, value, words) => {
        if (writeSource('userSettings', { local: { server: { [id]: value } } })) {
          recordSet(`localServer.${id}`, words)
          bump()
        }
      },
    }),
  )
  {
    const enabled = swarmMasterEnabled()
    const saved = getSettingsForSource('userSettings')?.swarm
    items.push({
      id: 'swarm',
      label: 'Swarm',
      searchText: 'swarm live crew board',
      kind: 'boolean',
      value: <Text color={enabled ? tokens.success : tokens.textSecondary}>{enabled ? 'on · /swarm on enables a session' : 'off'}</Text>,
      warning: 'Share board messages with crewmates. /swarm on enables a session; /swarmchat shows its messages.',
      setByYou: saved?.enabled !== undefined,
      change: () => {
        if (writeSource('userSettings', { swarm: { enabled: !enabled } })) {
          recordToggle('swarm', `Swarm ${enabled ? 'off' : 'on'}`)
          bump()
        }
      },
    })
  }
  items.push(
    ...advisorConfigItems({
      tokens,
      onToggle: (next, words) => {
        setAdvisorEnabled(next, writeGlobal)
        recordToggle('advisor', words)
        bump()
      },
      onInterval: (next, words) => {
        setAdvisorMinutes(next, writeGlobal)
        recordSet('advisor.minutes', words)
        bump()
      },
    }),
  )
  return items
}

export function configApiKeyRows({ boolValue, writeGlobal, recordToggle, providerScoped }: ConfigRowKit & {
  providerScoped: (item: SettingsItem, appliesTo: 'anthropic' | 'openrouter') => SettingsItem
}): SettingsItem[] {
  const items: SettingsItem[] = []
  if (hostEnv().ANTHROPIC_API_KEY !== undefined && hostEnv().ANTHROPIC_API_KEY! !== '') {
    const status = getCustomApiKeyStatus(hostEnv().ANTHROPIC_API_KEY!)
    items.push(providerScoped({
      id: 'customApiKey',
      label: 'Use custom API key',
      kind: 'boolean',
      value: boolValue(status === 'approved'),
      change: () => {
        const key = hostEnv().ANTHROPIC_API_KEY as string
        const truncated = key.slice(-20)
        writeGlobal(c => {
          const approved = new Set(c.customApiKeyResponses?.approved ?? [])
          const rejected = new Set(c.customApiKeyResponses?.rejected ?? [])
          if (status === 'approved') {
            approved.delete(truncated)
            rejected.add(truncated)
          } else {
            rejected.delete(truncated)
            approved.add(truncated)
          }
          return {
            ...c,
            customApiKeyResponses: {
              approved: [...approved],
              rejected: [...rejected],
            },
          }
        })
        recordToggle('customApiKey', `set custom API key to ${status === 'approved' ? 'off' : 'on'}`)
      },
    }, 'anthropic'))
  }
  return items
}
