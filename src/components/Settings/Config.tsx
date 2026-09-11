
import figures from 'figures'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { enqueueNotification } from '../../context/notifications.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  getGlobalConfig,
  saveGlobalConfig,
  getCustomApiKeyStatus,
  type GlobalConfig,
  type NotificationChannel,
} from '../../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
  getInitialSettings,
} from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import {
  clearInstructionFileCaches,
} from '../../services/instructions/engine.js'
import {
  setSessionInstructionProfile,
  isInstructionProfile,
} from '../../services/instructions/profile.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import inkInstances from '../../ink/instances.js'
import { stripFacts } from '../../context/surfaceRoute.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EXTERNAL_PERMISSION_MODES,
  permissionModeTitle,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import { getMainLoopModel, modelDisplayString } from '../../utils/model/model.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { customPatienceSetting, patienceEnvPins, patienceOf, patienceWords } from '../../services/providers/patience.js'
import {
  ENGINE_SESSION_CEILING_DEFAULT,
  endEngineSession,
  engineSessionCeilingPinned,
  resetShellEngineResolution,
  resolveEngineSessionCeiling,
  resolveShellEngine,
} from '../../utils/shell/engineSession.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../../services/providers/providerUsage.js'
import { REACHABLE_THEME_SETTINGS } from '../../utils/theme.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import { useTabHeaderFocus, useTabsWidth } from '../design-system/Tabs.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { SearchBox } from '../SearchBox.js'
import { Select } from '../CustomSelect/select.js'
import { LanguagePicker } from '../LanguagePicker.js'
import { ExternalInstructionIncludesDialog } from '../ExternalInstructionIncludesDialog.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { clearCliTeammateModeOverride } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { SEAT_DOORS, seatCeilingFactsAsync, seatCeilingValueWords, seatCostWarning, setOperatorSeats, type SeatCeilingFacts } from '../../services/switchboard/capacityCheck.js'
import { MOTION_DOORS, MOTION_SETTINGS, motionDetailLines, motionValueWords, noteMotionSettingChanged, readMotionSetting, setMotionSetting } from '../../utils/cockpit/motionSetting.js'
import { subagentDefaultsOf } from '../../utils/agentDefaults.js'
import { agentFanoutCap } from '../../constants/subagentDoctrine.js'
import { EFFORT_LEVELS } from '../../utils/effort.js'
import { AGENT_DISPATCH_MODELS } from '../../utils/model/aliases.js'

const LABEL_CELLS = 44

type SubMenu =
  | 'theme'
  | 'teammate-model'
  | 'external-includes'
  | 'language'

type ItemKind = 'boolean' | 'enum' | 'managed-enum' | 'info'

type SettingsItem = {
  id: string
  label: string
  searchText?: string
  kind: ItemKind
  value: React.ReactNode
  change?: (direction: 1 | -1) => void
  open?: SubMenu
  warning?: string
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  auto: 'auto (pick per terminal)',
  iterm2: 'iTerm2 (OSC 9)',
  iterm2_with_bell: 'iTerm2 (OSC 9) + bell (BEL)',
  terminal_bell: 'terminal bell (BEL)',
  kitty: 'kitty (OSC 99)',
  ghostty: 'Ghostty (OSC 777)',
  notifications_disabled: 'disabled',
}

const THEME_LABELS: Record<string, string> = {
  auto: 'auto (match terminal)',
  dark: 'Dark',
  'true-black': 'True Black',
  light: 'Light',
  'dark-daltonized': 'Dark (colourblind-friendly)',
  'light-daltonized': 'Light (colourblind-friendly)',
  'dark-ansi': 'Dark (ANSI only)',
  'light-ansi': 'Light (ANSI only)',
}


const CONFIG_PROVIDER_PRESENTATION: Record<
  string,
  { label: string; absent: string; manage?: string }
> = {
  anthropic: { label: 'Anthropic', absent: 'not signed in — /logins connects', manage: '/accounts' },
  openai: { label: 'OpenAI', absent: 'not signed in — /logins connects', manage: '/accounts' },
  zai: { label: 'Z.AI', absent: 'no key — /logins zai connects (or ZAI_API_KEY)', manage: '/accounts' },
  openrouter: { label: 'OpenRouter', absent: 'not signed in — /logins connects', manage: '/accounts' },
  gemini: { label: 'Gemini', absent: 'not signed in — /logins connects', manage: '/accounts' },
  moonshot: { label: 'Moonshot', absent: 'not signed in — /logins moonshot connects (or MOONSHOT_API_KEY)', manage: '/accounts' },
  deepseek: { label: 'DeepSeek', absent: 'no key — /logins deepseek connects (or DEEPSEEK_API_KEY)', manage: '/accounts' },
  'openai-compat': { label: 'Custom endpoint', absent: 'not configured — MERCURY_COMPAT_BASE_URL' },
  huggingface: { label: 'Hugging Face', absent: 'not signed in — /logins connects (or HF_TOKEN)', manage: '/accounts' },
  local: { label: 'Local', absent: 'no sign-in — start a local server or MERCURY_LOCAL_BASE_URL' },
}


export function configRowApplicability(
  appliesTo: 'anthropic',
  route: string,
): { applies: true } | { applies: false; naText: string; refuseNote: string } {
  if (route === appliesTo) return { applies: true }
  const laneLabel = CONFIG_PROVIDER_PRESENTATION[appliesTo]?.label ?? appliesTo
  const activeLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  return {
    applies: false,
    naText: `n/a — applies to ${laneLabel} models (${activeLabel} is active)`,
    refuseNote: `This setting only affects the ${laneLabel} lane; the session runs on ${activeLabel} — /model switches provider.`,
  }
}

