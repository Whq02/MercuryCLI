import React from 'react'
import { Text } from '../../themedRenderer.js'
import type { AppState } from '../../app-state/AppState.js'
import type { getEffectivePermissionMode } from '../../../platform/config/derived.js'
import { describeSessionPermissionMode } from '../../../permissions/rules/permissionSetup.js'
import { clearInstructionFileCaches } from '../../../sessions/instructions/instructionFiles.js'
import { setSessionInstructionProfile, isInstructionProfile } from '../../../sessions/instructions/profile.js'
import { type PERMISSION_MODES, permissionModeTitle } from '../../../permissions/rules/permissionMode.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { customPatienceSetting, patienceEnvPins, patienceOf, patienceWords } from '../../../models/roads/patience.js'
import { ENGINE_SESSION_CEILING_DEFAULT, endEngineSession, engineSessionCeilingPinned, resetShellEngineResolution, resolveEngineSessionCeiling, resolveShellEngine } from '../../../platform/shell/engineSession.js'
import { windowsBashAbsent } from '../../../platform/shell/windowsShellRoad.js'
import { type SettingsItem, cycleIn, nextSessionCeiling, validated, type ConfigRowKit } from './configItems.js'
import { thinkingRowApplicability } from './configRowFacts.js'
import type { ConfigUndo } from './configUndo.js'