export function mainLoopPointerText(
  effective: string | null,
  reads?: { resolvedModel?: () => string; routeOf?: (model: string) => string },
): string {
  const resolved = reads?.resolvedModel?.() ?? getMainLoopModel()
  const model = effective ?? resolved
  const route = reads?.routeOf?.(model) ?? declaredRouteOf(model) ?? 'unrecognised'
  const providerLabel = CONFIG_PROVIDER_PRESENTATION[route]?.label ?? route
  const modelText =
    effective !== null ? modelDisplayString(effective) : `default (${modelDisplayString(resolved)})`
  return `${providerLabel} · ${modelText} — /model`
}

export interface ConfigProviderRow {
  id: string
  label: string
  valueText: string
  credentialed: boolean
}

export function configProviderRows(families: ProviderFamilyPresence[]): ConfigProviderRow[] {
  return families
    .map(family => {
      const meta = CONFIG_PROVIDER_PRESENTATION[family.id] ?? {
        label: family.id,
        absent: 'not connected — see /capabilities',
      }
      return {
        id: `account-${family.id}`,
        label: `${meta.label} account`,
        valueText: family.credentialed
          ? `${family.credentialLabel}${meta.manage ? ` — ${meta.manage}` : ''}`
          : meta.absent,
        credentialed: family.credentialed,
      }
    })
}

function cycleIn<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const at = list.indexOf(current)
  const base = at < 0 ? 0 : at
  return list[(base + direction + list.length) % list.length] as T
}

const SESSION_CEILING_LADDER: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32]
function nextSessionCeiling(current: number, direction: 1 | -1): number {
  if (direction === 1) return SESSION_CEILING_LADDER.find(rung => rung > current) ?? (SESSION_CEILING_LADDER[0] as number)
  for (let i = SESSION_CEILING_LADDER.length - 1; i >= 0; i--) {
    const rung = SESSION_CEILING_LADDER[i] as number
    if (rung < current) return rung
  }
  return SESSION_CEILING_LADDER[SESSION_CEILING_LADDER.length - 1] as number
}

function validated<T extends string>(
  list: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: {
  onClose: (result?: unknown) => void
  context: LocalJSXCommandContext
  setTabsHidden: (hidden: boolean) => void
  onIsSearchModeChange?: (ownsEscape: boolean) => void
  contentHeight?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const appState = useAppState((s: AppState) => s)
  const [themeName, setThemeSetting] = useTheme()
  const themeSetting = useThemeSetting()
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const tabsWidth = useTabsWidth()

  const [version, setVersion] = useState(0)
  const bump = (): void => setVersion(v => v + 1)
  void version
  const config = getGlobalConfig()
  const merged = getInitialSettings() as SettingsJson

  const snapshotsRef = useRef<{
    global: GlobalConfig
    theme: string
    local: Partial<SettingsJson>
    user: Partial<SettingsJson>
    appVerbose: boolean
    dirty: boolean
  } | null>(null)
  if (snapshotsRef.current === null) {
    const local = getSettingsForSource('localSettings') ?? {}
    const user = getSettingsForSource('userSettings') ?? {}
    snapshotsRef.current = {
      global: JSON.parse(JSON.stringify(getGlobalConfig())) as GlobalConfig,
      theme: themeSetting,
      local: {
        spinnerTipsEnabled: local.spinnerTipsEnabled,
        prefersReducedMotion: local.prefersReducedMotion,
        instructionProfile: local.instructionProfile,
        shellEngine: local.shellEngine,
      },
      user: {
        alwaysThinkingEnabled: user.alwaysThinkingEnabled,
        promptSuggestionEnabled: user.promptSuggestionEnabled,
        language: user.language,
        syntaxHighlightingDisabled: user.syntaxHighlightingDisabled,
        permissions: user.permissions,
        patience: user.patience,
      },
      appVerbose: appState.verbose === true,
      dirty: false,
    }
  }
  const snapshots = snapshotsRef.current

  const changesRef = useRef(new Map<string, string>())
  const recordToggle = (key: string, text: string): void => {
    snapshots.dirty = true
    if (changesRef.current.has(key)) changesRef.current.delete(key)
    else changesRef.current.set(key, text)
  }
  const recordSet = (key: string, text: string): void => {
    snapshots.dirty = true
    changesRef.current.delete(key)
    changesRef.current.set(key, text)
  }

  const writeSource = (
    source: 'localSettings' | 'userSettings',
    partial: Partial<SettingsJson>,
  ): boolean => {
    const { error } = updateSettingsForSource(source, partial)
    if (error !== null) {
      logForDebugging(`settings write failed (${source}): ${error.message}`)
      enqueueNotification(setAppState, {
        key: 'config-write-failed',
        text: `that change did not save — ${source === 'localSettings' ? 'project-local' : 'user'} settings write failed: ${error.message}`,
        priority: 'high',
        color: 'error',
        timeoutMs: 15_000,
      })
      return false
    }
    return true
  }
  const globalTouchedRef = useRef(new Set<string>())
  const writeGlobal = (mutate: (config: GlobalConfig) => GlobalConfig): void => {
    const before = getGlobalConfig()
    const after = mutate(before)
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.is((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key])) {
        globalTouchedRef.current.add(key)
      }
    }
    saveGlobalConfig(mutate)
    snapshots.dirty = true
    bump()
  }

  const [subMenu, setSubMenu] = useState<SubMenu | null>(null)
  useEffect(() => {
    setTabsHidden(subMenu !== null)
  }, [subMenu, setTabsHidden])
  const [thinkingWarning, setThinkingWarning] = useState(false)

  const conversationHasAssistantTurn = context.messages.some(
    message => message.type === 'assistant',
  )
  const ideConnected =
    appState.mcp.clients.some(
      client =>
        (client as { name?: string; type?: string }).name === 'ide' &&
        (client as { connected?: boolean; type?: string }).type === 'connected',
    )
  const thinkingOn = merged.alwaysThinkingEnabled === true
  const permissions = merged.permissions ?? {}
  const defaultMode = validated(
    EXTERNAL_PERMISSION_MODES,
    permissions.defaultMode,
    'default',
  )
  const modeOptions: readonly ExternalPermissionMode[] = [
    'default',
    'strategy',
    ...EXTERNAL_PERMISSION_MODES.filter(
      mode => mode !== 'default' && mode !== 'strategy' && mode !== 'sovereign',
    ),
  ]

  const boolValue = (on: boolean): React.ReactNode => (
    <Text color={on ? tokens.success : tokens.textSecondary}>
      {on ? 'on' : 'off'}
    </Text>
  )

  const servedModel = useFocusedServedModel()
  const mainRoute = declaredRouteOf(
    servedModel ?? appState.mainLoopModelForSession ?? appState.mainLoopModel ?? getMainLoopModel(),
  )
  const providerScoped = (item: SettingsItem, appliesTo: 'anthropic'): SettingsItem => {
    const applicability = configRowApplicability(appliesTo, mainRoute ?? 'unrecognised')
    if (applicability.applies) return item
    return {
      ...item,
      value: <Text color={tokens.textSecondary}>{applicability.naText}</Text>,
      warning: applicability.refuseNote,
      change: () => {},
    }
  }

  const items: SettingsItem[] = []

  items.push({
    id: 'autoCompact',
    label: 'Auto-compact',
    kind: 'boolean',
    value: boolValue(config.autoCompactEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, autoCompactEnabled: c.autoCompactEnabled === false }))
      recordToggle('autoCompact', `set auto-compact to ${config.autoCompactEnabled === false ? 'on' : 'off'}`)
    },
  })
  const world = stripFacts()
  items.push({
    id: 'concourse',
    label: 'Session concourse',
    searchText: 'session concourse coordinator live view concourse-off chat plain world',
    kind: 'boolean',
    value: world.chatBoot ? (
      <Text>
        {boolValue(config.concourseEnabled !== false)}
        <Text color={tokens.textSecondary}> · off this boot (--chat)</Text>
      </Text>
    ) : (
      boolValue(config.concourseEnabled !== false)
    ),
    ...(world.chatBoot
      ? { warning: 'this boot is --chat: the plain world whatever the switch says — the switch governs the next plain `mercury` boot' }
      : {}),
    change: () => {
      const next = config.concourseEnabled === false
      writeGlobal(c => ({ ...c, concourseEnabled: next }))
      recordToggle('concourse', `set the session concourse to ${next ? 'on' : 'off (live view only)'}`)
    },
  })
  const [seatFacts, setSeatFacts] = useState<SeatCeilingFacts | null>(null)
  const configStamp = useSyncExternalStore(subscribeGlobalConfigCache, getGlobalConfigCacheStamp, getGlobalConfigCacheStamp)
  useEffect(() => {
    let active = true
    void seatCeilingFactsAsync().then(facts => { if (active) setSeatFacts(facts) })
    return () => { active = false }
  }, [version, configStamp])
  const seatWarning = seatFacts === null ? null : seatCostWarning(seatFacts)
  items.push({
    id: 'seats',
    label: 'Seats',
    searchText: 'seats seat ceiling capacity concurrency sessions sub-agents workflow agents in flight',
    kind: 'enum',
    value: <Text>{seatFacts === null ? 'reading capacity…' : seatCeilingValueWords(seatFacts)}</Text>,
    warning: seatFacts === null ? 'reading capacity…' : seatWarning !== null ? seatWarning : `a seat is one model call in flight; ${seatFacts.readingSentence} · ←/→ move the ceiling by one · doors: ${SEAT_DOORS}`,
    change: direction => {
      if (seatFacts === null) return
      const next = direction > 0 ? seatFacts.seats + 1 : Math.max(1, seatFacts.seats - 1)
      const after = setOperatorSeats(next)
      setSeatFacts(after)
      recordSet('seats', `set the seat ceiling to ${after.seats}`)
      bump()
    },
  })
  items.push({
    id: 'tips',
    label: 'Tips',
    kind: 'boolean',
    value: boolValue(merged.spinnerTipsEnabled !== false),
    change: () => {
      const next = merged.spinnerTipsEnabled === false
      if (writeSource('localSettings', { spinnerTipsEnabled: next ? undefined : false })) {
        snapshots.dirty = true
        recordToggle('tips', `set tips to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  items.push({
    id: 'reducedMotion',
    label: 'Reduced motion',
    kind: 'boolean',
    value: boolValue(merged.prefersReducedMotion === true),
    change: () => {
      const next = merged.prefersReducedMotion !== true
      if (writeSource('localSettings', { prefersReducedMotion: next ? true : undefined })) {
        snapshots.dirty = true
        recordToggle('reducedMotion', `set reduced motion to ${next ? 'on' : 'off'}`)
        bump()
      }
    },
  })
  {
    const motionSetting = readMotionSetting()
    items.push({
      id: 'motion',
      label: 'Motion',
      kind: 'enum',
      value: <Text>{motionValueWords(motionSetting)}</Text>,
      warning: `${motionDetailLines().slice(0, 2).join(' · ')} · auto = full until painting falls behind, then reduced · full never reduces · reduced slows the clock and stills the critter · off stops idle motion · doors: ${MOTION_DOORS}`,
      change: direction => {
        const next = cycleIn(MOTION_SETTINGS, motionSetting, direction)
        setMotionSetting(next)
        globalTouchedRef.current.add('motion')
        snapshots.dirty = true
        recordSet('motion', `set motion to ${next}`)
        bump()
      },
    })
  }
  items.push({
    id: 'instructionProfile',
    label: 'Instruction profile',
    kind: 'enum',
    value: <Text>{merged.instructionProfile ?? 'auto'}</Text>,
    change: direction => {
      const profiles = ['auto', 'native'] as const
      const current = validated(profiles, merged.instructionProfile, 'auto')
      const next = cycleIn(profiles, current, direction)
      if (writeSource('localSettings', { instructionProfile: next })) {
        snapshots.dirty = true
        setSessionInstructionProfile(next === 'auto' ? null : isInstructionProfile(next) ? next : null)
        clearInstructionFileCaches()
        recordSet('instructionProfile', `set instruction profile to ${next}`)
        bump()
      }
    },
  })
  {
    const engineSetting = validated(['system', 'brush'] as const, merged.shellEngine, 'system')
    const resolved = resolveShellEngine(engineSetting)
    const detail =
      engineSetting === 'brush' && resolved.engine !== 'brush'
        ? ' · unavailable, system shell in use'
        : resolved.engine === 'brush'
          ? ` · brush ${resolved.version}`
          : ''
    items.push({
      id: 'shellEngine',
      label: 'Shell engine',
      kind: 'enum',
      value: <Text>{engineSetting}{detail}</Text>,
      warning:
        engineSetting === 'brush' && resolved.engine !== 'brush'
          ? 'The vendored shell engine pack is not present in this build; the system shell runs instead.'
          : undefined,
      change: direction => {
        const engines = ['system', 'brush'] as const
        const next = cycleIn(engines, engineSetting, direction)
        if (writeSource('localSettings', { shellEngine: next === 'system' ? undefined : next })) {
          snapshots.dirty = true
          recordSet('shellEngine', `set shell engine to ${next}`)
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
        'the three waits while a provider is slow or silent: the stream-idle budget (2 min where keep-alives feed the watchdog; 15 min on the OpenAI road, silent while the model reasons), the non-streamed fallback ceiling and the retry budget · patient doubles every wait · custom writes the numbers to your user settings file to edit (patience: streamIdleSeconds · quietStreamIdleSeconds · fallbackCeilingSeconds · recoveryBudgetMinutes) · ←/→ walk the modes',
      change: direction => {
        const modes = ['normal', 'patient', 'custom'] as const
        const next = cycleIn(modes, patience.mode, direction)
        const value =
          next === 'normal' ? undefined : next === 'patient' ? 'patient' : customPatienceSetting(patience.numbers)
        if (writeSource('userSettings', { patience: value })) {
          snapshots.dirty = true
          recordSet('patience', `set patience with a quiet model to ${next}`)
          bump()
        }
      },
    })
  }
  {
    const ceiling = resolveEngineSessionCeiling(merged.shellEngineSessions)
    const pinned = engineSessionCeilingPinned()
    const share = ceiling === 1 ? 'no session for sub-agents' : `the conversation + ${ceiling - 1} sub-agent${ceiling === 2 ? '' : 's'}`
    items.push({
      id: 'shellEngineSessions',
      label: 'Shell engine sessions',
      kind: 'enum',
      value: <Text>{ceiling} · {share}{pinned ? ' · pinned by MERCURY_SHELL_ENGINE_SESSIONS' : ''}</Text>,
      warning: pinned
        ? 'The env pin MERCURY_SHELL_ENGINE_SESSIONS decides the ceiling for this process; a value written here applies once the pin is gone.'
        : ceiling === 1
          ? "A ceiling of 1 keeps the main conversation's session only: a sub-agent's engine call is refused with the reason (a run_in_background call still runs, in its own system shell)."
          : undefined,
      change: direction => {
        const next = nextSessionCeiling(merged.shellEngineSessions ?? ENGINE_SESSION_CEILING_DEFAULT, direction)
        if (writeSource('localSettings', { shellEngineSessions: next === ENGINE_SESSION_CEILING_DEFAULT ? undefined : next })) {
          snapshots.dirty = true
          recordSet('shellEngineSessions', `set shell engine sessions to ${next}`)
          bump()
        }
      },
    })
  }
  items.push(providerScoped({
    id: 'thinking',
    label: 'Thinking mode',
    kind: 'boolean',
    value: boolValue(thinkingOn),
    warning:
      thinkingWarning && conversationHasAssistantTurn
        ? 'Thinking raises latency and can reduce quality mid-conversation.'
        : undefined,
    change: () => {
      const next = !thinkingOn
      if (writeSource('userSettings', { alwaysThinkingEnabled: next ? undefined : false })) {
        snapshots.dirty = true
        recordToggle('thinking', `set thinking mode to ${next ? 'on' : 'off'}`)
        if (conversationHasAssistantTurn) {
          const initial = snapshots.user.alwaysThinkingEnabled === true
          setThinkingWarning(next !== initial)
        }
        bump()
      }
    },
  }, 'anthropic'))
  items.push({
    id: 'toolOutput',
    label: 'Tool output',
    kind: 'enum',
    value: <Text>{appState.verbose === true ? 'full' : 'compact'}</Text>,
    change: direction => {
      const levels = ['compact', 'full'] as const
      const next = cycleIn(levels, appState.verbose === true ? 'full' : 'compact', direction)
      snapshots.dirty = true
      setAppState(prev => ({ ...prev, verbose: next === 'full' }))
      recordToggle('toolOutput', `set tool output to ${next}`)
    },
  })
  items.push({
    id: 'terminalProgressBar',
    label: 'Terminal progress bar',
    kind: 'boolean',
    value: boolValue(config.terminalProgressBarEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, terminalProgressBarEnabled: c.terminalProgressBarEnabled === false }))
      recordToggle('terminalProgressBar', `set terminal progress bar to ${config.terminalProgressBarEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'turnDuration',
    label: 'Turn duration',
    kind: 'boolean',
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
    value: <Text>{permissionModeTitle(defaultMode)}</Text>,
    change: direction => {
      const next = cycleIn(modeOptions, defaultMode, direction)
      if (
        writeSource('userSettings', {
          permissions: { defaultMode: next },
        })
      ) {
        snapshots.dirty = true
        recordSet('defaultPermissionMode', `set default permission mode to ${permissionModeTitle(next)}`)
        bump()
      }
    },
  })
  items.push({
    id: 'respectGitignore',
    label: 'Respect .gitignore in file picker',
    kind: 'boolean',
    value: boolValue(config.respectGitignore !== false),
    change: () => {
      writeGlobal(c => ({ ...c, respectGitignore: c.respectGitignore === false }))
      recordToggle('respectGitignore', `set respect-gitignore to ${config.respectGitignore === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'copyFullResponse',
    label: 'Always copy full response',
    kind: 'boolean',
    value: boolValue(config.copyFullResponse === true),
    change: () => {
      writeGlobal(c => ({ ...c, copyFullResponse: c.copyFullResponse !== true }))
      recordToggle('copyFullResponse', `set always-copy-full-response to ${config.copyFullResponse !== true ? 'on' : 'off'}`)
    },
  })

  items.push({
    id: 'theme',
    label: 'Theme',
    kind: 'managed-enum',
    value: <Text>{THEME_LABELS[themeSetting] ?? themeSetting}</Text>,
    open: 'theme',
  })
  items.push({
    id: 'notifChannel',
    label: 'Notifications channel',
    kind: 'enum',
    value: (
      <Text>
        {CHANNEL_LABELS[
          validated([...NOTIFICATION_CHANNELS], config.preferredNotifChannel, 'auto')
        ]}
      </Text>
    ),
    change: direction => {
      const current = validated([...NOTIFICATION_CHANNELS], config.preferredNotifChannel, 'auto')
      const next = cycleIn({ options: [...NOTIFICATION_CHANNELS] }.options, current, direction)
      writeGlobal(c => ({ ...c, preferredNotifChannel: next }))
      recordSet('notifChannel', `set notifications channel to ${next}`)
    },
  })
  items.push({
    id: 'pingsBell',
    label: 'Pings bell',
    kind: 'boolean',
    value: boolValue(config.pingsBell !== false),
    change: () => {
      const next = config.pingsBell === false
      writeGlobal(c => ({ ...c, pingsBell: next }))
      recordToggle('pingsBell', `set pings bell to ${next ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'language',
    label: 'Language',
    kind: 'managed-enum',
    value: <Text>{merged.language ?? 'auto'}</Text>,
    open: 'language',
  })
  items.push({
    id: 'editorMode',
    label: 'Editor mode',
    kind: 'enum',
    value: <Text>{validated(EDITOR_MODES, config.editorMode, 'normal')}</Text>,
    change: direction => {
      const current = validated(EDITOR_MODES, config.editorMode, 'normal')
      const next = cycleIn(EDITOR_MODES, current, direction)
      writeGlobal(c => ({ ...c, editorMode: next }))
      recordSet('editorMode', `set editor mode to ${next}`)
    },
  })
  items.push({
    id: 'prStatusFooter',
    label: 'PR status footer',
    kind: 'boolean',
    value: boolValue(config.prStatusFooterEnabled !== false),
    change: () => {
      writeGlobal(c => ({ ...c, prStatusFooterEnabled: c.prStatusFooterEnabled === false }))
      recordToggle('prStatusFooter', `set PR status footer to ${config.prStatusFooterEnabled === false ? 'on' : 'off'}`)
    },
  })
  items.push({
    id: 'model',
    label: 'Model (main loop)',
    searchText: 'model provider main loop',
    kind: 'info',
    value: (
      <Text>
        {mainLoopPointerText(servedModel ?? appState.mainLoopModelForSession ?? appState.mainLoopModel)}
      </Text>
    ),
  })
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

  {
    items.push({
      id: 'fileCheckpointing',
      label: 'File checkpointing',
      kind: 'boolean',
      value: boolValue(config.fileCheckpointingEnabled !== false),
      change: () => {
        writeGlobal(c => ({ ...c, fileCheckpointingEnabled: c.fileCheckpointingEnabled === false }))
        recordToggle('fileCheckpointing', `set file checkpointing to ${config.fileCheckpointingEnabled === false ? 'on' : 'off'}`)
      },
    })
    const facts = getFocusedSessionConnector().checkpointFacts()
    const points = facts.restorable.size
    const sessionText = !hasFocusedSession()
      ? 'no chat open'
      : facts.capture === 'on'
        ? `capturing · ${points} restore point${points === 1 ? '' : 's'}`
        : facts.capture === 'off'
          ? 'not capturing in this session'
          : "not reported — this session's runner predates checkpoint capture (/daemon restart when ready)"
    items.push({
      id: 'fileCheckpointsSession',
      label: 'Checkpoints in this session',
      searchText: 'checkpoints session rewind restore points capture',
      kind: 'info',
      value: <Text color={facts.capture === 'on' ? tokens.success : tokens.textSecondary}>{sessionText}</Text>,
    })
  }
  if (isFullscreenActive()) {
    items.push({
      id: 'copyOnSelect',
      label: 'Copy on select',
      kind: 'boolean',
      value: boolValue(config.copyOnSelect !== false),
      change: () => {
        writeGlobal(c => ({ ...c, copyOnSelect: c.copyOnSelect === false }))
        recordToggle('copyOnSelect', `set copy-on-select to ${config.copyOnSelect === false ? 'on' : 'off'}`)
      },
    })
    items.push({
      id: 'mouseCapture',
      label: 'Mouse capture',
      kind: 'boolean',
      value: boolValue(config.mouseCapture !== false),
      change: () => {
        const next = config.mouseCapture === false
        writeGlobal(c => ({ ...c, mouseCapture: next }))
        inkInstances.get(process.stdout)?.setMouseTrackingEnabled(next)
        recordToggle('mouseCapture', `set mouse capture to ${next ? 'on' : 'off'}`)
      },
    })
  }
  if (ideConnected) {
    items.push({
      id: 'diffTool',
      label: 'Diff tool',
      kind: 'enum',
      value: <Text>{config.diffTool ?? 'auto'}</Text>,
      change: direction => {
        const tools = ['auto', 'terminal'] as const
        const current = validated(tools, config.diffTool, 'auto')
        const next = cycleIn(tools, current, direction)
        writeGlobal(c => ({ ...c, diffTool: next }))
        recordSet('diffTool', `set diff tool to ${next}`)
      },
    })
  }
  if (context.options.ideInstallationStatus === null) {
    items.push({
      id: 'autoConnectIde',
      label: 'Auto-connect to IDE',
      kind: 'boolean',
      value: boolValue(config.autoConnectIde === true),
      change: () => {
        writeGlobal(c => ({ ...c, autoConnectIde: c.autoConnectIde !== true }))
        recordToggle('autoConnectIde', `set auto-connect IDE to ${config.autoConnectIde !== true ? 'on' : 'off'}`)
      },
    })
  } else {
    items.push({
      id: 'autoInstallIdeExtension',
      label: 'Auto-install IDE extension',
      kind: 'boolean',
      value: boolValue(config.autoInstallIdeExtension !== false),
      change: () => {
        writeGlobal(c => ({ ...c, autoInstallIdeExtension: c.autoInstallIdeExtension === false }))
        recordToggle('autoInstallIdeExtension', `set auto-install IDE extension to ${config.autoInstallIdeExtension === false ? 'on' : 'off'}`)
      },
    })
  }
  if (isAgentSwarmsEnabled()) {
    const teammateModes = ['auto', 'tmux', 'in-process'] as const
    const teammateMode = validated(teammateModes, config.teammateMode, 'auto')
    items.push({
      id: 'teammateMode',
      label: 'Teammate mode',
      kind: 'enum',
      value: <Text>{teammateMode}</Text>,
      change: direction => {
        const next = cycleIn(teammateModes, teammateMode, direction)
        clearCliTeammateModeOverride(next)
        writeGlobal(c => ({ ...c, teammateMode: next }))
        recordSet('teammateMode', `set teammate mode to ${next}`)
      },
    })
    items.push({
      id: 'defaultTeammateModel',
      label: 'Default teammate model',
      kind: 'managed-enum',
      value: (
        <Text>
          {(() => {
            const value = config.teammateDefaultModel
            if (value === undefined) return 'default'
            if (value === null) return "leader's model"
            return modelDisplayString(value)
          })()}
        </Text>
      ),
      open: 'teammate-model',
    })
  }
  const externalIncludes = (
    appState as { externalIncludes?: ExternalInstructionInclude[] }
  ).externalIncludes
  if (Array.isArray(externalIncludes) && externalIncludes.length > 0) {
    items.push({
      id: 'externalIncludes',
      label: 'External-includes approval',
      kind: 'managed-enum',
      value: <Text>review</Text>,
      open: 'external-includes',
    })
  }
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== '') {
    const status = getCustomApiKeyStatus(process.env.ANTHROPIC_API_KEY)
    items.push(providerScoped({
      id: 'customApiKey',
      label: 'Use custom API key',
      kind: 'boolean',
      value: boolValue(status === 'approved'),
      change: () => {
        const key = process.env.ANTHROPIC_API_KEY as string
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

  const agentDefaults = subagentDefaultsOf(config.agents)
  const writeAgents = (patch: Partial<NonNullable<GlobalConfig['agents']>>): void => {
    writeGlobal(c => ({ ...c, agents: { ...c.agents, ...patch } }))
  }
  items.push({
    id: 'agentsDefaultEffort',
    label: 'Sub-agent default effort',
    searchText: 'sub-agent subagent agent default effort delegate workflow supercode',
    kind: 'enum',
    value: (
      <Text>
        {agentDefaults.effort}
        {agentDefaults.effortSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
      </Text>
    ),
    warning: 'the effort a spawned agent runs at when the call names none — never the session\'s own level, so supercode pins max on the lead alone · ←/→ walk the ladder',
    change: direction => {
      const next = cycleIn(EFFORT_LEVELS, agentDefaults.effort, direction)
      writeAgents({ defaultEffort: next })
      recordSet('agentsDefaultEffort', `set the sub-agent default effort to ${next}`)
    },
  })
  const agentModelChoices: readonly string[] = ['inherit', ...AGENT_DISPATCH_MODELS]
  const agentModelChoice = agentDefaults.model ?? 'inherit'
  items.push({
    id: 'agentsDefaultModel',
    label: 'Sub-agent default model',
    searchText: 'sub-agent subagent agent default model inherit parent',
    kind: 'enum',
    value: (
      <Text>
        {agentDefaults.model === undefined ? "inherit (the parent's model)" : modelDisplayString(agentDefaults.model)}
      </Text>
    ),
    warning: 'the model a spawned agent runs on when neither the call nor its definition names one · ←/→ walk the aliases; inherit follows the parent',
    change: direction => {
      const next = cycleIn(agentModelChoices, agentModelChoice, direction)
      writeAgents({ defaultModel: next === 'inherit' ? undefined : next })
      recordSet('agentsDefaultModel', `set the sub-agent default model to ${next === 'inherit' ? "inherit (the parent's model)" : next}`)
    },
  })
  const envFanoutCap = agentFanoutCap()
  items.push({
    id: 'agentsMaxConcurrent',
    label: 'Sub-agents at once',
    searchText: 'sub-agent subagent agents at once concurrent cap fan-out maximum',
    kind: 'enum',
    value: (
      <Text>
        {agentDefaults.maxConcurrent}
        {agentDefaults.maxConcurrentSource === 'convention' ? <Text color={tokens.textSecondary}> (default)</Text> : null}
        {envFanoutCap !== null ? (
          <Text color={tokens.textSecondary}> · MERCURY_AGENT_FANOUT_CAP={envFanoutCap} outranks it this boot</Text>
        ) : null}
      </Text>
    ),
    warning: 'how many Agent-tool sub-agents may run at once; a spawn past the cap is refused with the live count (workflows keep their own ceiling) · ←/→ move it by one',
    change: direction => {
      const next = Math.max(1, agentDefaults.maxConcurrent + direction)
      writeAgents({ maxConcurrent: next })
      recordSet('agentsMaxConcurrent', `set sub-agents at once to ${next}`)
    },
  })

  const [searchMode, setSearchMode] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [offset, setOffset] = useState(0)

  const filtered = useMemo(() => {
    if (query === '') return items
    const needle = query.toLowerCase()
    return items.filter(
      item =>
        item.id.toLowerCase().includes(needle) ||
        item.label.toLowerCase().includes(needle) ||
        (item.searchText ?? '').toLowerCase().includes(needle),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items rebuilt every render; the query is the real input
  }, [query, version, appState, themeSetting])

  const paneHeight = contentHeight ?? 20
  const windowSize = Math.max(5, paneHeight - 10)

  const reconcile = useCallback(
    (nextSelected: number, list: number): { sel: number; off: number } => {
      const sel = Math.max(0, Math.min(nextSelected, list - 1))
      let off = offset
      if (sel < off) off = sel
      if (sel >= off + windowSize) off = sel - windowSize + 1
      off = Math.max(0, Math.min(off, Math.max(0, list - windowSize)))
      return { sel, off }
    },
    [offset, windowSize],
  )
  useEffect(() => {
    const fixed = reconcile(selected, filtered.length)
    if (fixed.sel !== selected) setSelected(fixed.sel)
    if (fixed.off !== offset) setOffset(fixed.off)
  }, [filtered.length, reconcile, selected, offset])

  const moveTo = (next: number): void => {
    const fixed = reconcile(next, filtered.length)
    setSelected(fixed.sel)
    setOffset(fixed.off)
    setThinkingWarning(false)
  }

  const ownsEscape = searchMode && !headerFocused
  useEffect(() => {
    onIsSearchModeChange?.(ownsEscape)
  }, [ownsEscape, onIsSearchModeChange])

  const composeSummary = (): string | undefined => {
    const lines: string[] = [...changesRef.current.values()]
    const nowTheme = themeSetting
    if (nowTheme !== snapshots.theme) lines.push(`set theme to ${nowTheme}`)
    if (lines.length === 0) return undefined
    return lines.join('\n')
  }

  const saveAndClose = (): void => {
    const summary = composeSummary()
    onClose(summary)
  }

  const revertAndClose = (): void => {
    if (!snapshots.dirty) {
      onClose(undefined)
      return
    }
    setThemeSetting(snapshots.theme)
    if (globalTouchedRef.current.size > 0) {
      const motionTouched = globalTouchedRef.current.has('motion')
      saveGlobalConfig(current => {
        const restored = { ...current } as Record<string, unknown>
        const snap = snapshots.global as unknown as Record<string, unknown>
        for (const key of globalTouchedRef.current) {
          if (snap[key] === undefined) delete restored[key]
          else restored[key] = snap[key]
        }
        return restored as unknown as GlobalConfig
      })
      globalTouchedRef.current.clear()
      if (motionTouched) noteMotionSettingChanged()
    }
    writeSource('localSettings', {
      spinnerTipsEnabled: snapshots.local.spinnerTipsEnabled,
      prefersReducedMotion: snapshots.local.prefersReducedMotion,
      instructionProfile: snapshots.local.instructionProfile,
      shellEngine: snapshots.local.shellEngine,
    })
    writeSource('userSettings', {
      alwaysThinkingEnabled: snapshots.user.alwaysThinkingEnabled,
      promptSuggestionEnabled: snapshots.user.promptSuggestionEnabled,
      language: snapshots.user.language,
      syntaxHighlightingDisabled: snapshots.user.syntaxHighlightingDisabled,
      patience: snapshots.user.patience,
      permissions: { defaultMode: snapshots.user.permissions?.defaultMode } as never,
    })
    setAppState(prev => ({ ...prev, verbose: snapshots.appVerbose }))
    const restoredProfile = snapshots.local.instructionProfile
    setSessionInstructionProfile(
      isInstructionProfile(restoredProfile) ? restoredProfile : null,
    )
    clearInstructionFileCaches()
    onClose(undefined)
  }

  useInput(
    (input, key, event) => {
      if (subMenu !== null) return
      if (headerFocused) return
      if (searchMode) {
        if (key.escape) {
          event.stopImmediatePropagation()
          if (query !== '') setQuery('')
          else {
            setSearchMode(false)
            revertAndClose()
          }
          return
        }
        if (key.return || key.downArrow) {
          event.stopImmediatePropagation()
          setSearchMode(false)
          moveTo(0)
          return
        }
        if (key.backspace || key.delete) {
          event.stopImmediatePropagation()
          setQuery(q => q.slice(0, -1))
          return
        }
        if (
          input !== '' &&
          !key.ctrl &&
          !key.meta &&
          !key.tab &&
          input >= ' ' &&
          input.charCodeAt(0) !== 0x7f
        ) {
          event.stopImmediatePropagation()
          setQuery(q => q + input)
        }
        return
      }
      const item = filtered[selected]
      if (key.escape) {
        event.stopImmediatePropagation()
        revertAndClose()
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        saveAndClose()
        return
      }
      if (key.upArrow) {
        event.stopImmediatePropagation()
        if (selected === 0) setSearchMode(true)
        else moveTo(selected - 1)
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        if (item === undefined) return
        event.stopImmediatePropagation()
        const direction: 1 | -1 = key.leftArrow ? -1 : 1
        if (item.kind === 'managed-enum' && item.open !== undefined) {
          setSubMenu(item.open)
        } else {
          item.change?.(direction)
        }
        return
      }
      if (input === ' ') {
        event.stopImmediatePropagation()
        if (item?.kind === 'managed-enum' && item.open !== undefined) setSubMenu(item.open)
        else item?.change?.(1)
        return
      }
      if (input === '/') {
        event.stopImmediatePropagation()
        setSearchMode(true)
        return
      }
      if (
        input !== '' &&
        !key.ctrl &&
        !key.meta &&
        input >= ' ' &&
        input !== ' ' &&
        input.charCodeAt(0) !== 0x7f &&
        !['j', 'k'].includes(input)
      ) {
        event.stopImmediatePropagation()
        setSearchMode(true)
        setQuery(input)
        return
      }
      if (input === 'j') {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (input === 'k') {
        event.stopImmediatePropagation()
        if (selected > 0) moveTo(selected - 1)
      }
    },
    { isActive: subMenu === null },
  )

  if (subMenu === 'theme') {
    return (
      <Select
        options={REACHABLE_THEME_SETTINGS.map(setting => ({
          label: THEME_LABELS[setting] ?? setting,
          value: setting,
        }))}
        defaultValue={themeSetting}
        onChange={value => {
          setThemeSetting(value)
          snapshots.dirty = true
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'teammate-model') {
    const current = config.teammateDefaultModel
    return (
      <Select
        options={[
          { label: 'Default', value: '__default__' },
          { label: "Leader's model", value: '__leader__' },
        ]}
        defaultValue={current === null ? '__leader__' : '__default__'}
        onChange={value => {
          if (value === '__default__' && current === undefined) {
            setSubMenu(null)
            return
          }
          writeGlobal(c => ({
            ...c,
            teammateDefaultModel: value === '__leader__' ? null : undefined,
          }))
          recordSet(
            'teammateDefaultModel',
            `set default teammate model to ${value === '__leader__' ? "leader's model" : 'default'}`,
          )
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'language') {
    return (
      <LanguagePicker
        initialLanguage={merged.language}
        onComplete={language => {
          if (writeSource('userSettings', { language })) {
            snapshots.dirty = true
            recordSet('language', `set language to ${language ?? 'auto'}`)
          }
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'external-includes') {
    return (
      <ExternalInstructionIncludesDialog
        isStandaloneDialog={false}
        externalIncludes={externalIncludes}
        onDone={() => {
          setSubMenu(null)
        }}
      />
    )
  }

  const visible = filtered.slice(offset, offset + windowSize)
  const hiddenAbove = offset
  const hiddenBelow = Math.max(0, filtered.length - offset - windowSize)
  const width = tabsWidth

  return (
    <Box flexDirection="column" width={width}>
      <SearchBox
        query={query}
        isFocused={searchMode && !headerFocused}
        isTerminalFocused={true}
        cursorOffset={query.length}
        placeholder="Search settings…"
      />
      {hiddenAbove > 0 ? (
        <Text dimColor>↑ {hiddenAbove} more</Text>
      ) : null}
      {visible.map((item, index) => {
        const at = offset + index
        const isSelected = !searchMode && at === selected
        return (
          <Box key={item.id} flexDirection="column">
            <Box flexDirection="row">
              <Box width={LABEL_CELLS} flexShrink={0}>
                <Text
                  bold={isSelected}
                  color={isSelected ? tokens.textPrimary : tokens.textSecondary}
                  wrap="truncate-end"
                >
                  {isSelected ? `${figures.pointer} ` : '  '}
                  {item.label}
                </Text>
              </Box>
              {item.value}
            </Box>
            {isSelected && item.warning !== undefined ? (
              <Text color={tokens.warning}>{'  '}{item.warning}</Text>
            ) : null}
          </Box>
        )
      })}
      {hiddenBelow > 0 ? (
        <Text dimColor>↓ {hiddenBelow} more</Text>
      ) : null}
      {filtered.length === 0 ? (
        <Text dimColor>no settings match “{query}”</Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          <KeyboardShortcutHint shortcut="↑/↓" action="select" />
          {' · '}
          <KeyboardShortcutHint shortcut="←/→" action="change" />
          {' · '}
          <KeyboardShortcutHint shortcut="Enter" action="save" />
          {' · '}
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="esc"
            description="revert"
          />
        </Text>
      </Box>
    </Box>
  )
}