export function configEngineRows({ config, merged, tokens, boolValue, writeGlobal, writeSource, recordToggle, recordSet, bump, appState, setAppState, servedModel, thinkingOn, thinkingWarning, setThinkingWarning, conversationHasAssistantTurn, initialThinking, undoRef, providerScoped, sessionModeDiffers, defaultMode, sessionMode, modeOptions }: ConfigRowKit & {
  appState: AppState
  setAppState: (updater: (prevState: AppState) => AppState) => void
  servedModel: string | null
  thinkingOn: boolean
  thinkingWarning: boolean
  setThinkingWarning: (on: boolean) => void
  conversationHasAssistantTurn: boolean
  initialThinking: React.RefObject<boolean>
  undoRef: React.RefObject<ConfigUndo[]>
  providerScoped: (item: SettingsItem, appliesTo: 'anthropic' | 'openrouter') => SettingsItem
  sessionModeDiffers: boolean
  defaultMode: (typeof PERMISSION_MODES)[number]
  sessionMode: ReturnType<typeof getEffectivePermissionMode>
  modeOptions: ReadonlyArray<(typeof PERMISSION_MODES)[number]>
}): SettingsItem[] {
  const items: SettingsItem[] = []
  items.push({
    id: 'briefs.profile',
    label: 'Instruction profile',
    kind: 'enum',
    setByYou: merged.briefs?.profile !== undefined,
    value: <Text>{merged.briefs?.profile ?? 'auto'}</Text>,
    change: direction => {
      const profiles = ['auto', 'native'] as const
      const current = validated(profiles, merged.briefs?.profile, 'auto')
      const next = cycleIn(profiles, current, direction)
      if (writeSource('localSettings', { briefs: { profile: next } })) {
        setSessionInstructionProfile(next === 'auto' ? null : isInstructionProfile(next) ? next : null)
        clearInstructionFileCaches()
        recordSet('briefs.profile', `set instruction profile to ${next}`)
        bump()
      }
    },
  })
  {
    const engineSetting = validated(['system', 'brush'] as const, merged.shell?.engine, 'system')
    const resolved = resolveShellEngine(engineSetting)
    const detail =
      engineSetting === 'brush' && resolved.engine !== 'brush'
        ? ' · unavailable, system shell in use'
        : resolved.engine === 'brush'
          ? ` · brush ${resolved.version}`
          : ''
    items.push({
      id: 'shell.engine',
      label: 'Shell engine',
      kind: 'enum',
      setByYou: merged.shell?.engine !== undefined,
      value: <Text>{engineSetting}{detail}</Text>,
      warning:
        engineSetting === 'brush' && resolved.engine !== 'brush'
          ? 'The vendored shell engine pack is not present in this build; the system shell runs instead.'
          : undefined,
      change: direction => {
        const engines = ['system', 'brush'] as const
        const next = cycleIn(engines, engineSetting, direction)
        if (writeSource('localSettings', { shell: { engine: next === 'system' ? undefined : next } })) {
          recordSet('shell.engine', `set shell engine to ${next}`)
          resetShellEngineResolution()
          void endEngineSession()
          bump()
        }
      },
    })
  }
  {
    const patience = patienceOf(merged.patience)
    const patiencePins = patienceEnvPins()
    items.push({
      id: 'patience',
      label: 'Patience with a quiet model',
      searchText: 'patience quiet model stream idle watchdog stuck silent fallback retry budget timeout wait slow link',
      kind: 'enum',
      setByYou: merged.patience !== undefined,
      value: (
        <Text>
          {patience.mode}
          <Text color={tokens.textSecondary}> · {patienceWords(patience.numbers)}</Text>
          {patiencePins.length > 0 ? (
            <Text color={tokens.textSecondary}> · {patiencePins.join(' ')} outranks it this boot</Text>
          ) : null}
        </Text>
      ),
      warning:
        'applies to every provider: stream idle (6 min with keep-alives; 15 min on quiet streams), the non-streamed fallback ceiling and the retry budget · patient doubles the waits, including the 30 s wait for a first body byte after headers · custom raises that first-byte wait in proportion to the idle budget and writes the numbers to your user settings file to edit (patience: streamIdleSeconds · quietStreamIdleSeconds · fallbackCeilingSeconds · recoveryBudgetMinutes) · ←/→ walk the modes',
      change: direction => {
        const modes = ['normal', 'patient', 'custom'] as const
        const next = cycleIn(modes, patience.mode, direction)
        const value =
          next === 'normal' ? undefined : next === 'patient' ? 'patient' : customPatienceSetting(patience.numbers)
        if (writeSource('userSettings', { patience: value })) {
          recordSet('patience', `set patience with a quiet model to ${next}`)
          bump()
        }
      },
    })
  }
  {
    const routing = merged.routing?.openrouter
    const collection = routing?.dataCollection ?? 'deny'
    const parameters = routing?.requireParameters ?? true
    const fallbacks = routing?.allowFallbacks ?? true
    const zdr = routing?.zeroDataRetention ?? false
    items.push(providerScoped({
      id: 'routing.openrouter',
      label: 'OpenRouter routing policy',
      searchText: 'openrouter routing policy privacy collection parameters fallbacks zero data retention zdr',
      kind: 'enum',
      setByYou: merged.routing?.openrouter !== undefined,
      value: <Text>{`${collection} · parameters ${parameters ? 'required' : 'optional'} · fallbacks ${fallbacks ? 'on' : 'off'} · ZDR ${zdr ? 'on' : 'off'}`}</Text>,
      warning: 'the endpoints OpenRouter may use · strict denies data collection, requires every parameter, turns fallbacks off and zero data retention on · balanced is on from the start: denies collection and requires parameters, with fallbacks on and ZDR off · open leaves routing to OpenRouter · a model with no matching endpoint refuses with the no-provider error; allow collection or relax parameters to widen the pool · ←/→ walk strict, balanced, open · edit routing.openrouter in your user settings for each switch: dataCollection, requireParameters, allowFallbacks, zeroDataRetention',
      change: direction => {
        const modes = ['strict', 'balanced', 'open'] as const
        const current = collection === 'allow' && !parameters && fallbacks && !zdr ? 'open' : collection === 'deny' && parameters && !fallbacks && zdr ? 'strict' : 'balanced'
        const next = cycleIn(modes, current, direction)
        const value = {
          dataCollection: next === 'open' ? 'allow' as const : 'deny' as const,
          requireParameters: next !== 'open',
          allowFallbacks: next !== 'strict',
          zeroDataRetention: next === 'strict',
        }
        if (writeSource('userSettings', { routing: { openrouter: value } })) {
          recordSet('routing.openrouter', `set OpenRouter routing policy to ${next}`)
          bump()
        }
      },
    }, 'openrouter'))
  }
  {
    const ceiling = resolveEngineSessionCeiling(merged.shell?.sessions)
    const pinned = engineSessionCeilingPinned()
    const share = ceiling === 1 ? 'no session for crewmates' : `the conversation + ${ceiling - 1} crewmate${ceiling === 2 ? '' : 's'}`
    items.push({
      id: 'shell.sessions',
      label: 'Shell engine sessions',
      kind: 'enum',
      setByYou: merged.shell?.sessions !== undefined,
      value: <Text>{ceiling} · {share}{pinned ? ' · pinned by MERCURY_SHELL_ENGINE_SESSIONS' : ''}</Text>,
      warning: pinned
        ? 'MERCURY_SHELL_ENGINE_SESSIONS decides the ceiling for this process; a value written here applies once that environment variable is unset.'
        : ceiling === 1
          ? `A ceiling of 1 keeps the main conversation's session only: a crewmate's engine call is refused with the reason (a run_in_background call still runs, in its own ${windowsBashAbsent() ? 'engine process' : 'system shell'}).`
          : undefined,
      change: direction => {
        const next = nextSessionCeiling(merged.shell?.sessions ?? ENGINE_SESSION_CEILING_DEFAULT, direction)
        if (writeSource('localSettings', { shell: { sessions: next === ENGINE_SESSION_CEILING_DEFAULT ? undefined : next } })) {
          recordSet('shell.sessions', `set shell engine sessions to ${next}`)
          bump()
        }
      },
    })
  }
  {
    const thinkingApplicability = thinkingRowApplicability(servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel())
    items.push({
      id: 'thinking',
      label: 'Thinking',
      searchText: 'thinking reasoning think reason extended',
      kind: 'boolean',
      setByYou: merged.engine?.reasoning !== undefined,
      value: thinkingApplicability.applies ? boolValue(thinkingOn) : <Text color={tokens.textSecondary}>{thinkingApplicability.naText}</Text>,
      warning:
        !thinkingApplicability.applies
          ? thinkingApplicability.refuseNote
          : thinkingWarning && conversationHasAssistantTurn
            ? 'Thinking raises latency and can reduce quality mid-conversation.'
            : 'the model reasons before it answers; on is the default · off asks the model not to — Sonnet 5.5 keeps thinking on at xhigh and max effort, Opus 5.5 at every effort · engine.reasoning in settings',
      change: () => {
        if (!thinkingApplicability.applies) return
        const next = !thinkingOn
        if (writeSource('userSettings', { engine: { reasoning: next ? undefined : false } })) {
          recordToggle('thinking', `set thinking to ${next ? 'on' : 'off'}`)
          if (conversationHasAssistantTurn) {
            const initial = initialThinking.current
            setThinkingWarning(next !== initial)
          }
          bump()
        }
      },
    })
  }
  items.push({
    id: 'usageNotice',
    label: 'Usage notice to the model',
    searchText: 'usage notice model told limit warning window spend 80 90 tokens awareness',
    kind: 'boolean',
    setByYou: merged.engine?.usageNotice !== undefined,
    value: boolValue(merged.engine?.usageNotice === true),
    warning: 'Tell the model at 80% and 90% of a usage window or spending limit. Your meters stay visible either way.',
    change: () => {
      const next = merged.engine?.usageNotice !== true
      if (writeSource('userSettings', { engine: { usageNotice: next ? true : undefined } })) {
        recordToggle('usageNotice', `set usage notice to the model to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'toolOutput',
    label: 'Tool output',
    kind: 'enum',
    setByYou: appState.verbose === true,
    value: <Text>{appState.verbose === true ? 'full' : 'compact'}</Text>,
    change: direction => {
      const levels = ['compact', 'full'] as const
      const next = cycleIn(levels, appState.verbose === true ? 'full' : 'compact', direction)
      undoRef.current.push({ source: 'app', path: ['verbose'], previous: appState.verbose })
      setAppState(prev => ({ ...prev, verbose: next === 'full' }))
      recordToggle('toolOutput', `set tool output to ${next}`)
    },
  })
  const progressPin = merged.activity?.progress
  const progressBarOn = config.terminalProgressBarEnabled !== false && progressPin !== false
  items.push({
    id: 'terminalProgressBar',
    label: 'Terminal progress bar',
    searchText: 'terminal progress bar tab ring activity.progress',
    kind: 'boolean',
    setByYou: config.terminalProgressBarEnabled === false || progressPin !== undefined,
    value: progressPin === undefined ? boolValue(progressBarOn) : (
      <Text>
        {boolValue(progressBarOn)}
        <Text color={tokens.textSecondary}> · activity.progress {String(progressPin)} in settings</Text>
      </Text>
    ),
    warning: 'the ring in the terminal tab while a turn runs · activity.progress in settings decides when set (false turns it off, true keeps it on where the terminal allows); otherwise this switch',
    change: () => {
      if (progressPin !== undefined) {
        if (writeSource('userSettings', { activity: { progress: progressPin ? false : undefined } })) {
          recordToggle('terminalProgressBar', `set activity.progress to ${progressPin ? 'false' : 'unset'}`)
          bump()
        }
        return
      }
      writeGlobal(c => ({ ...c, terminalProgressBarEnabled: c.terminalProgressBarEnabled === false }))
      recordToggle('terminalProgressBar', `set terminal progress bar to ${config.terminalProgressBarEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'turnDuration',
    label: 'Turn duration',
    kind: 'boolean',
    setByYou: config.showTurnDuration === false,
    value: boolValue(config.showTurnDuration !== false),
    change: () => {
      writeGlobal(c => ({ ...c, showTurnDuration: c.showTurnDuration === false }))
      recordToggle('turnDuration', `set turn duration to ${config.showTurnDuration === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'defaultPermissionMode',
    label: 'Default permission mode',
    kind: 'enum',
    setByYou: merged.guardrails?.mode !== undefined,
    value: sessionModeDiffers ? (
      <Text>
        {permissionModeTitle(defaultMode)}
        <Text color={tokens.textSecondary}> · this session: {permissionModeTitle(sessionMode.mode)}</Text>
      </Text>
    ) : (
      <Text>{permissionModeTitle(defaultMode)}</Text>
    ),
    warning: sessionModeDiffers ? `this session: ${describeSessionPermissionMode(sessionMode)}; the saved switch governs the next boot, never this one` : undefined,
    change: direction => {
      const next = cycleIn(modeOptions, defaultMode, direction)
      if (
        writeSource('userSettings', { guardrails: { mode: next } })
      ) {
        recordSet('defaultPermissionMode', `set default permission mode to ${permissionModeTitle(next)}`)
        bump()
      }
    },
  })
  return items
}
